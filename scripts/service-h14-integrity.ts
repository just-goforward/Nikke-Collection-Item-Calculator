import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, type Plugin as EsbuildPlugin } from 'esbuild';
import type { Plugin } from 'vite';
import { assertCertifiedEngineBuild } from './certified-engine-build.ts';
import { assertServiceH14Native, serviceH14Sources, type ServiceH14Native } from './service-h14-native-integrity.ts';
import { SERVICE_H14_BUILD_FILE, SERVICE_H14_NATIVE_FILE, SERVICE_H14_PROFILE_ID, serviceH14Path, serviceH14Root, serviceH14Sha256, type ServiceH14Source } from './service-h14-paths.ts';
import { bindServiceH14LazyImportGraph, SERVICE_H14_LAZY_IMPORTS, SERVICE_H14_RETRY_POLICY } from './service-h14-lazy-imports.ts';
import { portablePath,portablePins } from '../src/serviceH14/portablePins.ts';

export type ServiceH14Build = {
  schemaVersion: 1; policy: 'adaptive-next-batch-balanced-v1'; profileId: typeof SERVICE_H14_PROFILE_ID; codeHash: string;
  nativeSourceHash: string; exactWasmHash: string; sourceManifest: ServiceH14Source[];
};
const tools = ['scripts/build-root-candidate.mjs','scripts/root-candidate.vite.config.ts','scripts/root-conditional-target.json','scripts/build-preview-only.mjs','scripts/service-h14-build.ts', 'scripts/service-h14-native-build.ts', 'scripts/service-h14-native-integrity.ts',
  'preview-gateway/trust.json', 'site-worker/production-forecast.proposed.json',
  'scripts/service-h14-integrity.ts', 'scripts/service-h14-paths.ts', 'scripts/build-service-h14.mjs', 'scripts/service-h14-preview.mjs',
  'scripts/service-h14.vite.config.ts', 'scripts/service-h14.vitest.config.ts', 'scripts/service-h14.playwright.config.ts',
  'scripts/service-h14-receipt.ts',
  'scripts/service-h14-lazy-imports.ts',
  'scripts/service-h14-check.mjs',
  'scripts/local-service.config.mjs', 'scripts/certified-bundle-boundary.ts', 'scripts/certified-engine-build.ts',
  'scripts/forecast-runtime-build.ts', 'scripts/site-deployment-artifact.mjs', 'scripts/build-site-production.ts',
  'scripts/production-asset-coexistence.ts', 'vite.config.ts', 'tsconfig.service-h14.json', 'index.html',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];

export function assertServiceH14RuntimePath(path: string): void {
  if (path.startsWith('../') || isAbsolute(path) ||
      /^(?:research\/|src\/adaptiveNext\/)/.test(path) ||
      /(?:^|\/)(?:\.artifacts|nikke-[^/]+|localH14(?:Approx)?|local-h14[^/]*)(?:\/|$)/.test(path) ||
      /(?:^|\/)(?:fixtures?|fixtureCatalog|data|sample|sampling)(?:\/|\.[^/]+$)/.test(path) && path.startsWith('src/serviceH14/') ||
      /(?:\.test\.|\.spec\.|^e2e\/)/.test(path))
    throw new Error(`service_h14_forbidden_runtime_source:${path}`);
}

export function runtimeGraphGuard(root: string): EsbuildPlugin {
  return { name: 'service-h14-source-closure', setup(context) {
    context.onResolve({ filter: /.*/ }, args => {
      if (/^(?:https?:|data:|file:|\/\/)/.test(args.path)) throw new Error('service_h14_external_runtime_import');
      if (args.path.startsWith('.') || isAbsolute(args.path)) {
        const path = resolve(args.resolveDir || root, args.path);
        if (path === resolve(root, SERVICE_H14_BUILD_FILE) || `${path}.ts` === resolve(root, SERVICE_H14_BUILD_FILE))
          return { path: resolve(root, SERVICE_H14_BUILD_FILE), external: true };
      }
      return undefined;
    });
    context.onLoad({ filter: /.*/ }, args => {
      const path = relative(root, realpathSync(serviceH14Path(root, args.path))).replaceAll('\\', '/');
      assertServiceH14RuntimePath(path);
      if (SERVICE_H14_LAZY_IMPORTS.some(item => item.importer === path) || path === SERVICE_H14_RETRY_POLICY.source) {
        const contents = readFileSync(args.path, 'utf8');
        const projected = bindServiceH14LazyImportGraph(path, contents);
        return { contents: projected ?? contents, loader: path.endsWith('.tsx') ? 'tsx' : 'ts', resolveDir: dirname(args.path) };
      }
      return undefined;
    });
  } };
}
export const SERVICE_H14_GRAPH_LOG_OVERRIDE = {
  'unsupported-dynamic-import': 'error', 'unsupported-require-call': 'error',
} as const;

