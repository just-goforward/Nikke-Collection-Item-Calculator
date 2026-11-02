import { open, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fail, HEX, exactKeys } from './operational-policy.mjs';

// A source-auditable candidate, NOT execution approval or Linux verification.
// The unconditional R8 entrypoint interlock remains authoritative.
export const RUNTIME_PROFILE = 'moby-28.0.4-containerd-1.7.27-runc-1.2.6-private-pid-v1';
export const RUNTIME_SOURCES = Object.freeze([
  'https://github.com/torvalds/linux/blob/v7.0/kernel/pid_namespace.c',
  'https://github.com/containerd/containerd/blob/v1.7.27/sys/reaper/reaper_unix.go',
  'https://github.com/containerd/containerd/blob/v1.7.27/runtime/v2/runc/task/service.go',
  'https://github.com/moby/moby/blob/v28.0.4/libcontainerd/remote/client.go',
  'https://github.com/moby/moby/blob/v28.0.4/daemon/monitor.go',
  'https://github.com/moby/moby/blob/v28.0.4/container/state.go',
  'https://github.com/moby/moby/blob/v28.0.4/volume/local/local.go',
  'https://github.com/moby/moby/blob/v28.0.4/daemon/volumes_unix.go',
  'https://github.com/moby/moby/blob/v28.0.4/container/container.go',
  'https://github.com/moby/moby/blob/v28.0.4/client/container_wait.go',
  'https://github.com/docker/cli/blob/v28.0.4/cli/command/system/events.go',
  'https://github.com/moby/moby/blob/v28.0.4/api/types/container/hostconfig.go',
  'https://github.com/moby/moby/blob/v28.0.4/daemon/info.go',
  'https://github.com/moby/moby/blob/v28.0.4/daemon/daemon.go',
  'https://github.com/moby/moby/blob/v28.0.4/daemon/oci_linux.go',
  'https://github.com/moby/moby/blob/v28.0.4/daemon/inspect.go',
  'https://github.com/moby/moby/blob/v28.0.4/daemon/images/service.go',
  'https://github.com/moby/moby/blob/v28.0.4/daemon/containerd/service.go',
  'https://github.com/moby/moby/blob/v28.0.4/daemon/graphdriver/overlay2/overlay.go',
  'https://github.com/moby/moby/blob/v28.0.4/daemon/graphdriver/overlayutils/userxattr.go',
  'https://github.com/moby/moby/blob/v28.0.4/pkg/parsers/kernel/kernel_unix.go',
  'https://github.com/moby/moby/blob/v28.0.4/vendor/github.com/containerd/containerd/v2/client/container.go',
  'https://github.com/moby/moby/blob/v28.0.4/vendor/github.com/containerd/containerd/v2/pkg/oci/spec_opts.go',
  'https://github.com/containerd/containerd/blob/v1.7.27/runtime/v2/runc/manager/manager_linux.go',
]);
const binaries = Object.freeze({
  dockerd: '/usr/bin/dockerd', containerd: '/usr/bin/containerd',
  shim: '/usr/bin/containerd-shim-runc-v2', runc: '/usr/bin/runc',
});
export function validateRuntimePins(pins) {
  exactKeys(pins, ['profile', 'kernelVersion', 'commits', 'binaries']);
  exactKeys(pins.commits, ['engine', 'containerd', 'runc']);
  exactKeys(pins.binaries, Object.keys(binaries));
  if (pins.profile !== RUNTIME_PROFILE || !/^7\.0\.0(?:-[A-Za-z0-9.-]+)?$/.test(pins.kernelVersion) ||
      !/^[a-f0-9]{7,40}$/.test(pins.commits.engine) ||
      !/^[a-f0-9]{7,40}$/.test(pins.commits.containerd) ||
      !/^(?:[a-f0-9]{7,40}|v1\.2\.6-0-g[a-f0-9]{7,40})$/.test(pins.commits.runc) ||
      Object.values(pins.binaries).some(value => !HEX.test(value))) fail();
}
export function checkRuntimeMetadata(pins, version, info) {
  validateRuntimePins(pins);
  // v28.0.4 exposes the active image service here, not merely its configured
  // feature flag. Its snapshotter service always emits "driver-type".
  const driverKeys = ['Backing Filesystem', 'Supports d_type', 'Using metacopy', 'Native Overlay Diff', 'userxattr'];
  if (info.Driver !== 'overlay2' || !Array.isArray(info.DriverStatus) ||
      info.DriverStatus.length !== driverKeys.length ||
      info.DriverStatus.some(row => !Array.isArray(row) || row.length !== 2 ||
        row.some(value => typeof value !== 'string')) ||
      new Set(info.DriverStatus.map(([key]) => key)).size !== driverKeys.length ||
      info.DriverStatus.some(([key]) => !driverKeys.includes(key))) fail();
  const driver = Object.fromEntries(info.DriverStatus);
  // With the already-pinned Linux 7 kernel, NeedsUserXAttr is true in a daemon
  // user namespace, including rootful-in-rootless without name=rootless.
  if (!driver['Backing Filesystem'] || driver['Supports d_type'] !== 'true' || driver.userxattr !== 'false' ||
      !['true', 'false'].includes(driver['Using metacopy']) ||
      !['true', 'false'].includes(driver['Native Overlay Diff'])) fail();
  const security = new Set(['name=apparmor', 'name=seccomp,profile=builtin', 'name=selinux',
    'name=cgroupns', 'name=no-new-privileges']);
  if (!Array.isArray(info.SecurityOptions) ||
      info.SecurityOptions.some(option => !security.has(option)) ||
      new Set(info.SecurityOptions).size !== info.SecurityOptions.length) fail();
  const components = new Map(version.Server?.Components?.map(c => [c.Name, c]));
  if (version.Client?.Version !== '28.0.4' || version.Server?.Version !== '28.0.4' ||
      version.Server?.Os !== 'linux' || version.Server?.Arch !== 'amd64' ||
      version.Server?.GitCommit !== pins.commits.engine ||
      components.get('containerd')?.Version !== '1.7.27' ||
      components.get('containerd')?.Details?.GitCommit !== pins.commits.containerd ||
      components.get('runc')?.Version !== '1.2.6' ||
      components.get('runc')?.Details?.GitCommit !== pins.commits.runc ||
      info.KernelVersion !== pins.kernelVersion || info.CgroupVersion !== '2' ||
      info.DefaultRuntime !== 'runc' || info.LiveRestoreEnabled !== false ||
      info.MemoryLimit !== true || info.SwapLimit !== true || info.PidsLimit !== true ||
      info.Warnings?.length ||
      !['runc', '/usr/bin/runc'].includes(info.Runtimes?.runc?.path) ||
      info.Runtimes.runc.runtimeArgs?.length || typeof info.ID !== 'string' || !info.ID) fail();
  return JSON.stringify({ server: version.Server, client: version.Client.Version,
    daemon: info.ID, kernel: info.KernelVersion, runtime: info.Runtimes.runc,
    driver: info.Driver, driverStatus: driver, securityOptions: [...info.SecurityOptions].sort() });
}
export function checkContainerInitialization(value) {
  const h = value?.HostConfig;
  // The API map is omitempty; nil (absent/null) and an empty map all contribute
  // no entries to OCI WithAnnotations. Labels are not this annotation source.
  if (!h || (h.Annotations != null && (typeof h.Annotations !== 'object' ||
      Array.isArray(h.Annotations) || Object.keys(h.Annotations).length !== 0)) ||
      !['', 'host'].includes(h.UsernsMode) || value.Driver !== 'overlay2' ||
      value.GraphDriver?.Name !== 'overlay2') fail();
  const data = value.GraphDriver.Data;
  // Inspect returns before populating Data on the snapshotter branch.
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      Object.keys(data).some(key => !['WorkDir', 'MergedDir', 'UpperDir', 'LowerDir'].includes(key)) ||
      ['WorkDir', 'MergedDir', 'UpperDir'].some(key => typeof data[key] !== 'string' || !data[key].startsWith('/')) ||
      (data.LowerDir !== undefined && (typeof data.LowerDir !== 'string' || !data.LowerDir.startsWith('/')))) fail();
}
export async function verifyHostRuntimeBinaries(pins) {
  validateRuntimePins(pins);
  for (const [name, path] of Object.entries(binaries)) {
    if (await realpath(path) !== path || (await lstat(path)).isSymbolicLink()) fail();
    const fd = await open(path, 'r');
    try {
      const before = await fd.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > 256 * 1024 * 1024) fail();
      const hash = createHash('sha256'), buffer = Buffer.alloc(65536);
      let size = 0;
      for (;;) {
        const { bytesRead } = await fd.read(buffer);
        if (!bytesRead) break;
        size += bytesRead; if (size > before.size) fail();
        hash.update(buffer.subarray(0, bytesRead));
      }
      const after = await fd.stat();
      if (size !== before.size || after.ctimeMs !== before.ctimeMs || after.mtimeMs !== before.mtimeMs ||
          hash.digest('hex') !== pins.binaries[name]) fail();
    } finally { await fd.close(); }
  }
}
