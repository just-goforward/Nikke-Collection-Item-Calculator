import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DockerAdapter } from './operational-pair.mjs';
import { CaptureLedger } from './operational-results.mjs';

// Synthetic Engine boundary only. These records are not Linux/kernel evidence.
export function createPairModel(a, receipt, flags = {}) {
  const nonce = 'a'.repeat(64), calls = [];
  const ids = { producer: 'e'.repeat(64), collector: 'f'.repeat(64) };
  const volumes = { work: `operational-${nonce}-work`, framework: `operational-${nonce}-framework` };
  const paths = { source: resolve(tmpdir(), 'source'), provision: resolve(tmpdir(), 'packages'),
    approval: resolve(tmpdir(), 'approval'), seccomp: resolve(tmpdir(), 'seccomp.json') };
  const state = {}, volumeState = {}, waits = {}, deferredCreates = [];
  const volumeInspections = {};
  let journal, stamp = 1, disconnected = false, collectorReads = 0;
  const opts = {
    work: 'rw,nosuid,nodev,exec,size=2147483648,uid=1001,gid=1001,mode=0700',
    framework: 'rw,nosuid,nodev,noexec,size=67108864,uid=1001,gid=1001,mode=0700',
  };
  function event(type, id, action, container = '', exitCode = '') {
    journal?.accept({ type, id, action, container, exitCode, time: String(stamp++) });
  }
  function stopped(role) {
    state[role].status = 'exited';
    for (const volume of Object.values(volumes)) event('volume', volume, 'unmount', ids[role]);
    if (flags.missingReapEvent && role === 'producer') journal.reject();
    else event('container', ids[role], 'die', '', flags.badExit && role === 'producer' ? '137' : '0');
    waits[role]?.(flags.badExit && role === 'producer' ? 137 : 0);
  }
  function inspect(role) {
    const collector = role === 'collector', current = state[role];
    const mountPoints = [
      ...Object.entries({ work: '/work', framework: '/home/node' }).map(([key, target]) => ({
        Type: 'volume', Name: volumes[key], Driver: 'local', Destination: target, RW: !collector,
      })),
      ...Object.entries({ source: '/source', provision: '/provision', approval: '/approval' }).map(([key, target]) => ({
        Type: 'bind', Source: paths[key], Destination: target, RW: key === 'source' && !!flags.badMount,
      })),
      ...(flags.extraMount ? [{ Type: 'volume', Name: 'foreign', Destination: '/foreign', RW: true }] : []),
    ];
    return {
      Id: ids[role], Name: `/operational-${nonce}-${role}`, Image: `sha256:${'d'.repeat(64)}`,
      Driver: 'overlay2', GraphDriver: { Name: 'overlay2', Data: {
        WorkDir: '/model/overlay2/work', MergedDir: '/model/overlay2/merged', UpperDir: '/model/overlay2/diff' } },
      RestartCount: flags.restart && role === 'producer' ? 1 : 0,
      Config: { User: '1001:1001', Volumes: {}, Healthcheck: { Test: ['NONE'] }, Image: a.image,
        Entrypoint: ['/usr/local/bin/node'], Cmd: ['/source/scripts/ci/operational-container.mjs', collector ? 'hold' : 'keep'],
        Labels: { 'operational.owner': flags.foreignPendingContainer ? '0'.repeat(64) : nonce, 'operational.role': role } },
      HostConfig: {
        Runtime: 'runc', NetworkMode: 'none', IpcMode: collector ? 'none' : 'private', UsernsMode: '',
        CgroupnsMode: 'private', ReadonlyRootfs: !flags.badRoot, Init: true,
        RestartPolicy: { Name: 'no' }, CapDrop: ['ALL'], Memory: 2684354560,
        MemorySwap: 2684354560, NanoCpus: 1000000000, PidsLimit: 256,
        ShmSize: collector ? 0 : 268435456,
        ReadonlyPaths: ['/proc/bus', '/proc/fs', '/proc/irq', '/proc/sys', '/proc/sysrq-trigger'],
        SecurityOpt: ['no-new-privileges', 'seccomp=approved-profile'],
        Tmpfs: collector ? {} : {
          '/tmp': `rw,nosuid,nodev,noexec,size=${flags.wrongCap ? 536870912 : 268435456},uid=1001,gid=1001,mode=0700`,
        },
        Mounts: mountPoints.map(m => m.Type === 'volume' ? {
          Type: 'volume', Source: m.Name, Target: m.Destination, ReadOnly: collector,
          VolumeOptions: { NoCopy: !flags.copyUp },
        } : { Type: 'bind', Source: m.Source, Target: m.Destination, ReadOnly: true }),
        ...flags.hostConfig,
      },
      Mounts: mountPoints,
      State: { Running: current.status === 'running', Status: current.status, Restarting: false,
        Pid: current.status === 'running' ? (collector ? 100 : 101) : 0,
        StartedAt: current.startedAt, ExitCode: flags.badExit && role === 'producer' ? 137 : 0,
        OOMKilled: !!flags.badExit && role === 'producer', Error: '' },
      ...flags.containerMetadata,
    };
  }
  const transport = {
    ledger: new CaptureLedger({ reserveCleanup: true }), started: new Set(),
    async run(stage, _executable, args, options = {}) {
      calls.push({ stage, args, options });
      const role = Object.keys(ids).find(key => args.includes(ids[key]) || args.includes(`operational-${nonce}-${key}`));
      if (args[0] === 'version') return Buffer.from(JSON.stringify({
        Client: { Version: '28.0.4' },
        Server: { Version: flags.unknownRuntime ? '0.0.0' : '28.0.4', Os: 'linux', Arch: 'amd64',
          GitCommit: a.runtime.commits.engine, Components: [
            { Name: 'containerd', Version: '1.7.27', Details: { GitCommit: a.runtime.commits.containerd } },
            { Name: 'runc', Version: '1.2.6', Details: { GitCommit: a.runtime.commits.runc } },
          ] },
      }));
      if (args[0] === 'info') return Buffer.from(JSON.stringify({
        ID: 'MODEL-DAEMON', KernelVersion: a.runtime.kernelVersion, CgroupVersion: '2',
        DefaultRuntime: 'runc', LiveRestoreEnabled: false, MemoryLimit: true, SwapLimit: true, PidsLimit: true,
        Warnings: [], SecurityOptions: [], Runtimes: { runc: { path: 'runc' } },
        Driver: 'overlay2', DriverStatus: [
          ['Backing Filesystem', 'extfs'], ['Supports d_type', 'true'], ['Using metacopy', 'false'],
          ['Native Overlay Diff', 'true'], ['userxattr', 'false'],
        ],
        ...flags.daemonInfo,
      }));
      if (args[0] === 'image') return Buffer.from(JSON.stringify([{
        Id: `sha256:${'d'.repeat(64)}`, Os: 'linux', Architecture: 'amd64',
        Config: { Volumes: flags.imageVolume ? { '/data': {} } : {}, Labels: {} },
        RepoDigests: [a.image.replace('docker.io/library/', '')],
      }]));
      if (args[0] === 'volume') {
        const name = args.at(-1);
        if (args[1] === 'ls') {
          const filter = args.find(value => value.startsWith('name='));
          const target = filter.slice(6, -1);
          return Buffer.from(flags.preexisting || volumeState[target] ? target : '');
        }
        if (args[1] === 'create') {
          volumeState[name] = true;
          if (flags.lostVolumeAck && name === volumes.work) throw new Error('INCOMPLETE');
          return Buffer.from(name);
        }
        if (args[1] === 'inspect') {
          if (!volumeState[name]) throw new Error('INCOMPLETE');
          volumeInspections[name] = (volumeInspections[name] ?? 0) + 1;
          if (flags.volumeInspectFailure && name === volumes.framework && volumeInspections[name] === 1)
            throw new Error('INCOMPLETE');
          const key = Object.keys(volumes).find(k => volumes[k] === name);
          return Buffer.from(JSON.stringify([{ Name: name, Driver: 'local', Scope: 'local',
            Labels: { 'operational.owner': flags.foreignPendingVolume && name === volumes.framework ? '0'.repeat(64) : nonce,
              'operational.role': key },
            Options: { type: 'tmpfs', device: 'tmpfs', o: opts[key] } }]));
        }
        if (args[1] === 'rm') {
          if (flags.volumeCleanupFailure || Object.values(state).some(s => s.status !== 'removed')) throw new Error('INCOMPLETE');
          delete volumeState[name]; event('volume', name, 'destroy'); return Buffer.alloc(0);
        }
      }
      if (args[0] === 'create') {
        const target = args.includes(`operational.role=collector`) ? 'collector' : 'producer';
        assert.equal(state[target], undefined);
        if (flags.unknownPendingContainer) {
          deferredCreates.push(() => { state[target] = { status: 'created', startedAt: '' }; });
          throw new Error('INCOMPLETE');
        }
        state[target] = { status: 'created', startedAt: '' };
        if (flags.lostContainerAck || flags.foreignPendingContainer) throw new Error('INCOMPLETE');
        if (flags.truncatedContainerAck) return Buffer.from(ids[target].slice(0, 12));
        return Buffer.from(ids[target]);
      }
      if (args[0] === 'inspect') {
        if (!state[role]) throw new Error('INCOMPLETE');
        const details = inspect(role);
        return Buffer.from(JSON.stringify(args.includes('--format')
          ? { Id: details.Id, State: details.State, RestartCount: details.RestartCount } : [details]));
      }
      if (args[0] === 'start') {
        assert.equal(state[role].status, 'created');
        state[role] = { status: 'running', startedAt: `2026-10-31T00:00:0${role === 'producer' ? 2 : 1}Z` };
        for (const volume of Object.values(volumes)) event('volume', volume, 'mount', ids[role]);
        event('container', ids[role], 'start'); return Buffer.from(ids[role]);
      }
      if (args[0] === 'exec') {
        assert.equal(state[role].status, 'running');
        if (role === 'collector') {
          collectorReads++;
          assert.equal(state.producer.status, 'exited');
          assert.ok(calls.some(c => c.args[0] === 'API_WAIT' && c.args[1] === ids.producer));
          assert.deepEqual(args.slice(args.indexOf(ids.collector) + 1),
            ['/usr/local/bin/node', '/source/scripts/ci/operational-finalizer.mjs']);
          if (flags.reportFailure) throw new Error(flags.reportFailure);
          if (flags.missingReceipt) return Buffer.alloc(0);
          return flags.extraReceipt ? Buffer.concat([receipt, receipt]) : receipt;
        }
        if (flags.cancel) { await options.terminate(); throw new Error('CANCELLED'); }
        if (flags.executionFailure && stage === 'S06') throw new Error('TEST_FAILED');
        if (flags.holderLoss && stage === 'S06') stopped('collector');
        if (flags.daemonRestart && stage === 'S06') { disconnected = true; journal.reject(); }
        if (flags.earlyExit && stage === 'S06') stopped('producer');
        if (flags.duplicateMount && stage === 'S06') event('volume', volumes.work, 'mount', ids.collector);
        assert.equal(options.responseLimit, 0);
        return flags.appInjection ? receipt : Buffer.alloc(0);
      }
      if (args[0] === 'stop' || args[0] === 'kill') { stopped(role); return Buffer.alloc(0); }
      if (args[0] === 'rm') {
        assert.notEqual(state[role].status, 'running');
        if (flags.cleanupFailure) throw new Error('INCOMPLETE');
        state[role].status = 'removed'; event('container', ids[role], 'destroy'); return Buffer.alloc(0);
      }
      if (args[0] === 'ps') {
        if (args.some(value => value.startsWith('name=')))
          return Buffer.from(flags.preexistingContainer ? '1'.repeat(64) : '');
        return Buffer.from(flags.survivor ? ids.producer : '');
      }
      assert.fail(`Unexpected model operation ${args[0]}`);
    },
  };
  const adapter = new DockerAdapter({ transport, approval: a, nonce, paths, hostNamespace: 'net:[123]',
    deadline: Date.now() + 600000, manifestDigest: nonce, verifyBinaries: async () => {},
    waitForExit: async ({ id }) => {
      const role = Object.keys(ids).find(key => ids[key] === id);
      calls.push({ stage: 'S15', args: ['API_WAIT', id], options: {} });
      if (flags.waitFailure && role === 'producer') throw new Error('INCOMPLETE');
      if (state[role].status === 'exited') return flags.badExit && role === 'producer' ? 137 : 0;
      return new Promise(resolve => { waits[role] = resolve; });
    },
    watchFactory: options => {
      journal = options.journal;
      return {
        assertLive() { if (disconnected || journal.failure) throw new Error('INCOMPLETE'); },
        async stop() { if (journal.failure) throw new Error('INCOMPLETE'); },
      };
    },
  });
  return { adapter, calls, ids, volumes, paths, state, volumeState,
    finishPendingCreates: () => { for (const create of deferredCreates.splice(0)) create(); },
    collectorReads: () => collectorReads,
    allRemoved: () => Object.values(state).every(s => s.status === 'removed') && Object.keys(volumeState).length === 0 };
}
