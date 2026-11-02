import assert from "node:assert/strict";
import { relative } from "node:path";
import base from "../vite.config.ts";
import { operationalProfileReceipt } from "./site-deployment-artifact.mjs";
import { assertProductionForecastContract } from "./forecast-runtime-build.ts";
import productionContract from "../site-worker/production-forecast.proposed.json" with { type: "json" };
const { requiredEmittedModules: required } = operationalProfileReceipt();
let root;
let receipt;
export default {
  ...base,
  plugins: [...base.plugins, {
    name: "local-shared-service-profile-receipt",
    configResolved(config) {
      root = config.root;
      assert.equal(config.env.VITE_SERVICE_CERTIFIED_SOLVER, "true");
      const mode = config.env.VITE_FORECAST_RUNTIME;
      assert(mode === "bundled" || mode === "production");
      const approved = mode === "production" ? assertProductionForecastContract(productionContract) : null;
      assert.equal(config.env.VITE_FORECAST_PUBLIC_KEY_ID, approved?.keyId ?? "");
      assert.equal(config.env.VITE_FORECAST_PUBLIC_KEY_BASE64, approved?.publicKeyBase64 ?? "");
      receipt = operationalProfileReceipt(mode, productionContract);
    },
    generateBundle(_options, bundle) {
      const modules = new Set(Object.values(bundle).filter(v => v.type === "chunk").flatMap(v => Object.keys(v.modules)).map(id => relative(root, id).replaceAll("\\", "/")));
      for (const path of required) assert(modules.has(path), `Selected service module absent: ${path}`);
      this.emitFile({ type: "asset", fileName: ".vite/local-operational-profile.json", source: JSON.stringify(receipt) });
    },
  }],
};