export async function deriveServiceH14Build(root: string, native: ServiceH14Native): Promise<ServiceH14Build> {
  const core = await assertCertifiedEngineBuild(pathToFileURL(`${root}/`));
  if (core.sources.some(source => source.path.startsWith('src/serviceH14/')))
    throw new Error('service_h14_core_runtime_identity_cycle');
  const graph = await build({
    absWorkingDir: root,
    entryPoints: ['src/main.tsx', 'src/serviceH14/browserWorker.ts', 'src/serviceH14/nodeWorker.ts', 'src/serviceH14/nodeClient.ts',
      ...SERVICE_H14_LAZY_IMPORTS.map(item => item.module)],
    bundle: true, write: false, metafile: true, outdir: '.service-h14-graph-not-written',
    platform: 'neutral', format: 'esm', packages: 'external', external: ['node:*'], jsx: 'automatic', logLevel: 'silent',
    define: { 'import.meta.env.VITE_SERVICE_CERTIFIED_SOLVER': '"true"', 'import.meta.env.VITE_FORECAST_RUNTIME': '"bundled"',
      'import.meta.env.VITE_FORECAST_TIMED_V1_PUBLIC_KEY_ID': '""', 'import.meta.env.VITE_FORECAST_TIMED_V1_PUBLIC_KEY_BASE64': '""' },
    logOverride: SERVICE_H14_GRAPH_LOG_OVERRIDE, plugins: [runtimeGraphGuard(root)],
  });
  if (!graph.metafile) throw new Error('service_h14_runtime_graph_missing');
  const runtimePaths = Object.keys(graph.metafile.inputs);
  for (const path of runtimePaths) assertServiceH14RuntimePath(path);
  for (const path of [SERVICE_H14_RETRY_POLICY.source, ...SERVICE_H14_LAZY_IMPORTS.flatMap(item => [item.importer, item.module])])
    if (!runtimePaths.includes(path)) throw new Error(`service_h14_retry_closure_missing:${path}`);
  if (runtimePaths.includes(SERVICE_H14_BUILD_FILE) || !runtimePaths.includes(SERVICE_H14_NATIVE_FILE) ||
      !['controller','source','adaptiveSource','adaptiveDecision','adaptiveExchange'].every(name=>runtimePaths.includes(`src/serviceH14/${name}.ts`)))
    throw new Error('service_h14_runtime_identity_closure_incomplete');
  const slabPaths=portablePins.map(pin=>{
    const path=`public/${portablePath(pin)}`,bytes=readFileSync(serviceH14Path(root,path));
    if(bytes.length!==pin.bytes||serviceH14Sha256(bytes)!==pin.sha256)throw Error('portable_toll_digest');
    return path;
  });
  const sourceManifest = serviceH14Sources(root, [...runtimePaths, ...tools, ...slabPaths, 'scripts/seal-portable-toll.py','scripts/seal-portable-panels.py', ...core.sources.map(source => source.path),
    ...native.sources.map(source => source.path), 'shared/generated/certifiedEngineBuild.ts', SERVICE_H14_NATIVE_FILE, `public${native.wasm.assetPath}`]);
  return { schemaVersion: 1, policy: 'adaptive-next-batch-balanced-v1', profileId: SERVICE_H14_PROFILE_ID, codeHash: serviceH14Sha256(JSON.stringify(sourceManifest)),
    nativeSourceHash: native.sourceHash, exactWasmHash: native.wasm.sha256, sourceManifest };
}

export function serviceH14BuildContents(build: ServiceH14Build): string {
  return '// Generated by scripts/service-h14-build.ts; nondeployable service integration identity.\n' +
    `export const SERVICE_H14_BUILD = ${JSON.stringify(build, null, 2)} as const;\n`;
}

export async function assertServiceH14Build(root = serviceH14Root()): Promise<ServiceH14Build> {
  const native = await assertServiceH14Native(root);
  const build = await deriveServiceH14Build(root, native);
  if (readFileSync(serviceH14Path(root, SERVICE_H14_BUILD_FILE), 'utf8') !== serviceH14BuildContents(build))
    throw new Error('service_h14_runtime_code_hash_stale');
  return build;
}

/** Additive to the existing engine, forecast and initial-bundle guards. */
export function serviceH14BuildGuardPlugin(): Plugin {
  let selected = false;
  return {
    name: 'service-h14-native-runtime-integrity', enforce: 'pre',
    configResolved(config) { selected = config.env['VITE_SERVICE_CERTIFIED_SOLVER'] === 'true'; },
    async buildStart() { if (selected) await assertServiceH14Build(); },
    async configurePreviewServer() { if (selected) await assertServiceH14Build(); },
    transform(_code, id) {
      if (!selected || id.includes('/node_modules/') || id.startsWith('\0')) return;
      const path = relative(serviceH14Root(), id.split('?')[0]!).replaceAll('\\', '/');
      if (path.endsWith('.html')) return;
      assertServiceH14RuntimePath(path);
    },
  };
}
