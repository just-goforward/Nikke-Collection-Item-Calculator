import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { realpath, mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { parsePnpmLock, virtualStorePackages } from '../pnpm-lock.mjs';
import { validateProvision, linuxPackage, verifyArtifact, verifyPnpmPackage,
  lifecycleRecords, validateLifecycleReceipt, validateLifecyclePackage,
  pnpmStoreAddArguments, pnpmInstallArguments, registryMetadataEntries,
  registryMetadataUrl } from './operational-provision.mjs';
import { PNPM_URL, PNPM_SRI, sha256 } from './operational-policy.mjs';
import { writeEntries } from './operational-archives.mjs';
import { readTrustedFile } from './operational-files.mjs';

const hex = 'a'.repeat(64);
function fixtureApproval() {
  const lock = parsePnpmLock(readFileSync(new URL('../../pnpm-lock.yaml', import.meta.url)));
  const artifacts = [{ kind: 'pnpm', url: PNPM_URL, integrity: PNPM_SRI },
    { kind: 'manager-package', ...lock.manager.packages['pnpm@12.21.0'],
      packageId: 'pnpm@12.21.0', url: lock.manager.packages['pnpm@12.21.0'].resolved },
    ...Object.values(lock.packages).filter(linuxPackage).map(pkg =>
      ({ kind: 'package', packageId: pkg.id, integrity: pkg.integrity, url: pkg.resolved })),
    ...[...new Set([...Object.values(lock.packages), ...Object.values(lock.manager.packages)]
      .map(pkg => pkg.name))].map(packageName => ({ kind: 'registry-metadata', packageName,
      url: registryMetadataUrl(packageName), integrity: PNPM_SRI })),
    { kind: 'browser', url: 'https://cdn.playwright.dev/chromium.zip', target: 'chromium-1' }]
    .map((item, index) => ({ ...item, id: `A${String(index).padStart(4, '0')}`,
      sha256: hex, size: 1, unpackedBytes: 4096, redirects: [] }));
  const lifecycles = virtualStorePackages(lock, { maxLength: 120 })
    .filter(pkg => ['esbuild', 'workerd'].includes(pkg.name)).map(pkg =>
      ({ packageId: pkg.id, snapshot: pkg.snapshot, version: pkg.version,
        integrity: pkg.integrity, script: 'install.js', scriptDigest: sha256('approved script') }));
  const a = { lockDigest: lock.digest, source: { files: [] },
    storage: { backend: 'named-tmpfs-pair-v1', workspaceBytes: 2147483648,
      frameworkBytes: 67108864, tmpBytes: 268435456, shmBytes: 268435456,
      footprint: { sourceBytes: 0, sourceAllocatedBytes: 0, provisionExpandedBytes: artifacts.length * 4096,
        pnpmStoreBytes: artifacts.length * 4096, buildReserveBytes: 1048576, metadataReserveBytes: 65536 } },
    provision: { schemaVersion: 2, storeFormat: 'pnpm-12.21.0-tarball-v1', artifacts, lifecycles } };
  a.provisionDigest = sha256(JSON.stringify(a.provision));
  return { a, lock };
}

test('registry metadata URLs preserve only the canonical npm scope separator', () => {
  assert.equal(registryMetadataUrl('pnpm'), 'https://registry.npmjs.org/pnpm');
  assert.equal(registryMetadataUrl('@pnpm/exe.linux-x64'), 'https://registry.npmjs.org/@pnpm%2Fexe.linux-x64');
  for (const name of ['a/b', '@a/b/c', '@a/', 'a\\b', '@a%2Fb', '@a/..', 'a?b', 'a#b', 'a\n', null]) {
    assert.throws(() => registryMetadataUrl(name), /ADMISSION_BLOCKED/);
  }
});

test('pnpm provision binds application tarballs, native manager and every lifecycle snapshot', () => {
  const { a, lock } = fixtureApproval();
  validateProvision(a, lock);
  for (const mutate of [
    a => { a.provision.schemaVersion = 1; },
    a => { a.lockDigest = hex; },
    a => { a.provision.artifacts[0].kind = 'npm'; },
    a => { a.provision.artifacts[0].integrity = hex; },
    a => { a.provision.artifacts.splice(1, 1); },
    a => { a.provision.artifacts.splice(2, 1); },
    a => { a.provision.artifacts[2].packagePath = 'node_modules/foo'; },
    a => { a.provision.artifacts[2].url = 'https://registry.npmjs.org/unapproved.tgz'; },
    a => { a.provision.lifecycles.pop(); },
    a => { a.provision.lifecycles[0].snapshot += '(unapproved@1.0.0)'; },
    a => { a.provision.lifecycles[0].script = '../install.js'; },
  ]) {
    const changed = structuredClone(a); mutate(changed);
    assert.throws(() => validateProvision(changed, lock), /ADMISSION_BLOCKED/);
  }
});

test('package bytes and native executable metadata must match approved integrity and platform', () => {
  const bytes = Buffer.from('archive');
  const artifact = { size: bytes.length, sha256: sha256(bytes),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` };
  verifyArtifact(bytes, artifact);
  assert.throws(() => verifyArtifact(Buffer.from('changed'), artifact), /ADMISSION_BLOCKED/);
  assert.throws(() => verifyArtifact(bytes, { ...artifact, integrity: PNPM_SRI }), /ADMISSION_BLOCKED/);
  const pkg = { name: '@pnpm/exe.linux-x64', version: '12.21.0', os: ['linux'], cpu: ['x64'], libc: ['glibc'] };
  verifyPnpmPackage(pkg);
  assert.throws(() => verifyPnpmPackage({ ...pkg, version: '12.17.0' }), /ADMISSION_BLOCKED/);
  assert.throws(() => verifyPnpmPackage({ ...pkg, cpu: ['arm64'] }), /ADMISSION_BLOCKED/);
});

test('metadata provisioning preserves registry policy evidence and rejects missing times or substituted tarballs', () => {
  const record = { id: 'fixture@1.0.0', name: 'fixture', version: '1.0.0',
    integrity: PNPM_SRI, resolved: 'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz' };
  const lock = { packages: { [record.id]: record } };
  const document = { name: record.name, time: { '1.0.0': '2020-01-01T00:00:00.000Z' },
    versions: { '1.0.0': { name: record.name, version: record.version,
      dist: { integrity: record.integrity, tarball: record.resolved, attestations: { url: 'https://registry.npmjs.org/provenance' } } } } };
  const check = doc => {
    const bytes = Buffer.from(JSON.stringify(doc));
    return registryMetadataEntries(bytes, { packageName: record.name, size: bytes.length,
      sha256: sha256(bytes), integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      unpackedBytes: 65536 }, lock);
  };
  const entries = check(document);
  assert.deepEqual(JSON.parse(entries[0].bytes.toString().split('\n')[1]), document);
  for (const change of [doc => { delete doc.time['1.0.0']; },
    doc => { doc.versions['1.0.0'].dist.tarball = 'https://example.org/unapproved.tgz'; }]) {
    const altered = structuredClone(document); change(altered);
    assert.throws(() => check(altered), /ADMISSION_BLOCKED/);
  }
});

test('lifecycle receipts reject substituted scripts, package versions, snapshots and missing executions', () => {
  const { a, lock } = fixtureApproval();
  const records = lifecycleRecords(a, lock), item = records[0], record = lock.packages[item.packageId];
  const pkg = { name: record.name, version: record.version, scripts: { postinstall: 'node install.js' } };
  validateLifecyclePackage(item, record, Buffer.from('approved script'), pkg);
  assert.throws(() => validateLifecyclePackage(item, record, Buffer.from('other script'), pkg), /ADMISSION_BLOCKED/);
  assert.throws(() => validateLifecyclePackage(item, record, Buffer.from('approved script'),
    { ...pkg, scripts: { postinstall: 'node unexpected.js' } }), /ADMISSION_BLOCKED/);
  const receipt = { schemaVersion: 2, pnpm: '12.21.0', lockDigest: a.lockDigest,
    provisionDigest: a.provisionDigest, lifecycles: records };
  validateLifecycleReceipt(a, lock, receipt);
  for (const mutate of [r => { r.lifecycles.pop(); }, r => { r.provisionDigest = hex; },
    r => { r.lifecycles[0].exitCode = 1; }, r => { r.lifecycles[0].snapshot += '(foo@1.0.0)'; }]) {
    const changed = structuredClone(receipt); mutate(changed);
    assert.throws(() => validateLifecycleReceipt(a, lock, changed), /ADMISSION_BLOCKED/);
  }
});

function tarFile(name, content) {
  const bytes = Buffer.from(content), header = Buffer.alloc(512);
  header.write(name); header.write('0000644\0', 100);
  header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136); header.fill(32, 148, 156); header[156] = 48;
  header.write('ustar\0', 257); header.write('00', 263);
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}

test('native pnpm imports a tarball then installs frozen offline without running package hooks', {
  skip: process.env.OPERATIONAL_PNPM_FIXTURE_BINARY ? false : 'Set OPERATIONAL_PNPM_FIXTURE_BINARY to an independently provisioned pnpm 12.21.0 native executable',
}, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pnpm-offline-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), store = join(root, 'store'), project = join(root, 'project');
  await Promise.all([home, store, project].map(path => mkdir(path)));
  const binary = process.env.OPERATIONAL_PNPM_FIXTURE_BINARY;
  const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home, XDG_CACHE_HOME: join(home, 'cache'), XDG_STATE_HOME: join(home, 'state'),
    TEMP: home, TMP: home, TMPDIR: home, PNPM_HOME: home, CI: 'true',
    PNPM_CONFIG_NPMRC_AUTH_FILE: join(home, 'empty-npmrc'), PNPM_CONFIG_OFFLINE: 'true',
    PNPM_CONFIG_PM_ON_FAIL: 'error', PNPM_CONFIG_RUNTIME_ON_FAIL: 'error',
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'error', PNPM_CONFIG_UPDATE_NOTIFIER: 'false',
    PNPM_CONFIG_IGNORE_PNPMFILE: 'true', PNPM_CONFIG_IGNORE_SCRIPTS: 'true' });
  await writeFile(join(home, 'empty-npmrc'), '');
  const run = (args, success = true) => {
    const result = spawnSync(binary, args, { cwd: project, env, encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.ifError(result.error);
    if (success) assert.equal(result.status, 0, result.stdout + result.stderr);
    else assert.notEqual(result.status, 0, result.stdout + result.stderr);
    return result.stdout + result.stderr;
  };
  assert.equal(run(['--version']).trim(), '12.21.0');
  const pkg = { name: 'offline-contract-fixture', version: '1.0.0',
    scripts: { postinstall: 'node -e "process.exit(97)"' } };
  const tgz = gzipSync(Buffer.concat([tarFile('package/package.json', JSON.stringify(pkg)),
    tarFile('package/index.js', 'module.exports = 42;\n'), Buffer.alloc(1024)]));
  const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
  const archive = join(root, 'fixture.tgz'); await writeFile(archive, tgz);
  const manifest = { name: 'fixture-project', version: '1.0.0', private: true,
    dependencies: { 'offline-contract-fixture': '1.0.0' }, scripts: { proof: 'node -e "process.exit(0)"' } };
  await writeFile(join(project, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(project, 'pnpm-workspace.yaml'), 'verifyDepsBeforeRun: error\npmOnFail: error\n');
  const lock = `lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .:\n    dependencies:\n      offline-contract-fixture:\n        specifier: 1.0.0\n        version: 1.0.0\npackages:\n  offline-contract-fixture@1.0.0:\n    resolution: {integrity: ${integrity}}\nsnapshots:\n  offline-contract-fixture@1.0.0: {}\n`;
  await writeFile(join(project, 'pnpm-lock.yaml'), lock);
  assert.match(run(pnpmInstallArguments(store), false), /OFFLINE|offline|cache|store/);
  run(pnpmStoreAddArguments([archive], store));
  const parsed = parsePnpmLock(lock), record = parsed.packages['offline-contract-fixture@1.0.0'];
  const metadata = Buffer.from(JSON.stringify({ name: pkg.name, 'dist-tags': { latest: '1.0.0' },
    time: { '1.0.0': '2020-01-01T00:00:00.000Z' },
    versions: { '1.0.0': { ...pkg, dist: { integrity, tarball: record.resolved } } } }));
  const metaArtifact = { packageName: pkg.name, size: metadata.length, sha256: sha256(metadata),
    integrity: `sha512-${createHash('sha512').update(metadata).digest('base64')}`, unpackedBytes: 65536 };
  await writeEntries(registryMetadataEntries(metadata, metaArtifact, parsed), join(home, 'cache', 'pnpm'));
  run(pnpmInstallArguments(store));
  assert.equal(await readFile(join(project, 'pnpm-lock.yaml'), 'utf8'), lock);
  assert.equal(JSON.parse(await readFile(join(project, 'node_modules/offline-contract-fixture/package.json'))).version, '1.0.0');
  assert.equal(JSON.parse(await readTrustedFile(project,
    'node_modules/.pnpm/offline-contract-fixture@1.0.0/node_modules/offline-contract-fixture/package.json', 65536)).version, '1.0.0');
  await assert.rejects(readTrustedFile(project, 'node_modules/offline-contract-fixture/package.json', 65536), /SOURCE_MUTATION/);
  manifest.dependencies['offline-contract-fixture'] = '2.0.0';
  await writeFile(join(project, 'package.json'), JSON.stringify(manifest));
  assert.match(run(['run', 'proof'], false), /ERR_PNPM_VERIFY_DEPS_BEFORE_RUN/);
});
