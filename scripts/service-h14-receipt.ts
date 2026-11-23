import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { Plugin } from 'vite';
import type { WorkerChunkGraph } from './certified-bundle-boundary.ts';
import { assertServiceH14Build } from './service-h14-integrity.ts';
import { readServiceH14Native } from './service-h14-native-integrity.ts';
import { serviceH14Root, serviceH14Sha256 } from './service-h14-paths.ts';
import { assertProductionForecastContract, productionTimedTrust } from './forecast-runtime-build.ts';
import productionProposal from '../site-worker/production-forecast.proposed.json' with { type: 'json' };

export const K1R2_NATIVE_SHA256 = '59a9f0f39391d679e92d9f4be1b7269cb55606be289c48a0d91816c5829c4786';

export const SERVICE_H14_EMITTED_MODULES = [
  'src/main.tsx', 'src/App.tsx', 'src/hooks/useCalculatorApp.ts', 'src/hooks/useServiceCertifiedSolver.ts',
  'src/hooks/serviceCertifiedAdapter.ts', 'src/serviceH14/browserClient.ts', 'src/serviceH14/client.ts',
  'src/serviceH14/admission.ts', 'src/serviceH14/binding.ts', 'src/serviceH14/profile.ts',
] as const;
export const SERVICE_H14_WORKER_MODULES = [
  'src/serviceH14/browserWorker.ts', 'src/serviceH14/workerHandler.ts', 'src/serviceH14/controller.ts',
  'src/serviceH14/source.ts', 'src/serviceH14/sourcePlan.ts', 'src/serviceH14/fusedEndpoint.ts',
  'src/serviceH14/loader.ts', 'src/serviceH14/fusedModule.ts',
] as const;

/** Inspect the actual worker sub-build as well as the existing lazy App lane. */
export function serviceH14ReceiptPlugin(): Plugin {
  let root = '';
  let production = false;
  return {
    name: 'service-h14-emitted-lane-receipt', enforce: 'post', apply: 'build',
    configResolved(config) {
      root = config.root;
      production = config.env['VITE_FORECAST_RUNTIME'] === 'production';
      const approved = production ? assertProductionForecastContract(productionProposal) : null;
      const timed = approved && productionTimedTrust(approved);
      if (config.env['VITE_FORECAST_TIMED_V1_PUBLIC_KEY_ID'] !== (timed?.keyId ?? '') ||
          config.env['VITE_FORECAST_TIMED_V1_PUBLIC_KEY_BASE64'] !== (timed?.publicKeyBase64 ?? '') ||
          config.env['VITE_SERVICE_CERTIFIED_SOLVER'] !== 'true' ||
          config.env['VITE_FORECAST_RUNTIME'] !== (approved?.environment ?? 'bundled') ||
          config.env['VITE_FORECAST_PUBLIC_KEY_ID'] !== (approved?.keyId ?? '') ||
          config.env['VITE_FORECAST_PUBLIC_KEY_BASE64'] !== (approved?.publicKeyBase64 ?? ''))
        throw new Error('service_h14_candidate_flags_mismatch');
    },
    async generateBundle(_options, bundle) {
      const modules = new Set(Object.values(bundle).filter(output => output.type === 'chunk')
        .flatMap(output => Object.keys(output.modules)).map(id => relative(root, id).replaceAll('\\', '/')));
      for (const path of SERVICE_H14_EMITTED_MODULES)
        if (!modules.has(path)) throw new Error(`service_h14_selected_module_absent:${path}`);
      for (const path of modules)
        if (/src\/localH14|\.artifacts|fixtureCatalog/.test(path)) throw new Error(`service_h14_research_module_emitted:${path}`);
      const graphAsset = Object.values(bundle).find(output => output.type === 'asset' &&
        output.fileName === '.vite/worker-boundary/src_serviceH14_browserWorker.ts.json');
      if (!graphAsset || graphAsset.type !== 'asset') throw new Error('service_h14_worker_graph_missing');
      const graph = JSON.parse(typeof graphAsset.source === 'string' ? graphAsset.source : new TextDecoder().decode(graphAsset.source)) as WorkerChunkGraph;
      if (graph.source !== 'src/serviceH14/browserWorker.ts' || !Array.isArray(graph.modules)) throw new Error('service_h14_worker_source_mismatch');
      for (const path of SERVICE_H14_WORKER_MODULES)
        if (!graph.modules.includes(path)) throw new Error(`service_h14_worker_module_absent:${path}`);
      for (const path of graph.modules)
        if (/src\/localH14|\.artifacts|fixtureCatalog|src\/certifiedRuntime\/(?:workerHandler|browserWorker)\.ts/.test(path))
          throw new Error(`service_h14_forbidden_worker_module:${path}`);
      const identity = await assertServiceH14Build(serviceH14Root());
      if (production && identity.exactWasmHash !== K1R2_NATIVE_SHA256)
        throw new Error('service_h14_production_native_pin_mismatch');
      const native = readServiceH14Native(root);
      // Vite copies public assets after generateBundle. Record the independently
      // verified source pin here; the packaging guard verifies copied bytes.
      const asset = { ...native.wasm };
      if (serviceH14Sha256(readFileSync(`${root}/public${asset.assetPath}`)) !== identity.exactWasmHash)
        throw new Error('service_h14_emitted_asset_identity_mismatch');
      this.emitFile({ type: 'asset', fileName: '.vite/service-h14.json', source: JSON.stringify({
        version: 1, status: 'NONDEPLOYABLE_SERVICE_CANDIDATE', identity, asset,
        entry: 'src/main.tsx', app: 'src/App.tsx', worker: graph,
        forecastAuthorityChanged: false, publicationApproved: false, analyticsProviderApproved: false,
        promotionGate: 'NOT_APPROVED', analyticsProviderGate: 'APPROVED_PRODUCER_CODE_REQUIRED',
      }) });
    },
  };
}
