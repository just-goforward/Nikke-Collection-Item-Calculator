import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVICE_H14_NODE_VERSION = 'v26.13.1';
export const SERVICE_H14_NATIVE_FILE = 'src/serviceH14/generated/native.json';
export const SERVICE_H14_BUILD_FILE = 'src/serviceH14/generated/build.ts';
export const SERVICE_H14_PROFILE_ID = 'service-fused-h14-v1' as const;
export type ServiceH14Source = { path: string; sha256: string };
export const serviceH14Sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const rootFromModule = fileURLToPath(new URL('../', import.meta.url));

/** The real checkout containing these scripts; every command must run from exactly that directory. */
export function serviceH14Root(): string {
  const root = realpathSync(rootFromModule);
  if (realpathSync(process.cwd()) !== root) throw new Error('service_h14_checkout_root_cwd_required');
  return root;
}

/** Existing ancestors are checked too, so a missing output cannot escape via a symlink. */
export function serviceH14Path(root: string, path: string): string {
  const result = resolve(root, path);
  const inside = (value: string) => { const key = relative(root, value); return key !== '..' && !key.startsWith(`..${sep}`) && !isAbsolute(key); };
  if (!inside(result)) throw new Error(`service_h14_path_escape:${path}`);
  let ancestor = result;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (!inside(realpathSync(ancestor))) throw new Error(`service_h14_symlink_escape:${path}`);
  return result;
}

export function serviceH14Directory(root: string, path: string): string {
  const directory = serviceH14Path(root, path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

export function serviceH14Run(root = serviceH14Root()): string {
  const selected = process.env['SERVICE_H14_RUN'];
  if (!selected) throw new Error('service_h14_export_SERVICE_H14_RUN_required');
  const run = realpathSync(serviceH14Path(root, selected));
  if (dirname(run) !== resolve(root, '.artifacts') || !/^service-h14-run\.[A-Za-z0-9_-]+$/.test(basename(run)) || !statSync(run).isDirectory())
    throw new Error('service_h14_run_directory_required');
  return run;
}

/** Rust is deliberately absent: only the native stage resolves its pinned toolchain. */
export function serviceH14Environment(root = serviceH14Root(), run = serviceH14Run(root)): NodeJS.ProcessEnv {
  const tmp = serviceH14Directory(root, resolve(run, 'tmp'));
  return {
    HOME: homedir(), PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
    SERVICE_H14_RUN: run, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    NODE_COMPILE_CACHE: serviceH14Directory(root, resolve(run, 'node-cache')),
    SOLVER_A_VITE_CACHE_DIR: serviceH14Directory(root, resolve(run, 'vite-cache')),
    VITE_SERVICE_CERTIFIED_SOLVER: 'true', VITE_FORECAST_RUNTIME: 'bundled',
    VITE_FORECAST_PUBLIC_KEY_ID: '', VITE_FORECAST_PUBLIC_KEY_BASE64: '', VITE_FORECAST_TIMED_V1_PUBLIC_KEY_ID: '', VITE_FORECAST_TIMED_V1_PUBLIC_KEY_BASE64: '',
  };
}

/** The running executable is used for every child stage, so its exact version is the pin. */
export function assertServiceH14Node(): void {
  if (process.version !== SERVICE_H14_NODE_VERSION || process.release.name !== 'node' || !statSync(realpathSync(process.execPath)).isFile())
    throw new Error(`service_h14_node_${SERVICE_H14_NODE_VERSION}_required`);
}

/** Preview and UI checks share one loopback origin; SERVICE_H14_BASE_URL selects a non-default port (e.g. 4347). */
export function serviceH14BaseURL(selected = process.env['SERVICE_H14_BASE_URL'] ?? 'http://127.0.0.1:4330'): { origin: string; port: string } {
  const url = new URL(selected);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash)
    throw new Error('service_h14_loopback_test_url_required');
  return { origin: url.origin, port: url.port };
}
