import { mkdtemp, mkdir, writeFile, readlink, lstat } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { admit, parseGitIdentity, assertOperationalExecutionAllowed } from './operational-admission.mjs';
import { sha256, HEX, fail, STAGES, SUITE_STAGES } from './operational-policy.mjs';
import { readTrustedFile } from './operational-files.mjs';
import { download, validateProvision, validateProvisionInputDirectory } from './operational-provision.mjs';
import { CaptureLedger, publicResult } from './operational-results.mjs';
import { CapturedTransport } from './operational-supervisor.mjs';
import { DockerAdapter } from './operational-pair.mjs';
import { decodeReceipt, receiptIdentity } from './operational-receipt.mjs';

const errorCode = error => ['MALFORMED', 'TIMEOUT', 'OVERFLOW', 'CANCELLED', 'INCOMPLETE',
  'TEST_FAILED', 'SOURCE_MUTATION', 'ADMISSION_BLOCKED'].includes(error?.message) ? error.message : 'INCOMPLETE';
export function validateExecutionResult(bytes, a, manifestDigest, expectedCounts, nonce) {
  return decodeReceipt(bytes, receiptIdentity(a, manifestDigest, nonce), expectedCounts);
}
// The same transaction is exercised by portable Docker-contract tests. The
// real adapter alone owns container IDs and derives termination from Engine.
export async function executeOwned(adapter, { signal, validate, after = async () => {}, onFailure = () => {} }) {
  let result, firstFailure = null;
  try {
    await adapter.create(signal);
    await adapter.execute(signal);
  } catch (error) { firstFailure ??= errorCode(error); }
  finally {
    if (firstFailure) onFailure(firstFailure);
    try { await adapter.close(); } catch (error) { firstFailure ??= errorCode(error); }
    if (firstFailure) onFailure(firstFailure);
  }
  // Receipt completeness and verified exit/removal are independent gates.
  // Nothing received during execution is accepted before both cleanup fences.
  if (!firstFailure) {
    try {
      result = validate(await adapter.collect());
      await after();
    } catch (error) { firstFailure = errorCode(error); onFailure(firstFailure); }
  }
  return { result, failure: firstFailure };
}
async function readAbsolute(path, cap) {
  const absolute = resolve(path);
  return readTrustedFile(dirname(absolute), absolute.slice(dirname(absolute).length + 1), cap);
}
export async function runOperational({ env = process.env, fetchImpl = fetch, output }) {
  assertOperationalExecutionAllowed();
  const started = Date.now(), deadline = started + 86 * 60_000;
  const ledger = new CaptureLedger({ reserveCleanup: true }), rows = [];
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const overall = setTimeout(cancel, 84 * 60_000);
  const transport = new CapturedTransport({ ledger, deadlineMs: deadline, cleanupReserveMs: 120000 });
  let a, manifestBytes, adapter, active = 'S01';
  let manifestDigest = HEX.test(env.OPERATIONAL_APPROVAL_DIGEST ?? '') ? env.OPERATIONAL_APPROVAL_DIGEST : sha256('');
  let inventoryDigest = sha256('');
  const candidateDigest = sha256(env.EXPECTED_CANDIDATE_SHA ?? '');
  const hostEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/nonexistent',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1' };
  const record = async (id, operation) => {
    active = id;
    const begin = Date.now(), timeout = AbortSignal.timeout(STAGES[id] * 60_000);
    const signal = AbortSignal.any([controller.signal, timeout]);
    try {
      const value = await operation(signal);
      if (signal.aborted) fail(controller.signal.aborted ? 'CANCELLED' : 'TIMEOUT');
      rows.push({ id, durationMs: Date.now() - begin, passed: 0, status: 'passed' });
      return value;
    } catch (error) {
      ledger.reject(signal.aborted ? controller.signal.aborted ? 'CANCELLED' : 'TIMEOUT' : errorCode(error));
      rows.push({ id, durationMs: Date.now() - begin, passed: 0, status: 'failed' });
      throw error;
    }
  };
  try {
    const checkout = resolve(env.GITHUB_WORKSPACE ?? process.cwd());
    const workspace = await mkdtemp(join(tmpdir(), 'operational-owner-'));
    await chmodPublicDirectory(workspace);
    const approvalRoot = join(workspace, 'approval');
    await mkdir(approvalRoot, { mode: 0o755 });
    const provisionRoot = env.OPERATIONAL_PROVISION_DIR;
    await mkdir(join(workspace, 'docker-config'), { mode: 0o700 });
    Object.assign(hostEnv, { DOCKER_CONFIG: join(workspace, 'docker-config'), DOCKER_HOST: 'unix:///var/run/docker.sock' });
    await record('S01', async signal => {
      const url = env.OPERATIONAL_APPROVAL_URL ?? '';
      const approvalSize = Number(env.OPERATIONAL_APPROVAL_BYTES);
      if (process.platform !== 'linux' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
          env.R65_EXPECTED_SHA !== env.EXPECTED_CANDIDATE_SHA ||
          !Number.isSafeInteger(approvalSize) || approvalSize <= 0 || approvalSize > 8 * 1024 * 1024 ||
          !/^https:\/\/raw\.githubusercontent\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[a-f0-9]{40}\/[A-Za-z0-9_./-]+$/.test(url) ||
          !HEX.test(env.OPERATIONAL_APPROVAL_DIGEST ?? '')) fail();
      manifestBytes = await download({ url, redirects: [], sha256: manifestDigest,
        size: approvalSize }, { fetchImpl, signal });
      if (manifestBytes.length > 8 * 1024 * 1024) fail('OVERFLOW');
      const approvalPath = join(approvalRoot, 'approval.json');
      await writeFile(approvalPath, manifestBytes, { flag: 'wx', mode: 0o444 });
      const head = await transport.run('S01', '/usr/bin/git', ['rev-parse', 'HEAD'],
        { cwd: checkout, env: hostEnv, signal, responseLimit: 128 });
      const commit = await transport.run('S01', '/usr/bin/git', ['cat-file', 'commit', 'HEAD'],
        { cwd: checkout, env: hostEnv, signal, responseLimit: 256 * 1024 });
      const tree = await transport.run('S01', '/usr/bin/git', ['-c', 'core.hooksPath=/dev/null',
        'ls-tree', '-rz', '--full-tree', 'HEAD'], { cwd: checkout, env: hostEnv, signal, responseLimit: 1024 * 1024 });
      a = admit({ approvalBytes: manifestBytes, approvalDigest: manifestDigest, approvalPath, checkout,
        eventName: env.GITHUB_EVENT_NAME, eventSha: env.GITHUB_SHA, expectedSha: env.EXPECTED_CANDIDATE_SHA,
        ...parseGitIdentity(commit, tree, head) });
      inventoryDigest = a.inventoryDigest;
      if (sha256(await readAbsolute(process.execPath, 256 * 1024 * 1024)) !== a.hostNodeDigest ||
          sha256(await readAbsolute('/usr/bin/docker', 256 * 1024 * 1024)) !== a.dockerDigest) fail();
      // Only bounded control-code/lock metadata is read on the host. Complete
      // source payload verification/copy runs inside the producer's cgroup.
      for (const file of a.source.files.filter(file => /^scripts\/ci\/operational-.*\.mjs$/.test(file.path))) {
        if (file.size > 1024 * 1024 ||
            sha256(await readTrustedFile(checkout, file.path, file.size)) !== file.sha256) fail();
      }
      const lockBytes = await readTrustedFile(checkout, 'package-lock.json', 8 * 1024 * 1024);
      if (sha256(lockBytes) !== a.lockDigest) fail();
      validateProvision(a, JSON.parse(lockBytes));
      await validateProvisionInputDirectory(a, provisionRoot, checkout);
    });
    await record('S02', async signal => {
      if (a.seccomp?.sha256 !== a.seccompDigest || a.seccomp.size > 1024 * 1024) fail();
      const bytes = await download(a.seccomp, { fetchImpl, signal });
      const profile = JSON.parse(bytes);
      if (profile.defaultAction !== 'SCMP_ACT_ERRNO' || !Array.isArray(profile.syscalls)) fail();
      const path = join(workspace, 'seccomp.json');
      await writeFile(path, bytes, { flag: 'wx', mode: 0o444 });
      adapter = new DockerAdapter({ transport, environment: hostEnv, approval: a,
        paths: { source: checkout, provision: provisionRoot, approval: approvalRoot, seccomp: path },
        hostNamespace: await readlink('/proc/self/ns/net'), deadline, manifestDigest });
      await adapter.prepare(signal);
      return path;
    });
    await record('S03', () => validateProvisionInputDirectory(a, provisionRoot, checkout));
    const browserInventory = JSON.parse(await readTrustedFile(checkout, 'e2e/operational-inventory.json', 256 * 1024));
    const nodeInventory = JSON.parse(await readTrustedFile(checkout, 'scripts/ci/operational-node-inventory.json', 256 * 1024));
    const expectedCounts = Object.fromEntries([...Object.entries(browserInventory.suites),
      ...Object.entries(nodeInventory.suites)].map(([id, cases]) => [id, cases.length]));
    active = 'S04';
    const outcome = await executeOwned(adapter, { signal: controller.signal,
      validate: bytes => validateExecutionResult(bytes, a, manifestDigest, expectedCounts, adapter.nonce),
      onFailure: code => ledger.reject(code),
    });
    const execution = adapter.stages;
    const setup = rows.find(row => row.id === 'S03');
    if (setup) {
      setup.durationMs += adapter.setupResult.durationMs;
      setup.status = adapter.setupResult.status;
    }
    if (outcome.result) for (const row of execution) {
      row.passed = outcome.result.suites.find(suite => suite.suiteId === SUITE_STAGES[row.id])?.passed ?? 0;
    }
    if (outcome.failure && !outcome.result) {
      const final = execution.find(row => row.id === 'S14');
      if (final?.status === 'passed') final.status = 'failed';
    }
    rows.push(...execution);
    if (outcome.failure) ledger.reject(outcome.failure);
    rows.push({ id: 'S15', durationMs: 0, passed: 0, status: outcome.failure ? 'incomplete' : 'passed' });
  } catch (error) { ledger.reject(a ? errorCode(error) : 'ADMISSION_BLOCKED'); }
  finally {
    clearTimeout(overall);
    if (adapter) {
      try { await adapter.close(); } catch { ledger.reject('INCOMPLETE'); }
    }
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  }
  for (const id of Object.keys(STAGES)) {
    if (!rows.some(row => row.id === id)) rows.push({ id, durationMs: 0, passed: 0,
      status: id === 'S16' ? 'passed' : 'incomplete' });
  }
  rows.sort((x, y) => x.id.localeCompare(y.id));
  if (!ledger.failure && rows.some(row => row.status !== 'passed')) ledger.reject('INCOMPLETE');
  const bytes = publicResult({ candidateDigest, manifestDigest, inventoryDigest, failure: ledger.failure, stages: rows });
  await writeFile(output, bytes, { flag: 'wx', mode: 0o600 });
  const stat = await lstat(output);
  if (stat.nlink !== 1 || !stat.isFile() || stat.size > 256 * 1024) fail('INCOMPLETE');
  return ledger.failure ? 1 : 0;
}
async function chmodPublicDirectory(path) {
  const { chmod } = await import('node:fs/promises');
  await chmod(path, 0o755);
}
