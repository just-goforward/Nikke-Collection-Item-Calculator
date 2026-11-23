import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { assertFusedModule } from '../src/serviceH14/fusedModule.ts';
import { SERVICE_H14_NATIVE_FILE, SERVICE_H14_PROFILE_ID, serviceH14Path, serviceH14Sha256, type ServiceH14Source } from './service-h14-paths.ts';

export type ServiceH14Native = {
  schemaVersion: 1; profileId: typeof SERVICE_H14_PROFILE_ID;
  abi: { base: 1; fused: 3; joint: 2; currentBatch: 2 };
  sourceHash: string; sources: ServiceH14Source[];
  wasm: { sha256: string; byteLength: number; assetPath: string };
  toolchain: { rust: '1.99.1'; node: '26.13.1'; target: 'wasm32-unknown-unknown'; profile: 'release'; offline: true; locked: true };
};

export function serviceH14Sources(root: string, paths: Iterable<string>): ServiceH14Source[] {
  return [...new Set(paths)].sort().map(path => ({ path, sha256: serviceH14Sha256(readFileSync(serviceH14Path(root, path))) }));
}

export function serviceH14NativeSources(root: string): ServiceH14Source[] {
  const paths = ['scripts/service-h14-native-build.ts', 'scripts/service-h14-native-integrity.ts', 'scripts/service-h14-paths.ts',
    'src/serviceH14/fusedModule.ts', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];
  const crate = serviceH14Path(root, 'rust/service-h14');
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'target') continue;
      const path = serviceH14Path(root, resolve(directory, entry.name));
      if (entry.isSymbolicLink()) throw new Error('service_h14_native_symlink');
      if (entry.isDirectory()) visit(path);
      else {
        if (!statSync(path).isFile()) throw new Error('service_h14_native_nonfile');
        paths.push(relative(root, path).replaceAll('\\', '/'));
        if (/\.(?:rs|toml)$/.test(path)) {
          const text = readFileSync(path, 'utf8');
          if (/(?:\.artifacts|local-h14|C:\\|\/Users\/)/.test(text)) throw new Error(`service_h14_native_donor_reference:${path}`);
          if (/include(?:_str|_bytes)?!\s*\(\s*[^"\s]/.test(text))
            throw new Error('service_h14_computed_native_include');
          for (const match of text.matchAll(/(?:include(?:_str|_bytes)?!\s*\(\s*|#\[path\s*=\s*)"([^"]+)"/g)) {
            const target = serviceH14Path(root, resolve(dirname(path), match[1]!));
            if (!target.startsWith(`${crate}/`) || !statSync(target).isFile()) throw new Error('service_h14_external_native_include');
          }
          if (/\bpath\s*=\s*"/.test(text) && path.endsWith('.toml')) throw new Error('service_h14_native_path_dependency');
        }
      }
    }
  };
  visit(crate);
  return serviceH14Sources(root, paths);
}

export function readServiceH14Native(root: string): ServiceH14Native {
  const value = JSON.parse(readFileSync(serviceH14Path(root, SERVICE_H14_NATIVE_FILE), 'utf8')) as ServiceH14Native;
  if (value.schemaVersion !== 1 || value.profileId !== SERVICE_H14_PROFILE_ID ||
      value.abi?.base !== 1 || value.abi.fused !== 3 || value.abi.joint !== 2 || value.abi.currentBatch !== 2 ||
      !Array.isArray(value.sources) || value.sources.length === 0 ||
      value.sourceHash !== serviceH14Sha256(JSON.stringify(value.sources)) ||
      !/^[a-f0-9]{64}$/.test(value.wasm?.sha256) ||
      value.wasm.assetPath !== `/wasm/service-fused-h14-${value.wasm.sha256}.wasm` ||
      !Number.isSafeInteger(value.wasm.byteLength) || value.wasm.byteLength <= 0 || value.wasm.byteLength > 32 * 1024 * 1024 ||
      JSON.stringify(value.toolchain) !== JSON.stringify({ rust: '1.99.1', node: '26.13.1', target: 'wasm32-unknown-unknown', profile: 'release', offline: true, locked: true }))
    throw new Error('service_h14_native_metadata_invalid');
  return value;
}

/** Build-time only: read actual version functions, not a claimed JSON ABI. */
export async function assertServiceH14NativeAbi(bytes: Uint8Array): Promise<void> {
  const module = await WebAssembly.compile(new Uint8Array(bytes));
  assertFusedModule(module);
  const instance = new WebAssembly.Instance(module, { certified: { now_ms: () => performance.now() } });
  for (const [name, expected] of [['certified_abi_version', 1], ['certified_fused_version', 3], ['certified_joint_version', 2], ['certified_current_batch_version', 2]] as const) {
    const fn = instance.exports[name];
    if (typeof fn !== 'function' || fn() !== expected) throw new Error(`service_h14_native_abi_mismatch:${name}`);
  }
}

export async function assertServiceH14Native(root: string): Promise<ServiceH14Native> {
  const native = readServiceH14Native(root);
  if (JSON.stringify(serviceH14NativeSources(root)) !== JSON.stringify(native.sources)) throw new Error('service_h14_native_sources_stale');
  const bytes = readFileSync(serviceH14Path(root, `public${native.wasm.assetPath}`));
  if (bytes.byteLength !== native.wasm.byteLength || serviceH14Sha256(bytes) !== native.wasm.sha256) throw new Error('service_h14_native_asset_mismatch');
  await assertServiceH14NativeAbi(bytes);
  return native;
}
