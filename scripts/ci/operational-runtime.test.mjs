import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { admit, validateApproval, validateApprovalModel, validateDetachedApprovalModel,
  parseGitIdentity, requireContainmentEvidence } from './operational-admission.mjs';
import { DockerAdapter, pairContainerArguments } from './operational-pair.mjs';
import { createPairModel } from './operational-pair-fixture.mjs';
import { executeOwned, validateExecutionResult, runOperational } from './operational-main.mjs';
import { download } from './operational-provision.mjs';
import { tarEntries, extractTgz } from './operational-archives.mjs';
import { nodeReport, validateNodeSuite } from './operational-node-reporter.mjs';
import { CapturedTransport } from './operational-supervisor.mjs';
import { networkObservation } from './operational-probe.mjs';
import { sha256, STAGES, GENERATED, NPM_SRI, sealedCommand, validateBrowserConfig, cleanEnvironment } from './operational-policy.mjs';
import { encodeReceipt, decodeReceipt, RECEIPT_LIMIT } from './operational-receipt.mjs';
import { validateFootprint, validateKernelStorage } from './operational-storage.mjs';
import { LifecycleJournal, watchLifecycle } from './operational-events.mjs';
import { waitForContainerExit } from './operational-engine-wait.mjs';
import { CaptureLedger } from './operational-results.mjs';
import { createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { gzipSync } from 'node:zlib';
import { finalize } from './operational-finalizer.mjs';
import { runContainer } from './operational-container.mjs';

const hex = 'a'.repeat(64), commit = 'b'.repeat(40), parent = 'c'.repeat(40), tree = 'd'.repeat(40);
function approved() {
  const files = [];
  for (const [classification, count] of [['protected', 136], ['wasm', 13], ['fixture', 46]]) {
    for (let i = 0; i < count; i++) files.push({ path: `${classification}/${i}`, size: 0, mode: '100644', sha256: sha256(''), classification });
  }
  for (const [path, classification] of [['package-lock.json', 'lock'], ['e2e/operational-inventory.json', 'source'],
    ['scripts/ci/operational-node-inventory.json', 'source'], ['scripts/ci/operational-main.mjs', 'provision'],
    ['a.test.mjs', 'test'], ['tsconfig.operational-ci.json', 'test'],
    ['e2e/operational-console-flood.test.mjs', 'test'], ['e2e/operational-type-config.test.mjs', 'test']])
    files.push({ path, classification, size: 0, mode: '100644', sha256: sha256('') });
  const a = { schemaVersion: 1, candidateSha: commit, parents: [parent], tree, event: 'workflow_dispatch',
    executionAuthorized: true, image: `docker.io/library/node@sha256:${hex}`, platform: 'linux/amd64',
    node: '26.13.0', npm: '12.2.1', stageIds: Object.keys(STAGES),
    source: { schemaVersion: 1, generatedDirectories: [...GENERATED], files },
    inventoryDigest: sha256(''), nodeInventoryDigest: sha256(''), lockDigest: sha256(''),
    reviewedBackendDigest: sha256(JSON.stringify([['scripts/ci/operational-main.mjs', sha256('')]])),
    testDigests: { 'a.test.mjs': sha256(''), 'tsconfig.operational-ci.json': sha256(''),
      'e2e/operational-console-flood.test.mjs': sha256(''), 'e2e/operational-type-config.test.mjs': sha256('') },
    seccompDigest: hex, hostNodeDigest: hex,
    dockerDigest: hex, nodeDigest: hex, npmCliDigest: hex, npmIntegrity: NPM_SRI,
    storage: { workspaceBytes: 2147483648, frameworkBytes: 67108864, tmpBytes: 268435456,
      shmBytes: 268435456, backend: 'named-tmpfs-pair-v1',
      footprint: { sourceBytes: 0, sourceAllocatedBytes: 32768, provisionExpandedBytes: 0,
        npmCacheBytes: 0, buildReserveBytes: 1048576, metadataReserveBytes: 65536 } },
    provision: { artifacts: [], lifecycles: [] },
    runtime: { profile: 'moby-28.0.4-containerd-1.7.27-runc-1.2.6-private-pid-v1',
      kernelVersion: '7.0.0-1017-azure',
      commits: { engine: 'a'.repeat(7), containerd: 'b'.repeat(40), runc: 'c'.repeat(40) },
      binaries: { dockerd: hex, containerd: hex, shim: hex, runc: hex } },
  };
  a.provisionDigest = sha256(JSON.stringify(a.provision));
  return a;
}
function admissionInput(a) {
  const approvalBytes = Buffer.from(JSON.stringify(a));
  return { approvalBytes, approvalDigest: sha256(approvalBytes), approvalPath: resolve(tmpdir(), 'approved.json'),
    checkout: resolve(tmpdir(), 'checkout'), eventName: 'workflow_dispatch', eventSha: commit,
    expectedSha: commit, head: commit, parents: [parent], tree,
    publicPaths: a.source.files.map(({ path, mode }) => ({ path, mode })) };
}
const admissionModel = a => validateDetachedApprovalModel(admissionInput(a));
function tar(path, bytes, type = 48) {
  const header = Buffer.alloc(512), value = Buffer.from(bytes);
  header.write(path, 0);
  header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(value.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136); header.fill(32, 148, 156); header[156] = type;
  const sum = header.reduce((n, byte) => n + byte, 0);
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([header, value, Buffer.alloc((512 - value.length % 512) % 512), Buffer.alloc(1024)]);
}
function identity(a) {
  const digest = value => createHash('sha256').update(value).digest('hex');
  return { nonce: hex, candidateDigest: digest(a.candidateSha), manifestDigest: hex,
    inventoryDigest: a.inventoryDigest, nodeInventoryDigest: a.nodeInventoryDigest,
    sourceDigest: digest(JSON.stringify(a.source)) };
}
const counts = { 'profile-policy': 1, 'node-runtime': 1, 'numerical-boundary': 1,
  'production-policy': 1, 'analytics-policy': 1 };
function resultBytes(a) {
  return encodeReceipt({ schemaVersion: 1, ...identity(a),
    suites: Object.keys(counts).map(suiteId => ({ suiteId, passed: 1 })) });
}
function engine(options = {}) {
  const a = approved();
  const model = createPairModel(a, resultBytes(a), options);
  const validate = bytes => {
    assert.equal(model.allRemoved(), true);
    return validateExecutionResult(bytes, a, hex, counts, hex);
  };
  return { ...model, a, validate };
}
test('[model only] detached approval validation binds bytes, parents, tree, classifications and pins', () => {
  assert.equal(admissionModel(approved()).candidateSha, commit);
  for (const mutate of [
    a => { a.parents = []; }, a => { a.image = 'node:latest'; }, a => { a.stageIds.push('S01'); },
    a => { a.source.files[0].classification = 'source'; }, a => { a.testDigests = {}; },
    a => { a.reviewedBackendDigest = hex; }, a => { a.executionAuthorized = false; },
    a => { delete a.testDigests['tsconfig.operational-ci.json']; },
  ]) { const a = approved(); mutate(a); assert.throws(() => admissionModel(a), /ADMISSION_BLOCKED/); }
  const identity = parseGitIdentity(Buffer.from(`tree ${tree}\nparent ${parent}\nparent ${commit}\nauthor private\n\nmessage`),
    Buffer.from(`100644 blob ${commit}\tpublic/x\0`), Buffer.from(commit));
  assert.deepEqual(identity.parents, [parent, commit]);
  assert.deepEqual(identity.publicPaths, [{ path: 'public/x', mode: '100644' }]);
  assert.throws(() => parseGitIdentity(Buffer.from(`tree ${tree}\n\n`),
    Buffer.from(`120000 blob ${commit}\tlink\0`), Buffer.from(commit)), /ADMISSION_BLOCKED/);
});
test('[mocked components only] receipt acceptance follows exit and removal', async () => {
  const { adapter, calls, validate } = engine();
  await assert.rejects(adapter.collect(), /INCOMPLETE/);
  await adapter.prepare();
  const outcome = await executeOwned(adapter, { validate });
  assert.equal(outcome.failure, null);
  assert.equal(outcome.result.suites.length, 5);
  const operations = calls.map(call => call.args[0]);
  assert.ok(operations.indexOf('exec') > operations.indexOf('start'));
  assert.ok(operations.indexOf('rm') > operations.lastIndexOf('exec'));
  assert.equal(calls.filter(call => call.args[0] === 'create').length, 2);
  assert.equal(calls.filter(call => call.args[0] === 'volume' && call.args[1] === 'rm').length, 2);
  const collectAt = calls.findIndex(call => call.args[0] === 'exec' && call.args.includes('f'.repeat(64)));
  assert.ok(collectAt > calls.findIndex(call => call.args[0] === 'API_WAIT' && call.args[1] === 'e'.repeat(64)));
  for (const call of calls.filter(c => ['inspect', 'start', 'stop', 'kill', 'rm'].includes(c.args[0]))) {
    assert.ok(['e'.repeat(64), 'f'.repeat(64)].includes(call.args.at(-1)));
  }
});
test('[mocked components only] Docker policy, cancellation and cleanup failures reject success', async () => {
  for (const [options, expected] of [
    [{ executionFailure: true }, 'TEST_FAILED'], [{ badMount: true }, 'ADMISSION_BLOCKED'],
    [{ cancel: true }, 'CANCELLED'], [{ cleanupFailure: true }, 'INCOMPLETE'],
    [{ reportFailure: 'SOURCE_MUTATION', cleanupFailure: true }, 'SOURCE_MUTATION'],
    [{ badExit: true }, 'INCOMPLETE'], [{ missingReceipt: true }, 'INCOMPLETE'],
    [{ extraReceipt: true }, 'INCOMPLETE'], [{ survivor: true }, 'INCOMPLETE'],
    [{ appInjection: true, missingReceipt: true }, 'INCOMPLETE'],
    [{ badRoot: true }, 'ADMISSION_BLOCKED'], [{ wrongCap: true }, 'ADMISSION_BLOCKED'],
    [{ extraMount: true }, 'ADMISSION_BLOCKED'],
    [{ volumeCleanupFailure: true }, 'INCOMPLETE'], [{ copyUp: true }, 'ADMISSION_BLOCKED'],
    [{ holderLoss: true }, 'INCOMPLETE'], [{ daemonRestart: true }, 'INCOMPLETE'],
    [{ earlyExit: true }, 'INCOMPLETE'], [{ duplicateMount: true }, 'INCOMPLETE'],
  ]) {
    const { adapter, validate, calls, collectorReads } = engine(options);
    await adapter.prepare();
    const outcome = await executeOwned(adapter, { validate });
    assert.equal(outcome.failure, expected);
    const unowned = options.badMount || options.badRoot || options.extraMount || options.copyUp;
    assert.equal(calls.some(call => call.args[0] === 'rm'), !unowned);
    if (options.wrongCap)
      assert.ok(!calls.some(call => call.args[0] === 'rm' && call.args.at(-1) === 'e'.repeat(64)));
    if (!unowned && !options.cleanupFailure)
      assert.ok(calls.some(call => call.args[0] === 'ps' && call.args.some(arg => arg.startsWith('id='))));
    await assert.rejects(adapter.collect().then(bytes => validate(bytes)));
    if (options.holderLoss || options.earlyExit || options.daemonRestart) assert.equal(collectorReads(), 0);
  }
});
test('[model only] pair argv seals resource shares, named volume nocopy and RO collector mounts', () => {
  const a = approved();
  const paths = { source: resolve('/source'), provision: resolve('/packages'),
    approval: resolve('/approval'), seccomp: resolve('/profile') };
  const volumes = { work: `operational-${hex}-work`, framework: `operational-${hex}-framework` };
  const args = pairContainerArguments(a, { role: 'producer', paths, volumes,
    nonce: hex, hostNamespace: 'net:[1]', manifestDigest: hex });
  for (const flag of ['--network=none', '--ipc=private', '--cap-drop=ALL', '--user=1001:1001',
    '--memory=2684354560', '--memory-swap=2684354560', '--pids-limit=256', '--cpus=1', '--security-opt=no-new-privileges'])
    assert.ok(args.includes(flag));
  assert.ok(args.includes('--read-only'));
  const mounts = args.flatMap((arg, index) => arg === '--tmpfs' ? [args[index + 1]] : []);
  assert.deepEqual(mounts, [
    '/tmp:rw,nosuid,nodev,noexec,size=268435456,uid=1001,gid=1001,mode=0700',
  ]);
  for (const [key, target] of [['work', '/work'], ['framework', '/home/node']])
    assert.ok(args.includes(`type=volume,src=${volumes[key]},dst=${target},volume-nocopy`));
  const collector = pairContainerArguments(a, { role: 'collector', paths, volumes,
    nonce: hex, hostNamespace: 'net:[1]', manifestDigest: hex });
  for (const [key, target] of [['work', '/work'], ['framework', '/home/node']])
    assert.ok(collector.includes(`type=volume,src=${volumes[key]},dst=${target},volume-nocopy,readonly`));
  assert.ok(collector.includes('--ipc=none'));
  assert.ok(!collector.includes('--tmpfs'));
  assert.equal(args[args.indexOf('--shm-size') + 1], '268435456');
  assert.ok(args.includes('OPERATIONAL_APPROVAL_DIGEST=' + hex));
  const context = { node: process.execPath, npmCli: resolve('/approved/npm-cli.js'), root: resolve('/candidate'), platform: 'linux' };
  assert.deepEqual(sealedCommand('S11', context).args, ['node_modules/vitest/vitest.mjs', 'run',
    '--config', 'vitest.operational-ci.config.ts', '--configLoader', 'runner']);
  assert.deepEqual(sealedCommand('S06', context).args, ['node_modules/typescript/bin/tsc',
    '--noEmit', '-p', 'tsconfig.operational-ci.json']);
  assert.throws(() => sealedCommand('S99', context), /ADMISSION_BLOCKED/);
  assert.ok(sealedCommand('S07', context).args.includes('scripts/locale-storage-boundary.test.mjs'));
  assert.ok(sealedCommand('S07', context).args.includes('e2e/operational-console-flood.test.mjs'));
  assert.ok(sealedCommand('S07', context).args.includes('e2e/operational-type-config.test.mjs'));
});
test('metadata fetcher verifies exact bytes, disallows redirects and never retries integrity or auth failures', async () => {
  const bytes = Buffer.from('approved archive'), item = { url: 'https://registry.npmjs.org/example.tgz',
    redirects: [], size: bytes.length, sha256: sha256(bytes) };
  let calls = 0;
  const fetchImpl = async (_url, opts) => { calls++; assert.equal(opts.redirect, 'manual'); return new Response(bytes); };
  assert.deepEqual(await download(item, { fetchImpl }), bytes);
  assert.equal(calls, 1);
  for (const response of [new Response(bytes, { status: 403 }),
    new Response(null, { status: 302, headers: { location: 'https://not-approved.example/x' } }),
    new Response('wrong integrity'), new Response(Buffer.alloc(bytes.length + 1))]) {
    calls = 0;
    await assert.rejects(download(item, { fetchImpl: async () => { calls++; return response; } }));
    assert.equal(calls, 1);
  }
});
test('bounded archive extraction rejects links, traversal and expanded footprint overflow', async t => {
  assert.equal(tarEntries(tar('package/file', '{}'), 8192)[0].bytes.toString(), '{}');
  for (const [path, type] of [['../escape', 48], ['package/file', 49], ['package/file', 50]])
    assert.throws(() => tarEntries(tar(path, '{}', type), 8192), /MALFORMED/);
  assert.throws(() => tarEntries(tar('package/file', 'too large'), 1), /MALFORMED/);
  const directory = await mkdtemp(join(tmpdir(), 'operational-tar-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(extractTgz(gzipSync(tar('package/file', 'ok')), directory, 100), /OVERFLOW/);
  await extractTgz(gzipSync(tar('package/file', 'ok')), directory, 8192);
  assert.equal(await readFile(join(directory, 'package/file'), 'utf8'), 'ok');
});
test('Node reporter binds independently approved identities and rejects missing, extra, duplicate or skipped cases', async () => {
  const root = resolve('/candidate'), suiteId = 'node-runtime';
  const inventory = Buffer.from(JSON.stringify({ schemaVersion: 1, suites: {
    'profile-policy': [['F001', 'profile.test.mjs', 'profile']],
    'node-runtime': [['R001', 'runtime.test.mjs', 'opaque source test']],
  } }));
  const digest = sha256(inventory);
  const events = () => [{ type: 'test:pass', data: { file: join(root, 'runtime.test.mjs'),
    name: 'opaque source test', nesting: 0, details: {} } },
  { type: 'test:summary', data: { success: true, counts: { tests: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0 } } }];
  const rows = JSON.parse(inventory).suites[suiteId];
  const make = e => nodeReport(e, rows, { root, suiteId, digest });
  assert.equal(validateNodeSuite(Buffer.from(JSON.stringify(await make(events()))), inventory, digest, suiteId).passed, 1);
  for (const alter of [e => e.shift(), e => { e[0].data.name = 'unknown'; },
    e => e.unshift(e[0]), e => { e[0].data.skip = true; }]) {
    const e = events(); alter(e);
    await assert.rejects(async () => validateNodeSuite(Buffer.from(JSON.stringify(await make(e))), inventory, digest, suiteId));
  }
});
test('transport captures process output and awaits actual close after overflow and cancellation', async () => {
  for (const mode of ['overflow', 'cancel', 'ok', 'spawn-error']) {
    const controller = new AbortController(), events = [];
    const transport = new CapturedTransport({ deadlineMs: Date.now() + 20000, cleanupReserveMs: 1000,
      spawnImpl: () => {
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough();
        child.kill = () => { events.push('kill'); queueMicrotask(() => { events.push('close'); child.emit('close', null, 'SIGKILL'); }); };
        queueMicrotask(() => {
          if (mode === 'overflow') child.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1));
          else if (mode === 'cancel') controller.abort();
          else {
            if (mode === 'spawn-error') child.emit('error', new Error('private path'));
            child.emit('close', mode === 'ok' ? 0 : 1, null);
          }
        });
        return child;
      } });
    const promise = transport.run('S01', 'sealed-host-operation', [], {
      signal: controller.signal, terminate: async () => { events.push('namespace-stop'); },
    });
    if (mode === 'ok') await promise;
    else await assert.rejects(promise, new RegExp({ overflow: 'OVERFLOW', cancel: 'CANCELLED', 'spawn-error': 'INCOMPLETE' }[mode]));
    if (['overflow', 'cancel'].includes(mode)) assert.deepEqual(events, ['namespace-stop', 'kill', 'close']);
  }
});
test('containment transcript needs all engines and transport kinds plus kernel namespace, route and mount observations', () => {
  const mounts = ['/source', '/provision'].map((p, i) => `${i + 1} 0 0:0 / ${p} ro - ext4 root ro`)
    .concat(['/work', '/tmp', '/dev/shm'].map((p, i) => `${i + 3} 0 0:0 / ${p} rw - tmpfs tmpfs rw`)).join('\n');
  const observation = networkObservation({ interfaces: { lo: [] }, route4: 'Iface Destination\n', route6: '',
    mounts, namespace: 'net:[2]', hostNamespace: 'net:[1]' });
  const evidence = { nonce: hex, ...observation, attempts: ['node', 'browser', 'worker'].flatMap(engine =>
    ['ipv4', 'ipv6', 'dns', 'direct', 'loopback'].map(kind => ({ engine, kind, transport: 'native',
      outcome: kind === 'loopback' ? 'connected' : 'blocked' }))) };
  requireContainmentEvidence(evidence, hex);
  for (const alter of [e => e.attempts.pop(), e => { e.attempts[0].transport = 'mock'; },
    e => { e.attempts[4].outcome = 'blocked'; }, e => { e.namespace = e.hostNamespace; },
    e => { e.nonLoopbackRoutes = 1; }, e => { e.unsafeMounts = 1; }]) {
    const e = structuredClone(evidence); alter(e);
    assert.throws(() => requireContainmentEvidence(e, hex), /ADMISSION_BLOCKED/);
  }
});
test('workflow exposes only manual read-only verification and one one-day JSON artifact', async () => {
  // Workflow YAML has no local runnable surface; inspect its declarative gates.
  const workflow = await readFile(new URL('../../.github/workflows/pages.yml', import.meta.url), 'utf8');
  assert.match(workflow, /on:\s+workflow_dispatch:/);
  assert.equal((workflow.match(/^  [a-z][\w-]*:\n    runs-on:/gm) ?? []).length, 1);
  assert.match(workflow, /permissions:\s+contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /timeout-minutes: 90/);
  assert.match(workflow, /retention-days: 1/);
  assert.equal((workflow.match(/uses: actions\/upload-artifact@/g) ?? []).length, 1);
  assert.match(workflow, /path: \$\{\{ runner.temp \}\}\/operational-public\/result.json/);
  assert.doesNotMatch(workflow, /\b(?:push|pull_request|workflow_run|environment|secrets|pages|id-token):|cache:|upload-pages|deploy-pages/);
});
test('internal stage deadline terminates the namespace before resolving and reserves cleanup time', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const order = [];
  const transport = new CapturedTransport({ deadlineMs: 11000, cleanupReserveMs: 2000,
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => { order.push('kill'); queueMicrotask(() => child.emit('close', null, 'SIGKILL')); };
      return child;
    } });
  const promise = transport.run('S01', 'sealed-operation', [], { durationMs: 20000,
    terminate: async () => { order.push('stop-namespace'); } });
  const rejected = assert.rejects(promise, /TIMEOUT/);
  t.mock.timers.tick(8000);
  await rejected;
  assert.deepEqual(order, ['stop-namespace', 'kill']);
  assert.equal(Date.now(), 9000);
});
test('browser execution is refused before launch unless sandbox and isolated production policy are explicit', () => {
  const config = { workers: 1, retries: 0, repeatEach: 1, forbidOnly: true, projects: [{ name: 'chromium' }],
    use: { browserName: 'chromium', serviceWorkers: 'block', launchOptions: { chromiumSandbox: true },
      trace: 'off', video: 'off', screenshot: 'off', baseURL: 'http://127.0.0.1:4290' },
    webServer: { url: 'http://127.0.0.1:4290', reuseExistingServer: false } };
  validateBrowserConfig(config, true);
  for (const alter of [c => { delete c.use.launchOptions; }, c => { c.use.launchOptions.chromiumSandbox = false; },
    c => { c.webServer.reuseExistingServer = true; }, c => { c.projects[0].use = {}; },
    c => { c.use.baseURL = 'http://localhost:4290'; }]) {
    const changed = structuredClone(config); alter(changed);
    assert.throws(() => validateBrowserConfig(changed, true), /ADMISSION_BLOCKED/);
  }
});
test('[model only] receipt and full producer reservation persist until both incarnations and volumes are removed', async () => {
  const { adapter, validate, state } = engine();
  await adapter.prepare();
  await adapter.create();
  await adapter.execute();
  assert.equal(state.producer.status, 'exited');
  assert.equal(state.collector.status, 'running');
  assert.equal(adapter.reservedMemoryBytes, 5368709120);
  await assert.rejects(adapter.collect(), /INCOMPLETE/);
  await assert.rejects(adapter.create(), /ADMISSION_BLOCKED/);
  await assert.rejects(adapter.execute(), /ADMISSION_BLOCKED/);
  await adapter.close();
  assert.equal(adapter.reservedMemoryBytes, 0);
  assert.equal(validate(await adapter.collect()).schemaVersion, 1);
});
test('image volumes are rejected before any execution namespace is created', async () => {
  const { adapter, calls } = engine({ imageVolume: true });
  await assert.rejects(adapter.prepare(), /ADMISSION_BLOCKED/);
  assert.deepEqual(calls.map(call => call.args[0]), ['version', 'info', 'image']);
});
test('[model only] unsupported runtime and pre-existing volume names cannot acquire execution ownership', async () => {
  const unknown = engine({ unknownRuntime: true });
  await assert.rejects(unknown.adapter.prepare(), /ADMISSION_BLOCKED/);
  assert.ok(!unknown.calls.some(call => ['create', 'volume', 'start', 'exec'].includes(call.args[0])));
  const collision = engine({ preexisting: true });
  await collision.adapter.prepare();
  const outcome = await executeOwned(collision.adapter, { validate: collision.validate });
  assert.equal(outcome.failure, 'ADMISSION_BLOCKED');
  assert.ok(!collision.calls.some(call => call.args[0] === 'create' ||
    call.args[0] === 'rm' || call.args[0] === 'volume' && call.args[1] === 'rm'));
});
test('[model only] daemon metadata excludes remapping, rootless and alternative image-store initialization paths', async () => {
  const classic = [['Backing Filesystem', 'extfs'], ['Supports d_type', 'true'], ['Using metacopy', 'false'],
    ['Native Overlay Diff', 'true'], ['userxattr', 'false']];
  for (const daemonInfo of [
    { SecurityOptions: ['name=rootless'] }, { SecurityOptions: ['name=userns'] },
    { SecurityOptions: ['name=unknown'] }, { SecurityOptions: null },
    { Driver: 'fuse-overlayfs' }, { Driver: 'overlayfs' }, { Driver: 'unknown' }, { Driver: null },
    { DriverStatus: [['driver-type', 'io.containerd.snapshotter.v1']] },
    { DriverStatus: [...classic, ['driver-type', 'io.containerd.snapshotter.v1']] },
    { DriverStatus: null }, { DriverStatus: classic.slice(0, 4) },
    { DriverStatus: classic.map(row => row[0] === 'userxattr' ? ['userxattr', 'true'] : row) },
  ]) {
    const { adapter, calls } = engine({ daemonInfo });
    await assert.rejects(adapter.prepare(), /ADMISSION_BLOCKED/);
    assert.ok(!calls.some(call => ['volume', 'create', 'start', 'exec'].includes(call.args[0])));
  }
  const safe = engine({ daemonInfo: { SecurityOptions: ['name=apparmor', 'name=seccomp,profile=builtin', 'name=cgroupns'] } });
  await safe.adapter.prepare();
  assert.equal((await executeOwned(safe.adapter, { validate: safe.validate })).failure, null);
});
test('[model only] actual annotation, user-namespace and graphdriver readback gates precede both container starts', async () => {
  for (const hostConfig of [{}, { Annotations: null }, { Annotations: {} }, { Annotations: {}, UsernsMode: 'host' }]) {
    const model = engine({ hostConfig });
    await model.adapter.prepare();
    assert.equal((await executeOwned(model.adapter, { validate: model.validate })).failure, null);
    assert.equal(model.calls.filter(call => call.args[0] === 'create').length, 2);
  }
  for (const flags of [
    { hostConfig: { Annotations: { 'io.containerd.runc.v2.group': 'shared' } } },
    { hostConfig: { Annotations: { 'io.kubernetes.cri.sandbox-id': 'shared' } } },
    { hostConfig: { Annotations: { metadata: 'unapproved' } } },
    { hostConfig: { Annotations: [] } }, { hostConfig: { Annotations: '' } },
    { hostConfig: { UsernsMode: 'private' } }, { hostConfig: { UsernsMode: 'container:other' } },
    { hostConfig: { UsernsMode: null } }, { hostConfig: { UsernsMode: undefined } },
    { containerMetadata: { Driver: 'fuse-overlayfs' } },
    { containerMetadata: { GraphDriver: { Name: 'overlay2' } } },
    { containerMetadata: { GraphDriver: { Name: 'overlayfs', Data: {} } } },
    { containerMetadata: { GraphDriver: null } },
  ]) {
    const model = engine(flags);
    await model.adapter.prepare();
    const outcome = await executeOwned(model.adapter, { validate: model.validate });
    assert.equal(outcome.failure, 'ADMISSION_BLOCKED');
    assert.ok(!model.calls.some(call => ['start', 'exec', 'rm'].includes(call.args[0])));
    assert.equal(model.collectorReads(), 0);
    await assert.rejects(model.adapter.collect(), /INCOMPLETE/);
    assert.equal(model.adapter.reservedMemoryBytes, 5368709120);
  }
});
test('[R11 model only] pending create intents reconcile lost acknowledgements without adopting foreign resources or claiming uncertain absence', async () => {
  for (const flags of [
    { lostContainerAck: true }, { truncatedContainerAck: true }, { lostVolumeAck: true },
    { volumeInspectFailure: true }, { unknownPendingContainer: true },
    { foreignPendingContainer: true }, { foreignPendingVolume: true, volumeInspectFailure: true },
    { preexistingContainer: true }, { volumeInspectFailure: true, volumeCleanupFailure: true },
  ]) {
    const model = engine(flags);
    await model.adapter.prepare();
    const outcome = await executeOwned(model.adapter, { validate: model.validate });
    assert.equal(outcome.failure, flags.preexistingContainer ? 'ADMISSION_BLOCKED' : 'INCOMPLETE');
    await assert.rejects(model.adapter.collect(), /INCOMPLETE/);
    assert.equal(model.collectorReads(), 0);
    const creates = model.calls.filter(call => call.args[0] === 'create');
    assert.ok(creates.length <= 1);
    assert.ok(model.calls.filter(call => call.args[0] === 'volume' && call.args[1] === 'create').length <= 2);
    const uncertain = flags.unknownPendingContainer || flags.foreignPendingContainer ||
      flags.foreignPendingVolume || flags.volumeCleanupFailure;
    assert.equal(model.adapter.reservedMemoryBytes, uncertain ? 5368709120 : 0);
    if (uncertain) await assert.rejects(model.adapter.close(), /INCOMPLETE/);
    else assert.equal(model.allRemoved(), true);
    if (flags.unknownPendingContainer) {
      assert.equal(Object.keys(model.state).length, 0);
      model.finishPendingCreates();
      assert.equal(model.state.collector.status, 'created');
      assert.equal(model.adapter.reservedMemoryBytes, 5368709120);
    }
    if (flags.foreignPendingContainer || flags.unknownPendingContainer || flags.preexistingContainer)
      assert.ok(!model.calls.some(call => ['rm', 'stop', 'kill'].includes(call.args[0])));
    if (flags.foreignPendingVolume)
      assert.ok(!model.calls.some(call => call.args[0] === 'volume' && call.args[1] === 'rm' && call.args.at(-1) === model.volumes.framework));
    for (const call of model.calls.filter(call => call.args[0] === 'rm'))
      assert.ok(Object.values(model.ids).includes(call.args.at(-1)));
    for (const call of model.calls.filter(call => call.args[0] === 'volume' && call.args[1] === 'rm'))
      assert.ok(Object.values(model.volumes).includes(call.args.at(-1)));
    if (flags.lostContainerAck || flags.truncatedContainerAck)
      assert.ok(model.calls.some(call => call.args[0] === 'inspect' && call.args[1] === `operational-${hex}-collector`));
  }
});
test('all OS framework temp aliases share the report domain, while only installation uses generic scratch', async () => {
  const framework = cleanEnvironment(commit);
  const install = cleanEnvironment(commit, { install: true });
  for (const name of ['TMPDIR', 'TMP', 'TEMP']) {
    assert.equal(framework[name], '/home/node/results/tmp');
    assert.equal(install[name], '/tmp');
  }
  const { adapter, calls, validate } = engine();
  await adapter.prepare();
  assert.equal((await executeOwned(adapter, { validate })).failure, null);
  for (const call of calls.filter(call => call.args[0] === 'exec')) {
    for (const name of ['TMPDIR', 'TMP', 'TEMP'])
      assert.ok(call.args.includes(`${name}=${call.stage === 'S05' ? '/tmp' : '/home/node/results/tmp'}`));
    const index = call.args.findIndex(value => ['e'.repeat(64), 'f'.repeat(64)].includes(value));
    assert.ok(call.args[index + 2].startsWith('/source/scripts/ci/'));
  }
});
test('receipt framing rejects missing, multiple, truncated, trailing, over-cap and injected records', () => {
  const a = approved(), bytes = resultBytes(a), expected = identity(a);
  assert.equal(decodeReceipt(bytes, expected, counts).suites.length, 5);
  for (const invalid of [Buffer.alloc(0), bytes.subarray(0, bytes.length - 1),
    Buffer.concat([bytes, bytes]), Buffer.concat([bytes, Buffer.from('\n')]),
    Buffer.concat([Buffer.from('private application output'), bytes]), Buffer.alloc(RECEIPT_LIMIT + 1)]) {
    assert.throws(() => decodeReceipt(invalid, expected, counts));
  }
  const body = bytes.subarray(8).toString();
  const duplicate = Buffer.from(body.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'));
  const header = Buffer.alloc(8); header.write('OPR1'); header.writeUInt32BE(duplicate.length, 4);
  assert.throws(() => decodeReceipt(Buffer.concat([header, duplicate]), expected, counts), /MALFORMED/);
  for (const key of Object.keys(expected)) {
    const changed = JSON.parse(body); changed[key] = 'f'.repeat(64);
    assert.throws(() => decodeReceipt(encodeReceipt(changed), expected, counts), /ADMISSION_BLOCKED/);
  }
  const injected = JSON.parse(body); injected.title = 'https://private.invalid/path';
  assert.throws(() => encodeReceipt(injected), /ADMISSION_BLOCKED/);
});
test('[model only; NOT kernel proof] exited state or empty proc snapshots cannot replace the trusted wait/event chain', async () => {
  for (const flags of [{ missingReapEvent: true }, { waitFailure: true }]) {
    const { adapter, validate, collectorReads } = engine(flags);
    await adapter.prepare();
    const outcome = await executeOwned(adapter, { validate });
    assert.equal(outcome.failure, 'INCOMPLETE');
    assert.equal(collectorReads(), 0);
  }
  const journal = new LifecycleJournal({ producer: 'e'.repeat(64), collector: 'f'.repeat(64) },
    { work: 'model-work', framework: 'model-framework' });
  journal.accept({ type: 'container', action: 'die', id: 'e'.repeat(64),
    time: '1', container: '', exitCode: '0', reaped: true, processes: [] });
  assert.equal(journal.failure, 'INCOMPLETE');
  assert.equal(journal.exited('producer', 0), false);
});
test('[transport model only] fixed Engine wait retains errors and rejects malformed, oversized or interrupted responses', async () => {
  for (const mode of ['success', 'engine-error', 'malformed', 'oversized', 'interrupted', 'http-error']) {
    const ledger = new CaptureLedger({ reserveCleanup: true });
    ledger.begin('S15');
    let finished = false;
    const promise = waitForContainerExit({ id: hex, ledger, deadline: Date.now() + 20000,
      requestImpl(options, respond) {
        assert.equal(options.socketPath, '/var/run/docker.sock');
        assert.equal(options.method, 'POST');
        assert.equal(options.path, `/v1.48/containers/${hex}/wait?condition=not-running`);
        const request = new EventEmitter();
        request.destroy = () => { finished = true; };
        request.end = () => queueMicrotask(() => {
          const response = new PassThrough();
          response.statusCode = mode === 'http-error' ? 500 : 200;
          respond(response);
          if (mode === 'http-error') { finished = true; return; }
          if (mode === 'interrupted') {
            response.write('{"StatusCode":');
            response.emit('aborted'); response.destroy(); finished = true; return;
          }
          response.end(mode === 'oversized' ? Buffer.alloc(8193) : mode === 'engine-error'
            ? '{"StatusCode":0,"Error":{"Message":"private daemon path"}}'
            : mode === 'malformed' ? '{"StatusCode":0}{"StatusCode":0}' : '{"StatusCode":0}');
          finished = true;
        });
        return request;
      } });
    if (mode === 'success') assert.equal(await promise, 0);
    else await assert.rejects(promise, new RegExp(mode === 'oversized' ? 'OVERFLOW' : 'INCOMPLETE'));
    assert.equal(finished, true);
  }
});
test('[transport model only] event capture fails closed on disconnect, private stderr, trailing data and overflow', async () => {
  for (const mode of ['success', 'disconnect', 'stderr', 'truncated', 'overflow']) {
    const ledger = new CaptureLedger({ reserveCleanup: true });
    ledger.begin('S15');
    const journal = new LifecycleJournal({ producer: hex, collector: 'f'.repeat(64) }, {});
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let closed = false;
    child.kill = () => {
      if (!closed) { closed = true; queueMicrotask(() => child.emit('close', 0)); }
    };
    const watch = watchLifecycle({ executable: '/usr/bin/docker', args: [], env: {},
      ledger, journal, deadline: Date.now() + 20000, spawnImpl: () => child });
    if (mode === 'disconnect') { closed = true; child.emit('close', 0); }
    else if (mode === 'stderr') child.stderr.write('private daemon detail');
    else if (mode === 'truncated') child.stdout.write('{"type":');
    else if (mode === 'overflow') child.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1));
    else child.stdout.write(JSON.stringify({ type: 'container', action: 'start', id: hex,
      time: '1', container: '', exitCode: '' }) + '\n');
    if (mode === 'success') { watch.assertLive(); await watch.stop(); assert.equal(journal.failure, null); }
    else await assert.rejects(watch.stop(), /INCOMPLETE/);
    assert.equal(closed, true);
  }
});
test('[actual execution interlock] valid manifests and caller toggles cannot start any work', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'operational-r8-interlock-'));
  const previousTemp = process.env.RUNNER_TEMP, previousSha = process.env.EXPECTED_CANDIDATE_SHA;
  const previousExit = process.exitCode, previousArgv = process.argv;
  const calls = { process: 0, fetch: 0, transport: 0, docker: 0, input: 0 };
  const blocked = () => {
    calls.process++;
    throw new Error('UNEXPECTED_PROCESS_START');
  };
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
    t.mock.method(childProcess, name, blocked);
  syncBuiltinESMExports();
  t.mock.method(CapturedTransport.prototype, 'run', () => { calls.transport++; throw new Error('UNEXPECTED_TRANSPORT'); });
  for (const name of ['prepare', 'create', 'execute'])
    t.mock.method(DockerAdapter.prototype, name, () => { calls.docker++; throw new Error('UNEXPECTED_DOCKER'); });
  t.mock.method(globalThis, 'fetch', () => { calls.fetch++; throw new Error('UNEXPECTED_NETWORK'); });
  try {
    for (const overrides of [{}, { kernelEvidence: true, r8Resolved: true, mode: 'model', nonce: hex }]) {
      const a = { ...approved(), ...overrides };
      assert.doesNotThrow(() => validateApprovalModel(a));
      assert.equal(admissionModel(a).candidateSha, commit);
      assert.throws(() => validateApproval(a), { message: 'ADMISSION_BLOCKED' });
      assert.throws(() => admit(admissionInput(a)), { message: 'ADMISSION_BLOCKED' });
      const input = admissionInput(a);
      const env = new Proxy({
        GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: commit, EXPECTED_CANDIDATE_SHA: commit,
        R65_EXPECTED_SHA: commit, OPERATIONAL_APPROVAL_DIGEST: input.approvalDigest,
        OPERATIONAL_APPROVAL_BYTES: String(input.approvalBytes.length),
        OPERATIONAL_APPROVAL_URL: `https://raw.githubusercontent.com/example/approval/${parent}/approval.json`,
        OPERATIONAL_R8_BYPASS: 'true', R8_EXECUTION_ALLOWED: 'true',
      }, { get(target, key) { calls.input++; return target[key]; } });
      await assert.rejects(runOperational({ env, output: join(directory, 'unused.json'),
        fetchImpl: () => { calls.fetch++; return Promise.resolve(new Response(input.approvalBytes)); } }),
      { message: 'ADMISSION_BLOCKED' });
    }
    await assert.rejects(runContainer(), { message: 'ADMISSION_BLOCKED' });
    await assert.rejects(finalize(), { message: 'ADMISSION_BLOCKED' });
    process.env.RUNNER_TEMP = directory;
    process.env.EXPECTED_CANDIDATE_SHA = commit;
    process.argv = [...previousArgv, '--r8-unlock', '--mode=model'];
    await import('./operational-launch.mjs');
    assert.equal(process.exitCode, 1);
    const report = JSON.parse(await readFile(join(directory, 'operational-public/result.json'), 'utf8'));
    assert.equal(report.failure, 'ADMISSION_BLOCKED');
    assert.equal(report.status, 'failed');
    assert.deepEqual(Object.keys(report).sort(), ['candidateDigest', 'failure', 'inventoryDigest',
      'manifestDigest', 'schemaVersion', 'stages', 'status']);
    assert.deepEqual(calls, { process: 0, fetch: 0, transport: 0, docker: 0, input: 0 });
  } finally {
    if (previousTemp === undefined) delete process.env.RUNNER_TEMP; else process.env.RUNNER_TEMP = previousTemp;
    if (previousSha === undefined) delete process.env.EXPECTED_CANDIDATE_SHA; else process.env.EXPECTED_CANDIDATE_SHA = previousSha;
    process.exitCode = previousExit; process.argv = previousArgv;
    t.mock.restoreAll(); syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
});
test('independent footprint admission reserves expansion, cache and build space rather than admitting a full-size source alone', () => {
  const a = approved();
  a.provision.artifacts = [{ kind: 'package', size: 8192, unpackedBytes: 16384 }];
  a.storage.footprint.provisionExpandedBytes = 16384;
  a.storage.footprint.npmCacheBytes = 8192;
  validateFootprint(a);
  for (const mutate of [
    p => { p.storage.footprint.sourceAllocatedBytes = 2147483648; },
    p => { p.storage.footprint.provisionExpandedBytes = 8192; },
    p => { p.storage.footprint.npmCacheBytes = 4096; },
    p => { p.storage.footprint.buildReserveBytes = 0; },
    p => { p.storage.footprint.sourceBytes = 1; },
  ]) {
    const changed = structuredClone(a); mutate(changed);
    assert.throws(() => validateFootprint(changed), /ADMISSION_BLOCKED/);
  }
});
test('effective kernel storage evidence requires RO root/proc, exact tmpfs ownership/caps and enforced no-swap cgroup limits', () => {
  const a = approved();
  const ro = ['/', '/source', '/provision', '/approval', '/sys', '/sys/fs/cgroup',
    '/etc/hosts', '/etc/hostname', '/etc/resolv.conf',
    '/proc/bus', '/proc/fs', '/proc/irq', '/proc/sys', '/proc/sysrq-trigger'];
  const rows = ro.map(path => [path, 'ro', path === '/sys/fs/cgroup' ? 'cgroup2' : 'ext4']);
  rows.push(['/proc', 'rw,nosuid,noexec,nodev', 'proc'], ['/dev', 'rw,nosuid', 'tmpfs'],
    ['/dev/pts', 'rw,nosuid,noexec', 'devpts'], ['/dev/mqueue', 'rw,nosuid,noexec,nodev', 'mqueue'],
    ['/work', 'rw,nosuid,nodev', 'tmpfs'], ['/home/node', 'rw,nosuid,nodev,noexec', 'tmpfs'],
    ['/tmp', 'rw,nosuid,nodev,noexec', 'tmpfs'], ['/dev/shm', 'rw,nosuid,nodev,noexec', 'tmpfs']);
  const evidence = {
    mountinfo: rows.map(([path, options, type], index) => `${index + 1} 0 0:0 / ${path} ${options} - ${type} source ${options}`).join('\n'),
    capEff: '0000000000000000', noNewPrivs: '1', seccomp: '2', cgroup: '0::/\n',
    memoryMax: '2684354560\n', swapMax: '0\n', pidsMax: '256\n', cpuMax: '100000 100000\n',
    dev: { uid: 0, gid: 0, mode: 0o755, bytes: 67108864 }, maskedNulls: [],
    filesystems: {
      '/work': { type: 0x01021994, bytes: 2147483648, uid: 1001, gid: 1001, mode: 0o700 },
      '/home/node': { type: 0x01021994, bytes: 67108864, uid: 1001, gid: 1001, mode: 0o700 },
      '/tmp': { type: 0x01021994, bytes: 268435456, uid: 1001, gid: 1001, mode: 0o700 },
      '/dev/shm': { type: 0x01021994, bytes: 268435456, uid: 0, gid: 0, mode: 0o1777 },
    },
  };
  validateKernelStorage(a, evidence);
  const collector = structuredClone(evidence);
  collector.mountinfo = rows.filter(([path]) => !['/tmp', '/dev/shm'].includes(path)).map(([path, options, type], index) =>
    `${index + 1} 0 0:0 / ${path} ${['/work', '/home/node'].includes(path) ? options.replace('rw', 'ro') : options} - ${type} source ${options}`).join('\n');
  delete collector.filesystems['/tmp']; delete collector.filesystems['/dev/shm'];
  validateKernelStorage(a, collector, 'collector');
  collector.mountinfo = collector.mountinfo.replace('/work ro', '/work rw');
  assert.throws(() => validateKernelStorage(a, collector, 'collector'), /ADMISSION_BLOCKED/);
  for (const mutate of [
    e => { e.mountinfo = e.mountinfo.replace(' / ro ', ' / rw '); },
    e => { e.mountinfo = e.mountinfo.replace('/proc/sys ro', '/proc/sys rw'); },
    e => { e.mountinfo += '\n99 0 0:0 / /escape rw - tmpfs tmpfs rw'; },
    e => { e.filesystems['/home/node'].bytes *= 2; },
    e => { e.filesystems['/work'].uid = 0; },
    e => { e.swapMax = '1'; }, e => { e.memoryMax = 'max'; },
    e => { e.pidsMax = '1024'; }, e => { e.cpuMax = '300000 100000'; },
    e => { e.noNewPrivs = '0'; }, e => { e.capEff = '0000000000000001'; },
  ]) {
    const changed = structuredClone(evidence); mutate(changed);
    assert.throws(() => validateKernelStorage(a, changed), /ADMISSION_BLOCKED/);
  }
});
