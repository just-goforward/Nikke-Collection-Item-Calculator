import { open, readFile, lstat, statfs, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { exactKeys, fail } from './operational-policy.mjs';

export const PRODUCER_UID = 1001;
export const PAIR_MEMORY = 2684354560;
export const PRIVATE_ROOT = '/home/node/results';
export const FRAMEWORK_TMP = `${PRIVATE_ROOT}/tmp`;
export const READONLY_PROC = ['/proc/bus', '/proc/fs', '/proc/irq', '/proc/sys', '/proc/sysrq-trigger'];
export const MASKED_PROC = ['/proc/asound', '/proc/acpi', '/proc/interrupts', '/proc/kcore',
  '/proc/keys', '/proc/latency_stats', '/proc/timer_list', '/proc/timer_stats', '/proc/sched_debug',
  '/proc/scsi', '/sys/firmware', '/sys/devices/virtual/powercap'];
export function namedVolumeOptions(storage) {
  return {
    work: `rw,nosuid,nodev,exec,size=${storage.workspaceBytes},uid=1001,gid=1001,mode=0700`,
    framework: `rw,nosuid,nodev,noexec,size=${storage.frameworkBytes},uid=1001,gid=1001,mode=0700`,
  };
}
export function allocatedFootprint(files) {
  let bytes = 0;
  const directories = new Set();
  for (const file of files) {
    if (file.directory) directories.add(file.path);
    else bytes += Math.ceil(file.size / 4096) * 4096;
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
  }
  return bytes + directories.size * 4096;
}
export function validateFootprint(a) {
  const s = a.storage, f = s?.footprint;
  if (s?.backend !== 'named-tmpfs-pair-v1' || s.workspaceBytes !== 2147483648 ||
      s.frameworkBytes !== 67108864 || s.tmpBytes !== 268435456 || s.shmBytes !== 268435456) fail();
  exactKeys(s, ['backend', 'workspaceBytes', 'frameworkBytes', 'tmpBytes', 'shmBytes', 'footprint']);
  exactKeys(f, ['sourceBytes', 'sourceAllocatedBytes', 'provisionExpandedBytes', 'npmCacheBytes',
    'buildReserveBytes', 'metadataReserveBytes']);
  if (Object.values(f).some(n => !Number.isSafeInteger(n) || n < 0) ||
      f.sourceBytes !== a.source.files.reduce((sum, file) => sum + file.size, 0) ||
      f.sourceAllocatedBytes < allocatedFootprint(a.source.files) ||
      f.buildReserveBytes <= 0 || f.metadataReserveBytes <= 0) fail();
  let expanded = 0, cache = 0;
  for (const artifact of a.provision.artifacts) {
    if (!Number.isSafeInteger(artifact.unpackedBytes) || artifact.unpackedBytes <= 0 ||
        artifact.unpackedBytes > s.workspaceBytes) fail();
    expanded += artifact.unpackedBytes;
    if (artifact.kind === 'package') cache += artifact.size;
  }
  if (f.provisionExpandedBytes < expanded || f.npmCacheBytes < cache ||
      f.sourceAllocatedBytes + f.provisionExpandedBytes + f.npmCacheBytes +
      f.buildReserveBytes + f.metadataReserveBytes > s.workspaceBytes) fail();
  return f;
}
export function parseMounts(text) {
  return text.trim().split('\n').map(line => {
    const [left, right] = line.split(' - '), fields = left.split(' ');
    if (!right || fields.length < 6 || /\\/.test(fields[4])) fail();
    return { path: fields[4], options: fields[5].split(','), type: right.split(' ')[0] };
  });
}
export function validateKernelStorage(a, evidence, role = 'producer') {
  if (!['producer', 'collector'].includes(role)) fail();
  const collector = role === 'collector';
  const mounts = parseMounts(evidence.mountinfo);
  const byPath = new Map();
  for (const m of mounts) {
    if (byPath.has(m.path)) fail();
    byPath.set(m.path, m);
  }
  const readOnly = ['/', '/source', '/provision', '/approval', '/sys', '/sys/fs/cgroup',
    '/etc/hosts', '/etc/hostname', '/etc/resolv.conf', ...READONLY_PROC];
  for (const path of readOnly) if (!byPath.get(path)?.options.includes('ro')) fail();
  if (byPath.get('/proc')?.type !== 'proc' || byPath.get('/sys/fs/cgroup')?.type !== 'cgroup2' ||
      evidence.cgroup.trim() !== '0::/' || evidence.memoryMax.trim() !== String(PAIR_MEMORY) ||
      evidence.swapMax.trim() !== '0' || evidence.pidsMax.trim() !== '256' ||
      !/^0+$/.test(evidence.capEff) || evidence.noNewPrivs !== '1' || evidence.seccomp !== '2') fail();
  const cpu = evidence.cpuMax.trim().split(/\s+/).map(Number);
  if (cpu.length !== 2 || !cpu.every(n => Number.isSafeInteger(n) && n > 0) || cpu[0] !== cpu[1]) fail();
  const expected = { '/work': a.storage.workspaceBytes, '/home/node': a.storage.frameworkBytes,
    ...(!collector ? { '/tmp': a.storage.tmpBytes, '/dev/shm': a.storage.shmBytes } : {}) };
  for (const [path, size] of Object.entries(expected)) {
    const m = byPath.get(path), stat = evidence.filesystems[path];
    if (!m || m.type !== 'tmpfs' || !m.options.includes(collector ? 'ro' : 'rw') || !m.options.includes('nosuid') ||
        !m.options.includes('nodev') || (path === '/work' ? m.options.includes('noexec') : !m.options.includes('noexec')) ||
        !stat || stat.type !== 0x01021994 || stat.bytes !== size ||
        stat.uid !== (path === '/dev/shm' ? 0 : PRODUCER_UID) ||
        stat.gid !== (path === '/dev/shm' ? 0 : PRODUCER_UID) ||
        stat.mode !== (path === '/dev/shm' ? 0o1777 : 0o700)) fail();
  }
  const pseudo = { '/dev': 'tmpfs', '/dev/pts': 'devpts', '/dev/mqueue': 'mqueue', '/proc': 'proc' };
  for (const [path, type] of Object.entries(pseudo)) if (byPath.get(path)?.type !== type) fail();
  if (evidence.dev.uid !== 0 || evidence.dev.gid !== 0 || evidence.dev.mode !== 0o755 ||
      evidence.dev.bytes > 67108864) fail();
  const allowed = new Set([...readOnly, ...Object.keys(expected), ...Object.keys(pseudo)]);
  for (const m of mounts) {
    if (allowed.has(m.path)) continue;
    if (m.path === '/sbin/docker-init' && m.options.includes('ro')) continue;
    if (MASKED_PROC.includes(m.path) || /^\/sys\/devices\/system\/cpu\/cpu[0-9]+\/thermal_throttle$/.test(m.path)) {
      if (m.options.includes('ro') || evidence.maskedNulls.includes(m.path)) continue;
    }
    fail();
  }
}
async function filesystem(path) {
  const [fs, st] = await Promise.all([statfs(path), lstat(path)]);
  if (!st.isDirectory() || st.isSymbolicLink()) fail();
  return { type: Number(fs.type), bytes: Number(fs.bsize) * Number(fs.blocks),
    uid: st.uid, gid: st.gid, mode: st.mode & 0o7777 };
}
export async function verifyStorage(a, role = 'producer') {
  if (process.platform !== 'linux' || process.getuid() !== PRODUCER_UID || process.getgid() !== PRODUCER_UID) fail();
  const mountinfo = await readFile('/proc/self/mountinfo', 'utf8');
  const status = await readFile('/proc/self/status', 'utf8');
  const value = key => new RegExp(`^${key}:\\s*(\\S+)`, 'm').exec(status)?.[1];
  const evidence = { mountinfo, capEff: value('CapEff'), noNewPrivs: value('NoNewPrivs'),
    seccomp: value('Seccomp'), cgroup: await readFile('/proc/self/cgroup', 'utf8'),
    memoryMax: await readFile('/sys/fs/cgroup/memory.max', 'utf8'),
    swapMax: await readFile('/sys/fs/cgroup/memory.swap.max', 'utf8'),
    pidsMax: await readFile('/sys/fs/cgroup/pids.max', 'utf8'),
    cpuMax: await readFile('/sys/fs/cgroup/cpu.max', 'utf8'), filesystems: {}, maskedNulls: [],
    dev: await filesystem('/dev') };
  for (const path of role === 'collector' ? ['/work', '/home/node'] : ['/work', '/home/node', '/tmp', '/dev/shm'])
    evidence.filesystems[path] = await filesystem(path);
  const nullDevice = await lstat('/dev/null');
  for (const m of parseMounts(mountinfo).filter(m => MASKED_PROC.includes(m.path) && !m.options.includes('ro'))) {
    const st = await lstat(m.path);
    if (st.isCharacterDevice() && st.rdev === nullDevice.rdev && st.uid === 0 && st.gid === 0) evidence.maskedNulls.push(m.path);
  }
  validateKernelStorage(a, evidence, role);
  // Effective read-only enforcement, not merely an inspect/configuration claim.
  try {
    const fd = await open('/operational-root-write-probe', 'wx', 0o600);
    await fd.close(); await unlink('/operational-root-write-probe'); fail();
  } catch (error) {
    // Non-root permission checks may precede EROFS. The kernel mount table
    // above must independently report the root and protected proc mounts RO.
    if (!['EROFS', 'EACCES'].includes(error.code)) throw error;
  }
  if (role === 'collector') for (const root of ['/work', '/home/node']) {
    try {
      const fd = await open(`${root}/operational-collector-write-probe`, 'wx', 0o600);
      await fd.close(); await unlink(`${root}/operational-collector-write-probe`); fail();
    } catch (error) { if (error.code !== 'EROFS') throw error; }
  }
}
export async function allocatedTree(root) {
  let bytes = 0;
  const inodes = new Set();
  async function walk(path) {
    const st = await lstat(path);
    const key = `${st.dev}:${st.ino}`;
    if (inodes.has(key)) return;
    inodes.add(key);
    bytes += Number(st.blocks) * 512;
    if (bytes > 2147483648) fail('OVERFLOW');
    if (st.isDirectory() && !st.isSymbolicLink()) for (const name of await readdir(path)) await walk(join(path, name));
    else if (!st.isFile() && !st.isSymbolicLink()) fail();
  }
  await walk(root);
  return bytes;
}
export async function verifyWorkspace(a, built = false) {
  const f = validateFootprint(a);
  if (await allocatedTree('/work/cache') > f.npmCacheBytes ||
      await allocatedTree('/work') > f.sourceAllocatedBytes + f.provisionExpandedBytes +
      f.npmCacheBytes + f.metadataReserveBytes + (built ? f.buildReserveBytes : 0)) fail('OVERFLOW');
}
