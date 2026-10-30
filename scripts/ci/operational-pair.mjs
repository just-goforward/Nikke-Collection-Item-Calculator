import { randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { cleanEnvironment, fail, HEX, EXECUTION_STAGES, SUITE_STAGES, STAGES,
  sealedCommand, trustedNodeCommand, assertSealed } from './operational-policy.mjs';
import { READONLY_PROC, PAIR_MEMORY, namedVolumeOptions } from './operational-storage.mjs';
import { RECEIPT_LIMIT, FINALIZER_EXIT } from './operational-receipt.mjs';
import { checkRuntimeMetadata, checkContainerInitialization, verifyHostRuntimeBinaries } from './operational-runtime-profile.mjs';
import { LifecycleJournal, watchLifecycle, EVENT_FORMAT } from './operational-events.mjs';
import { waitForContainerExit } from './operational-engine-wait.mjs';

function mount(path) {
  if (!isAbsolute(path) || /[,\r\n\0]/.test(path)) fail();
  return path;
}
const sameOptions = (a, b) => typeof a === 'string' && a.split(',').sort().join(',') === b.split(',').sort().join(',');
const officialReference = value => {
  const match = /^(?:docker\.io\/)?(?:library\/)?node@sha256:([a-f0-9]{64})$/.exec(value);
  return match ? `docker.io/library/node@sha256:${match[1]}` : null;
};
export function pairContainerArguments(a, { role, paths, nonce, volumes, hostNamespace, manifestDigest }) {
  if (!['producer', 'collector'].includes(role) || !HEX.test(nonce) || !HEX.test(manifestDigest) ||
      !/^net:\[\d+\]$/.test(hostNamespace)) fail();
  const collector = role === 'collector';
  const env = { ...cleanEnvironment(a.candidateSha), OPERATIONAL_APPROVAL_DIGEST: manifestDigest,
    OPERATIONAL_NONCE: nonce, OPERATIONAL_HOST_NAMESPACE: hostNamespace,
    OPERATIONAL_NODE_INVENTORY_DIGEST: a.nodeInventoryDigest,
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '', NODE_OPTIONS: '' };
  return ['create', '--pull=never', '--platform=linux/amd64', '--runtime=runc',
    '--name', `operational-${nonce}-${role}`, '--label', `operational.owner=${nonce}`,
    '--label', `operational.role=${role}`, '--network=none', collector ? '--ipc=none' : '--ipc=private',
    '--cgroupns=private', '--init', '--read-only', '--no-healthcheck', '--restart=no',
    '--user=1001:1001', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--security-opt', `seccomp=${mount(paths.seccomp)}`, '--cpus=1',
    `--memory=${PAIR_MEMORY}`, `--memory-swap=${PAIR_MEMORY}`, '--pids-limit=256', '--log-driver=none',
    ...(!collector ? ['--shm-size', String(a.storage.shmBytes), '--tmpfs',
      `/tmp:rw,nosuid,nodev,noexec,size=${a.storage.tmpBytes},uid=1001,gid=1001,mode=0700`] : []),
    ...Object.entries({ work: '/work', framework: '/home/node' }).flatMap(([key, target]) =>
      ['--mount', `type=volume,src=${volumes[key]},dst=${target},volume-nocopy${collector ? ',readonly' : ''}`]),
    ...Object.entries({ source: '/source', provision: '/provision', approval: '/approval' }).flatMap(([key, target]) =>
      ['--mount', `type=bind,src=${mount(paths[key])},dst=${target},readonly`]),
    ...Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    '--workdir=/source', '--entrypoint=/usr/local/bin/node', a.image,
    '/source/scripts/ci/operational-container.mjs', collector ? 'hold' : 'keep'];
}

// One producer and one RO collector, one lifetime each. No restart, replacement,
// retry, cgroup-budget reuse, host payload population or in-container PID scan.
export class DockerAdapter {
  #ids = {};
  #intents = new Map();
  #imageId;
  #ownedVolumes = new Set();
  #starts = {};
  #reaped = new Set();
  #removed = new Set();
  #watches = [];
  #journal;
  #runtimeIdentity;
  #created = false;
  #executed = false;
  #closing;
  #complete = false;
  #receipt;
  #failure;
  #stages = [];
  #phaseDeadline;
  #setup = { durationMs: 0, status: 'incomplete' };
  constructor({ transport, executable = '/usr/bin/docker', environment, approval, paths,
    nonce = randomBytes(32).toString('hex'), hostNamespace, deadline, manifestDigest,
    watchFactory = watchLifecycle, verifyBinaries = verifyHostRuntimeBinaries, waitForExit = waitForContainerExit }) {
    if (!HEX.test(nonce)) fail();
    Object.assign(this, { transport, executable, environment, approval, paths, nonce, hostNamespace,
      deadline, manifestDigest, watchFactory, verifyBinaries, waitForExit });
    this.volumes = Object.freeze({ work: `operational-${nonce}-work`, framework: `operational-${nonce}-framework` });
  }
  get stages() { return this.#stages.map(stage => ({ ...stage })); }
  get failure() { return this.#failure ?? null; }
  get setupResult() { return { ...this.#setup }; }
  // These remain reserved even after producer exit, until every job resource is removed.
  get reservedMemoryBytes() { return this.#complete ? 0 : 2 * PAIR_MEMORY; }
  async #run(stage, args, options = {}) {
    const remaining = (this.#phaseDeadline ?? this.deadline) - Date.now();
    if (remaining <= 0) fail('TIMEOUT');
    return this.transport.run(stage, this.executable, args, { env: this.environment, ...options,
      durationMs: Math.min(options.durationMs ?? 60000, remaining) });
  }
  async #json(args, { stage = 'S15', limit = 256 * 1024 } = {}) {
    return JSON.parse((await this.#run(stage, args, {
      responseLimit: limit, durationMs: 10000, cleanup: stage === 'S15',
    })).toString('utf8'));
  }
  async #runtime() {
    const version = await this.#json(['version', '--format', '{{json .}}'], { stage: 'S02' });
    const info = await this.#json(['info', '--format', '{{json .}}'], { stage: 'S02' });
    await this.verifyBinaries(this.approval.runtime);
    return checkRuntimeMetadata(this.approval.runtime, version, info);
  }
  async prepare() {
    if (this.#runtimeIdentity !== undefined) fail();
    this.#phaseDeadline = Math.min(this.deadline - 120000, Date.now() + 300000);
    this.#runtimeIdentity = await this.#runtime();
    // Only a preloaded independently pinned image is admitted. Pulls could
    // allocate payload in the daemon outside the two approved cgroups.
    const image = (await this.#json(['image', 'inspect', this.approval.image], { stage: 'S02' }))[0];
    if (image.Os !== 'linux' || image.Architecture !== 'amd64' ||
        !/^sha256:[a-f0-9]{64}$/.test(image.Id ?? '') ||
        (image.Config?.Volumes && Object.keys(image.Config.Volumes).length) ||
        Object.keys(image.Config?.Labels ?? {}).some(key => /^(?:io\.containerd|io\.kubernetes)\./.test(key)) ||
        !image.RepoDigests?.some(ref => officialReference(ref) === this.approval.image)) fail();
    this.#imageId = image.Id;
  }
  #intent(type, role, name, contract) {
    const key = `${type}:${role}`;
    if (this.#intents.has(key)) fail('INCOMPLETE');
    const intent = { type, role, name, owner: this.nonce,
      contract: Object.freeze(contract), phase: 'pending' };
    // A lost create response cannot erase the obligation to reconcile this
    // exact intent. Absence alone does not terminate an unknown daemon create.
    this.#intents.set(key, intent);
    return intent;
  }
  #checkVolume(volume, intent) {
    if (volume?.Name !== intent.name || volume.Driver !== 'local' || volume.Scope !== 'local' ||
        volume.Labels?.['operational.owner'] !== intent.owner || volume.Labels?.['operational.role'] !== intent.role ||
        volume.Options?.type !== 'tmpfs' || volume.Options?.device !== 'tmpfs' ||
        !sameOptions(volume.Options?.o, intent.contract.options) ||
        Object.keys(volume.Options).sort().join(',') !== 'device,o,type') fail();
  }
  #acquireVolume(volume, intent) {
    this.#checkVolume(volume, intent);
    this.#ownedVolumes.add(intent.name);
    intent.phase = 'owned';
  }
  async #volume(key) {
    const name = this.volumes[key], options = namedVolumeOptions(this.approval.storage)[key];
    const existing = await this.#run('S03', ['volume', 'ls', '--filter', `name=^${name}$`, '--format', '{{.Name}}'],
      { responseLimit: 4096, durationMs: 10000 });
    if (existing.toString().trim()) fail();
    const intent = this.#intent('volume', key, name, { options });
    const created = await this.#run('S03', ['volume', 'create', '--driver=local',
      '--label', `operational.owner=${this.nonce}`, '--label', `operational.role=${key}`,
      '--opt=type=tmpfs', '--opt=device=tmpfs', '--opt', `o=${options}`, name],
    { responseLimit: 256, durationMs: 10000 });
    if (created.toString().trim() !== name) fail('INCOMPLETE');
    const volume = (await this.#json(['volume', 'inspect', name]))[0];
    this.#acquireVolume(volume, intent);
  }
  async inspect(role, full = false) {
    const id = this.#ids[role];
    if (!HEX.test(id ?? '')) fail('INCOMPLETE');
    const result = await this.#json(full ? ['inspect', id] :
      ['inspect', '--format', '{"Id":{{json .Id}},"State":{{json .State}},"RestartCount":{{json .RestartCount}}}', id],
    { limit: full ? 256 * 1024 : 8192 });
    const value = full ? result[0] : result;
    if (value.Id !== id || value.RestartCount !== 0 || value.State.Restarting) fail('INCOMPLETE');
    return value;
  }
  async #container(role, signal) {
    const name = `operational-${this.nonce}-${role}`;
    const existing = await this.#run('S03', ['ps', '--all', '--no-trunc', '--filter',
      `name=^/${name}$`, '--format', '{{.ID}}'], { signal, responseLimit: 4096, durationMs: 10000 });
    if (existing.toString().trim()) fail();
    const intent = this.#intent('container', role, name, {
      image: this.#imageId, imageReference: this.approval.image,
      paths: Object.freeze({ ...this.paths }), tmpBytes: this.approval.storage.tmpBytes,
      shmBytes: this.approval.storage.shmBytes,
    });
    const response = await this.#run('S03', pairContainerArguments(this.approval, {
      role, paths: this.paths, nonce: this.nonce, volumes: this.volumes,
      hostNamespace: this.hostNamespace, manifestDigest: this.manifestDigest,
    }), { signal, responseLimit: 128 });
    const id = response.toString().trim();
    if (!HEX.test(id) || Object.values(this.#ids).includes(id)) fail('INCOMPLETE');
    const value = (await this.#json(['inspect', id]))[0];
    if (value?.Id !== id) fail('INCOMPLETE');
    this.#acquireContainer(value, intent);
  }
  #acquireContainer(value, intent) {
    const { role, contract } = intent, h = value?.HostConfig, collector = role === 'collector';
    checkContainerInitialization(value);
    if (!HEX.test(value?.Id ?? '') || Object.values(this.#ids).includes(value.Id) ||
        value.Name !== `/${intent.name}` || value.Image !== contract.image ||
        value.RestartCount !== 0 || value.State?.Restarting ||
        value.Config?.Image !== contract.imageReference ||
        JSON.stringify(value.Config.Entrypoint) !== JSON.stringify(['/usr/local/bin/node']) ||
        JSON.stringify(value.Config.Cmd) !== JSON.stringify(['/source/scripts/ci/operational-container.mjs', collector ? 'hold' : 'keep']) ||
        value.Config.User !== '1001:1001' || value.Config.Labels?.['operational.owner'] !== intent.owner ||
        value.Config.Labels?.['operational.role'] !== role ||
        Object.keys(value.Config.Labels).some(key => /^(?:io\.containerd|io\.kubernetes)\./.test(key)) ||
        h.Runtime !== 'runc' || h.NetworkMode !== 'none' || h.IpcMode !== (collector ? 'none' : 'private') ||
        h.CgroupnsMode !== 'private' || h.PidMode || h.Privileged || h.ReadonlyRootfs !== true ||
        h.Init !== true || h.RestartPolicy?.Name !== 'no' || h.CapDrop?.join(',') !== 'ALL' || h.CapAdd?.length ||
        value.Config.Healthcheck?.Test?.join(',') !== 'NONE' || h.Memory !== PAIR_MEMORY ||
        h.MemorySwap !== PAIR_MEMORY || h.NanoCpus !== 1000000000 || h.PidsLimit !== 256 ||
        !READONLY_PROC.every(path => h.ReadonlyPaths?.includes(path)) ||
        !h.SecurityOpt?.includes('no-new-privileges') || !h.SecurityOpt?.some(v => v.startsWith('seccomp=')) ||
        h.Binds?.length || h.Devices?.length || Object.keys(h.PortBindings ?? {}).length ||
        Object.keys(value.Config.Volumes ?? {}).length) fail();
    const tmpfs = h.Tmpfs ?? {};
    if (collector ? Object.keys(tmpfs).length !== 0 :
      Object.keys(tmpfs).join(',') !== '/tmp' ||
      !sameOptions(tmpfs['/tmp'], `rw,nosuid,nodev,noexec,size=${contract.tmpBytes},uid=1001,gid=1001,mode=0700`) ||
      h.ShmSize !== contract.shmBytes) fail();
    const configured = value.Mounts.filter(m => m.Type !== 'tmpfs');
    if (configured.length !== 5 || h.Mounts.length !== 5 ||
        value.Mounts.some(m => m.Type === 'tmpfs' && (collector || m.Destination !== '/tmp'))) fail();
    for (const [key, target] of Object.entries({ work: '/work', framework: '/home/node' })) {
      const actual = value.Mounts.find(m => m.Destination === target);
      const requested = h.Mounts.find(m => m.Target === target);
      if (actual?.Type !== 'volume' || actual.Name !== this.volumes[key] || actual.Driver !== 'local' ||
          actual.RW !== !collector || requested?.VolumeOptions?.NoCopy !== true ||
          (requested.ReadOnly !== undefined && typeof requested.ReadOnly !== 'boolean') ||
          (requested.ReadOnly === true) !== collector || requested.Source !== this.volumes[key]) fail();
    }
    for (const [key, target] of Object.entries({ source: '/source', provision: '/provision', approval: '/approval' })) {
      const m = value.Mounts.find(item => item.Destination === target);
      if (m?.Type !== 'bind' || m.RW !== false || m.Source !== contract.paths[key]) fail();
    }
    this.#ids[role] = value.Id;
    intent.phase = 'owned';
  }
  async #reconcilePending() {
    let incomplete = false;
    for (const intent of this.#intents.values()) {
      if (intent.phase !== 'pending') continue;
      try {
        const value = (await this.#json(intent.type === 'volume'
          ? ['volume', 'inspect', intent.name] : ['inspect', intent.name]))[0];
        if (intent.type === 'volume') this.#acquireVolume(value, intent);
        else this.#acquireContainer(value, intent);
      } catch {
        // This includes absent responses: a timed-out create may still be
        // running in the daemon. Do not mark it absent or retry creation.
        incomplete = true;
      }
    }
    return incomplete;
  }
  async create(signal) {
    if (this.#created || !this.#runtimeIdentity) fail();
    this.#created = true;
    const begin = Date.now();
    this.#setup.status = 'failed';
    this.#phaseDeadline = Math.min(this.deadline - 120000, begin + 720000);
    try {
    for (const key of ['work', 'framework']) await this.#volume(key);
    await this.#container('collector', signal);
    await this.#container('producer', signal);
    this.#journal = new LifecycleJournal(this.#ids, this.volumes);
    if (!this.transport.started.has('S15')) {
      this.transport.ledger.begin('S15'); this.transport.started.add('S15');
    }
    const since = new Date().toISOString();
    for (const type of ['container', 'volume']) {
      const filters = type === 'container'
        ? [...Object.values(this.#ids).map(id => `container=${id}`),
          ...['start', 'die', 'destroy', 'oom', 'restart', 'pause', 'unpause', 'kill', 'stop'].map(event => `event=${event}`)]
        : [...Object.values(this.volumes).map(name => `volume=${name}`),
          ...['mount', 'unmount', 'destroy'].map(event => `event=${event}`)];
      this.#watches.push(this.watchFactory({ executable: this.executable,
        args: ['events', '--since', since, '--filter', `type=${type}`,
          ...filters.flatMap(filter => ['--filter', filter]), '--format', EVENT_FORMAT],
        env: this.environment, ledger: this.transport.ledger, journal: this.#journal, deadline: this.deadline }));
    }
    await this.#start('collector', signal);
    await this.#journal.until(() => this.#journal.holderContinuous(), Math.min(this.deadline, Date.now() + 10000));
    await this.#start('producer', signal);
    this.#setup.status = 'passed';
    } finally { this.#setup.durationMs = Date.now() - begin; }
  }
  async #start(role, signal) {
    if (this.#starts[role]) fail();
    await this.#run('S04', ['start', this.#ids[role]], { signal });
    const { State: state } = await this.inspect(role);
    if (!state.Running || state.Status !== 'running' || !state.StartedAt || state.Pid <= 0) fail('INCOMPLETE');
    this.#starts[role] = state.StartedAt;
  }
  #live() {
    for (const watch of this.#watches) watch.assertLive();
    if (this.#journal?.failure) fail('INCOMPLETE');
  }
  async #holder() {
    this.#live();
    const { State: state } = await this.inspect('collector');
    if (!this.#journal.holderContinuous() || !state.Running ||
        state.StartedAt !== this.#starts.collector || state.OOMKilled) fail('INCOMPLETE');
  }
  async #reap(role, strict) {
    if (this.#reaped.has(role)) return;
    const id = this.#ids[role];
    if (!id) return;
    if (strict && !(await this.inspect(role)).State.Running) fail('INCOMPLETE');
    this.#journal?.expectStop(role);
    const wait = this.waitForExit({ id, ledger: this.transport.ledger,
      deadline: Math.min(this.deadline, this.#phaseDeadline) });
    wait.catch(() => {});
    try {
      if ((await this.inspect(role)).State.Running)
        await this.#run('S15', ['stop', '--time=5', id], { cleanup: true, durationMs: 10000 });
    } catch {
      await this.#run('S15', ['kill', id], { cleanup: true, durationMs: 10000 });
      if (strict) this.#failure ??= 'INCOMPLETE';
    }
    const exitCode = await wait, { State: state } = await this.inspect(role);
    if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) fail('INCOMPLETE');
    if (state.Running || state.Status !== 'exited' || state.Pid !== 0 ||
        state.StartedAt !== this.#starts[role] || state.ExitCode !== exitCode) fail('INCOMPLETE');
    if (strict) {
      this.#live();
      await this.#journal.until(() => this.#journal.exited(role, exitCode),
        Math.min(this.deadline, Date.now() + 10000));
      if (exitCode !== 0 || state.OOMKilled || state.Error) fail('INCOMPLETE');
      if (role === 'producer') await this.#holder();
    }
    this.#reaped.add(role);
  }
  async execute(signal) {
    if (this.#executed || !this.#starts.producer) fail();
    this.#executed = true;
    const context = { node: '/usr/local/bin/node', root: '/work/repo', platform: 'linux',
      npmCli: '/work/npm/package/bin/npm-cli.js' };
    for (const id of EXECUTION_STAGES) {
      if (this.#failure) { this.#stages.push({ id, durationMs: 0, passed: 0, status: 'incomplete' }); continue; }
      const begin = Date.now();
      this.#phaseDeadline = Math.min(this.deadline - 120000, begin + STAGES[id] * 60000);
      let status = 'passed';
      try {
        await this.#holder();
        if (id === 'S14') {
          // Source chain: shim Wait4 reaps namespace init -> init TaskExit ->
          // Moby handleContainerExit/SetStopped -> ContainerWait and die event.
          // Single-incarnation private PID namespaces are mandatory; no JSON
          // field or a State.Running=false observation substitutes for this chain.
          await this.#reap('producer', true);
          if (await this.#runtime() !== this.#runtimeIdentity) fail('INCOMPLETE');
        } else if (this.#reaped.has('producer') || !(await this.inspect('producer')).State.Running) fail('INCOMPLETE');
        const trusted = ['S04', 'S05', 'S14'].includes(id);
        const command = trusted ? trustedNodeCommand(id, context) : sealedCommand(id, context);
        assertSealed(command);
        const role = id === 'S14' ? 'collector' : 'producer';
        if (role === 'collector' && !this.#reaped.has('producer')) fail('INCOMPLETE');
        const env = { ...cleanEnvironment(this.approval.candidateSha, { install: id === 'S05' }),
          OPERATIONAL_APPROVAL_DIGEST: this.manifestDigest, OPERATIONAL_NONCE: this.nonce,
          OPERATIONAL_HOST_NAMESPACE: this.hostNamespace,
          OPERATIONAL_NODE_INVENTORY_DIGEST: this.approval.nodeInventoryDigest,
          OPERATIONAL_NODE_SUITE: SUITE_STAGES[id] ?? '', NODE_OPTIONS: '' };
        const bytes = await this.#run(id, ['exec', '--user=1001:1001', '--workdir',
          trusted ? '/source' : '/work/repo', ...Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
          this.#ids[role], command.executable,
          ...(trusted ? command.args : ['/source/scripts/ci/operational-container.mjs', 'stage', id])],
        { durationMs: command.durationMs, signal, terminate: () => this.#reap(role, false),
          responseLimit: id === 'S14' ? RECEIPT_LIMIT : 0,
          failureCodes: Object.fromEntries(Object.entries(FINALIZER_EXIT).map(([code, exit]) => [exit, code])) });
        if (id === 'S14') this.#receipt = bytes;
        await this.#holder();
      } catch (error) {
        status = 'failed';
        this.#failure ??= Object.hasOwn(FINALIZER_EXIT, error.message) ? error.message : 'INCOMPLETE';
      }
      this.#stages.push({ id, durationMs: Date.now() - begin, passed: 0, status });
    }
    if (this.#failure) fail(this.#failure);
  }
  async #removeContainer(role) {
    const id = this.#ids[role];
    if (!id || this.#removed.has(id)) return;
    let force = false;
    try { force = (await this.inspect(role)).State.Running; } catch { force = true; }
    if (force) this.#failure ??= 'INCOMPLETE';
    await this.#run('S15', ['rm', ...(force ? ['--force'] : []), id], { cleanup: true, durationMs: 10000 });
    const present = await this.#run('S15', ['ps', '--all', '--no-trunc', '--filter', `id=${id}`, '--format', '{{.ID}}'],
      { cleanup: true, responseLimit: 4096, durationMs: 10000 });
    if (present.toString().trim()) fail('INCOMPLETE');
    this.#removed.add(id);
    this.#intents.get(`container:${role}`).phase = 'removed';
  }
  async close() {
    this.#closing ??= (async () => {
      this.#phaseDeadline = Math.min(this.deadline, Date.now() + 120000);
      let failed = await this.#reconcilePending();
      for (const role of ['producer', 'collector']) {
        if (this.#ids[role]) {
          try {
            if (!this.#starts[role]) {
              const { State: state } = await this.inspect(role);
              if (state.Running || state.Status === 'exited') {
                // A lost start response is cleanup-only identity, never a fence.
                this.#failure ??= 'INCOMPLETE';
                this.#starts[role] = state.StartedAt;
              }
            }
            if (this.#starts[role]) await this.#reap(role, !this.#failure);
          } catch {
            failed = true;
            try { await this.#run('S15', ['kill', this.#ids[role]], { cleanup: true, durationMs: 10000 }); }
            catch { /* Removal is still attempted for this exact owned ID. */ }
          }
        }
        try { await this.#removeContainer(role); } catch { failed = true; }
      }
      for (const name of this.#ownedVolumes) {
        try {
          const intent = [...this.#intents.values()].find(item => item.type === 'volume' && item.name === name);
          this.#checkVolume((await this.#json(['volume', 'inspect', name]))[0], intent);
          await this.#run('S15', ['volume', 'rm', name], { cleanup: true, durationMs: 10000 });
          const present = await this.#run('S15', ['volume', 'ls', '--filter', `name=^${name}$`, '--format', '{{.Name}}'],
            { cleanup: true, responseLimit: 4096, durationMs: 10000 });
          if (present.toString().trim()) fail('INCOMPLETE');
          intent.phase = 'removed';
        } catch { failed = true; }
      }
      if (!failed && !this.#failure && this.#journal) {
        try {
          await this.#journal.until(() =>
            Object.values(this.#ids).every(id => this.#journal.matches('container', id, 'destroy').length === 1) &&
            Object.values(this.volumes).every(id => this.#journal.matches('volume', id, 'destroy').length === 1),
          Math.min(this.deadline, Date.now() + 10000));
          if (await this.#runtime() !== this.#runtimeIdentity) fail('INCOMPLETE');
        } catch { failed = true; }
      }
      for (const watcher of this.#watches) {
        try { await watcher.stop(); } catch { failed = true; }
      }
      if (failed || [...this.#intents.values()].some(intent => intent.phase !== 'removed') ||
          this.#removed.size !== Object.keys(this.#ids).length) fail('INCOMPLETE');
      this.#complete = true;
    })();
    return this.#closing;
  }
  async collect() {
    if (!this.#complete || this.#failure || this.#reaped.size !== 2 ||
        this.#removed.size !== 2 || !Buffer.isBuffer(this.#receipt)) fail('INCOMPLETE');
    return this.#receipt;
  }
}
