import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertServiceH14NativeAbi, serviceH14NativeSources, type ServiceH14Native } from './service-h14-native-integrity.ts';
import { assertServiceH14Node, SERVICE_H14_NATIVE_FILE, serviceH14Directory, serviceH14Environment, serviceH14Path, serviceH14Root, serviceH14Run, serviceH14Sha256 } from './service-h14-paths.ts';

export const SERVICE_H14_RUST_TOOLCHAIN = '1.99.1';

/** Standard rustup install locations: $CARGO_HOME/bin, ~/.cargo/bin, then the caller's PATH. */
function serviceH14Rustup(): string {
  const cargoHome = process.env['CARGO_HOME'];
  const directories = [...(cargoHome && isAbsolute(cargoHome) ? [join(cargoHome, 'bin')] : []), join(homedir(), '.cargo', 'bin'),
    ...(process.env['PATH'] ?? '').split(delimiter).filter(directory => isAbsolute(directory))];
  for (const directory of directories) {
    const candidate = join(directory, 'rustup');
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error('service_h14_rustup_required');
}

/** Resolves real toolchain binaries once; cargo is then run directly, never through a rustup proxy. */
function serviceH14RustToolchain(root: string): { rustup: string; rustc: string; cargo: string; bin: string } {
  const rustup = serviceH14Rustup();
  const env: NodeJS.ProcessEnv = { HOME: homedir(), PATH: ['/usr/bin', '/bin'].join(delimiter), RUSTUP_AUTO_INSTALL: '0',
    ...(process.env['RUSTUP_HOME'] ? { RUSTUP_HOME: process.env['RUSTUP_HOME'] } : {}) };
  const which = (tool: 'rustc' | 'cargo') => {
    const result = spawnSync(rustup, ['which', '--toolchain', SERVICE_H14_RUST_TOOLCHAIN, tool], { cwd: root, env, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
    const path = result.stdout?.trim() ?? '';
    if (result.error || result.status !== 0 || !isAbsolute(path) || !existsSync(path) || !statSync(path).isFile())
      throw new Error(`service_h14_rust_${SERVICE_H14_RUST_TOOLCHAIN}_toolchain_missing:${tool}`, { cause: result.error ?? result.stderr });
    return realpathSync(path);
  };
  const rustc = which('rustc'), cargo = which('cargo');
  if (dirname(rustc) !== dirname(cargo)) throw new Error('service_h14_rust_toolchain_split');
  return { rustup, rustc, cargo, bin: dirname(rustc) };
}

/** Offline registry cache: caller-supplied absolute CARGO_HOME, else the standard ~/.cargo. */
function serviceH14CargoHome(): string {
  const supplied = process.env['CARGO_HOME'];
  if (supplied !== undefined && !isAbsolute(supplied)) throw new Error('service_h14_cargo_home_absolute_required');
  const cargoHome = supplied ?? join(homedir(), '.cargo');
  if (!existsSync(cargoHome) || !statSync(cargoHome).isDirectory()) throw new Error('service_h14_offline_cargo_home_missing');
  return realpathSync(cargoHome);
}

export async function buildServiceH14Native(): Promise<void> {
  assertServiceH14Node();
  const root = serviceH14Root(), run = serviceH14Run(root);
  const cargoHome = serviceH14CargoHome(), toolchain = serviceH14RustToolchain(root);
  const attempt = mkdtempSync(resolve(run, 'native-build.'));
  writeFileSync(resolve(attempt, 'toolchain.json'), JSON.stringify({ channel: SERVICE_H14_RUST_TOOLCHAIN, ...toolchain, cargoHome }), { flag: 'wx', mode: 0o600 });
  // Approved exception: ovnfs/NFS targets returned stale rlib handles. Only this
  // invocation-owned physical directory may live outside the candidate/RUN.
  const target = mkdtempSync(join(realpathSync('/tmp'), 'service-h14-native-target.'));
  chmodSync(target, 0o700);
  writeFileSync(resolve(attempt, 'target.json'), JSON.stringify({ path: target, owner: 'this-invocation', storage: 'physical-system-tmp', retainOnFailure: true }), { flag: 'wx', mode: 0o600 });
  const base = serviceH14Environment(root, run);
  // Registry and checkout locations would otherwise be embedded in panic
  // locations; the last matching remap wins, so CARGO_HOME follows the root.
  const remap = [`--remap-path-prefix=${root}=/checkout`, `--remap-path-prefix=${cargoHome}=/cargo-home`];
  const env = { ...base, PATH: [toolchain.bin, base['PATH']].join(delimiter), RUSTC: toolchain.rustc, RUSTUP_TOOLCHAIN: SERVICE_H14_RUST_TOOLCHAIN,
    CARGO_HOME: cargoHome, CARGO_TARGET_DIR: target, CARGO_ENCODED_RUSTFLAGS: remap.join('\x1f') };
  const rustVersion = spawnSync(toolchain.rustc, ['--version', '--verbose'], { cwd: root, env, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  writeFileSync(resolve(attempt, 'rustc-version.json'), JSON.stringify({ stdout: rustVersion.stdout, stderr: rustVersion.stderr, status: rustVersion.status, error: rustVersion.error?.message ?? null }), { flag: 'wx', mode: 0o600 });
  if (rustVersion.error || rustVersion.status !== 0 || !/^rustc 1\.99\.1(?:\s|$)/.test(rustVersion.stdout))
    throw new Error('service_h14_installed_rust_version_mismatch');
  const sources = serviceH14NativeSources(root);
  const args = ['build', '--manifest-path', 'rust/service-h14/Cargo.toml', '--offline', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '--lib', '-j1'];
  writeFileSync(resolve(attempt, 'command.json'), JSON.stringify({ executable: toolchain.cargo, args, cwd: root, env }, null, 2), { flag: 'wx', mode: 0o600 });
  const stdout = openSync(resolve(attempt, 'cargo.stdout'), 'wx', 0o600), stderr = openSync(resolve(attempt, 'cargo.stderr'), 'wx', 0o600);
  let result;
  try { result = spawnSync(toolchain.cargo, args, { cwd: root, env, stdio: ['ignore', stdout, stderr], timeout: 240000 }); }
  finally { closeSync(stdout); closeSync(stderr); }
  writeFileSync(resolve(attempt, 'cargo-exit.json'), JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message ?? null }), { flag: 'wx', mode: 0o600 });
  if (result.error || result.status !== 0) throw new Error(`service_h14_native_build_failed:${attempt}`, { cause: result.error });
  if (JSON.stringify(serviceH14NativeSources(root)) !== JSON.stringify(sources)) throw new Error('service_h14_native_sources_changed_during_build');
  const artifact = realpathSync(resolve(target, 'wasm32-unknown-unknown/release/certified_wasm.wasm'));
  if (!artifact.startsWith(`${target}/`)) throw new Error('service_h14_native_target_artifact_escape');
  const bytes = readFileSync(artifact);
  for (const prefix of [root, cargoHome])
    if (bytes.includes(Buffer.from(prefix))) throw new Error('service_h14_native_machine_path_embedded');
  await assertServiceH14NativeAbi(bytes);
  const sha256 = serviceH14Sha256(bytes);
  if (bytes.byteLength <= 0 || bytes.byteLength > 32 * 1024 * 1024) throw new Error('service_h14_native_asset_size');
  const wasm = { sha256, byteLength: bytes.byteLength, assetPath: `/wasm/service-fused-h14-${sha256}.wasm` };
  const preservedWasm = resolve(attempt, `service-fused-h14-${sha256}.wasm`);
  writeFileSync(preservedWasm, bytes, { flag: 'wx', mode: 0o600 });
  const destination = serviceH14Path(root, `public${wasm.assetPath}`);
  serviceH14Directory(root, dirname(destination));
  if (existsSync(destination)) {
    if (!readFileSync(destination).equals(bytes)) throw new Error('service_h14_native_content_address_collision');
  } else writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
  const native: ServiceH14Native = {
    schemaVersion: 1, profileId: 'service-fused-h14-v1', abi: { base: 1, fused: 3, joint: 2, currentBatch: 2 },
    sourceHash: serviceH14Sha256(JSON.stringify(sources)), sources, wasm,
    toolchain: { rust: '1.99.1', node: '26.13.1', target: 'wasm32-unknown-unknown', profile: 'release', offline: true, locked: true },
  };
  const metadata = serviceH14Path(root, SERVICE_H14_NATIVE_FILE);
  serviceH14Directory(root, dirname(metadata));
  if (existsSync(metadata)) writeFileSync(resolve(attempt, 'previous-native.json'), readFileSync(metadata), { flag: 'wx', mode: 0o600 });
  const temporary = resolve(attempt, 'native.json');
  writeFileSync(temporary, JSON.stringify(native, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(temporary, metadata);
  const receipt = { status: 'NONDEPLOYABLE_SERVICE_NATIVE_CANDIDATE', native, preservedWasm,
    temporaryTarget: { path: target, cleanup: 'after-validated-preservation' }, oldWasmRebuilt: false, forecastAuthorityChanged: false, publicationApproved: false };
  writeFileSync(resolve(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 });
  // No finally cleanup: compilation/validation/preservation failures retain the
  // physical target. This exact invocation-created path is never caller supplied.
  rmSync(target, { recursive: true });
  writeFileSync(resolve(attempt, 'cleanup.json'), JSON.stringify({ path: target, removed: true }), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ attempt, ...receipt, temporaryTargetRemoved: true }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('service_h14_native_build_unknown_arguments');
  await buildServiceH14Native();
}
