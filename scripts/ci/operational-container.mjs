import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readTrustedFile, verifySource } from './operational-files.mjs';
import { cleanEnvironment, sha256, fail, validateBrowserConfig, sealedCommand,
  assertSealed, SUITE_STAGES } from './operational-policy.mjs';
import { validateProvision, artifactName } from './operational-provision.mjs';
import { extractTgz, tgzEntries, zipEntries, writeEntries } from './operational-archives.mjs';
import { verifyStorage, verifyWorkspace, PRIVATE_ROOT, FRAMEWORK_TMP, PRODUCER_UID } from './operational-storage.mjs';
import { validateApproval, assertOperationalExecutionAllowed } from './operational-admission.mjs';
import { FINALIZER_EXIT } from './operational-receipt.mjs';
import { assertSandboxProcesses } from './operational-probe.mjs';

const source = '/work/repo';
export function assertImmutableRuntime(url, file) {
  if (url !== pathToFileURL(`/source/scripts/ci/${file}`).href ||
      process.execPath !== '/usr/local/bin/node' || process.platform !== 'linux') fail();
}
export async function loadApproval() {
  const bytes = await readTrustedFile('/approval', 'approval.json', 8 * 1024 * 1024);
  if (sha256(bytes) !== process.env.OPERATIONAL_APPROVAL_DIGEST) fail();
  const a = JSON.parse(bytes);
  validateApproval(a);
  return { a, bytes };
}
async function copySource(a) {
  const manifest = Buffer.from(JSON.stringify(a.source));
  await verifySource('/source', manifest, sha256(manifest));
  await mkdir(source, { mode: 0o700 });
  for (const file of a.source.files) {
    const path = join(source, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, await readTrustedFile('/source', file.path, file.size),
      { flag: 'wx', mode: file.mode === '100755' ? 0o755 : 0o644 });
  }
  await verifySource(source, manifest, sha256(manifest));
}
async function runChild(executable, args, env) {
  const child = spawn(executable, args, { cwd: source, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  let failure, checking;
  const kill = () => {
    if (!child.pid) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') failure ??= 'INCOMPLETE'; }
  };
  const watch = setInterval(() => {
    if (checking) return;
    checking = assertSandboxProcesses().catch(() => { failure ??= 'ADMISSION_BLOCKED'; kill(); })
      .finally(() => { checking = undefined; });
  }, 250);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', () => reject(new Error('INCOMPLETE')));
      child.once('close', (code, signal) => code === 0 && !signal ? resolve() : reject(new Error('TEST_FAILED')));
    });
  } catch (error) { failure ??= error.message; }
  finally { clearInterval(watch); await checking; kill(); }
  if (failure) fail(failure);
}
async function install(a) {
  const lockBytes = await readTrustedFile(source, 'package-lock.json', 8 * 1024 * 1024);
  if (sha256(lockBytes) !== a.lockDigest) fail();
  const lock = JSON.parse(lockBytes);
  validateProvision(a, lock);
  await verifyStorage(a);
  const npm = a.provision.artifacts.find(item => item.kind === 'npm');
  const npmBytes = await readTrustedFile('/provision', artifactName(npm), npm.size);
  if (sha256(npmBytes) !== npm.sha256) fail();
  await extractTgz(npmBytes, '/work/npm', npm.unpackedBytes);
  const npmCli = '/work/npm/package/bin/npm-cli.js';
  if (sha256(await readTrustedFile('/work/npm', 'package/bin/npm-cli.js', 1024 * 1024)) !== a.npmCliDigest) fail();
  const env = cleanEnvironment(a.candidateSha, { install: true });
  // The outer S05 capture owns the streams and aggregate deadline, including
  // package-cache population and every explicitly approved lifecycle.
  const execute = args => runChild(process.execPath, args, env);
  if (JSON.parse(await readTrustedFile('/work/npm', 'package/package.json', 1024 * 1024)).version !== '12.2.1') fail();
  for (const artifact of a.provision.artifacts.filter(item => item.kind === 'package')) {
    const bytes = await readTrustedFile('/provision', artifactName(artifact), artifact.size);
    if (sha256(bytes) !== artifact.sha256) fail();
    tgzEntries(bytes, artifact.unpackedBytes);
    await execute([npmCli, 'cache', 'add', `/provision/${artifactName(artifact)}`, '--offline', '--ignore-scripts']);
  }
  await execute([npmCli, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund']);
  await verifyWorkspace(a);
  for (const item of a.provision.lifecycles) {
    const bytes = await readTrustedFile(source, `${item.packagePath}/${item.script}`, 1024 * 1024);
    const pkg = JSON.parse(await readTrustedFile(source, `${item.packagePath}/package.json`, 1024 * 1024));
    if (sha256(bytes) !== item.scriptDigest || pkg.version !== item.version ||
        !['node install.js', 'node ./install.js'].includes(pkg.scripts?.postinstall)) fail();
    await execute([`${item.packagePath}/${item.script}`]);
  }
  for (const item of a.provision.artifacts.filter(item => item.kind === 'browser')) {
    const bytes = await readTrustedFile('/provision', artifactName(item), item.size);
    if (sha256(bytes) !== item.sha256) fail();
    await writeEntries(zipEntries(bytes, item.unpackedBytes), `/work/browsers/${item.target}`);
    await writeFile(`/work/browsers/${item.target}/INSTALLATION_COMPLETE`, '', { flag: 'wx' });
  }
  for (const [file, production] of [['playwright.operational-ci.config.ts', true],
    ['playwright.analytics-ci.config.ts', false]]) {
    validateBrowserConfig((await import(pathToFileURL(join(source, file)).href)).default, production);
  }
  await verifyWorkspace(a);
  const probeEnv = { ...cleanEnvironment(a.candidateSha), OPERATIONAL_NONCE: process.env.OPERATIONAL_NONCE,
    OPERATIONAL_HOST_NAMESPACE: process.env.OPERATIONAL_HOST_NAMESPACE };
  await runChild(process.execPath, ['/source/scripts/ci/operational-probe.mjs'], probeEnv);
}
export async function finalSource(a) {
  const bytes = Buffer.from(JSON.stringify(a.source));
  await verifySource(source, bytes, sha256(bytes), { generated: true });
}
export async function runContainer() {
  assertOperationalExecutionAllowed();
  assertImmutableRuntime(import.meta.url, 'operational-container.mjs');
  const mode = process.argv[2];
  if (process.argv.length !== (mode === 'stage' ? 4 : 3) ||
      process.getuid() !== PRODUCER_UID || process.getgid() !== PRODUCER_UID) fail();
  // The holder loads immutable code only: no approval, volume, source or report
  // reads before the host's producer-reap gate releases the collector.
  if (mode === 'hold') return hold();
  const { a } = await loadApproval();
  if (process.version !== 'v26.13.0' ||
      sha256(await readTrustedFile('/usr/local/bin', 'node', 256 * 1024 * 1024)) !== a.nodeDigest) fail();
  if (mode === 'keep') return hold();
  if (mode === 'source') {
    await verifyStorage(a);
    await mkdir(PRIVATE_ROOT, { mode: 0o700 });
    await mkdir(FRAMEWORK_TMP, { mode: 0o700 });
    await mkdir('/work/cache', { mode: 0o700 });
    return copySource(a);
  }
  if (mode === 'install') return install(a);
  if (mode === 'stage') {
    const id = process.argv[3];
    const env = { ...cleanEnvironment(a.candidateSha), OPERATIONAL_NODE_SUITE: SUITE_STAGES[id] ?? '',
      OPERATIONAL_NODE_INVENTORY_DIGEST: a.nodeInventoryDigest };
    const command = sealedCommand(id, { node: process.execPath, npmCli: env.R65_NPM_CLI,
      root: source, platform: 'linux' });
    assertSealed(command);
    return runChild(command.executable, command.args, env);
  }
  fail();
}
function hold() {
  return new Promise(resolve => {
    const timer = setInterval(() => {}, 3600000);
    const stop = () => { clearInterval(timer); resolve(); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runContainer().catch(error => { process.exitCode = FINALIZER_EXIT[error.message] ?? 75; });
}
