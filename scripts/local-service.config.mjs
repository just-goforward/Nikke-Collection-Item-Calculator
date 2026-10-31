import assert from "node:assert/strict";
import { relative } from "node:path";
import base from "../vite.config.ts";
import { operationalProfileReceipt } from "./site-deployment-artifact.mjs";
const { requiredEmittedModules: required } = operationalProfileReceipt();
let root;
export default {
  ...base,
  plugins: [...base.plugins, {
    name: "local-shared-service-profile-receipt",
    configResolved(config) {
      root = config.root;
      assert.equal(config.env.VITE_SERVICE_CERTIFIED_SOLVER, "true");
      assert.equal(config.env.VITE_FORECAST_RUNTIME, "bundled");
      assert.equal(config.env.VITE_FORECAST_PUBLIC_KEY_ID, "");
      assert.equal(config.env.VITE_FORECAST_PUBLIC_KEY_BASE64, "");
    },
    generateBundle(_options, bundle) {
      const modules = new Set(Object.values(bundle).filter(v => v.type === "chunk").flatMap(v => Object.keys(v.modules)).map(id => relative(root, id).replaceAll("\\", "/")));
      for (const path of required) assert(modules.has(path), `Selected service module absent: ${path}`);
      this.emitFile({ type: "asset", fileName: ".vite/local-operational-profile.json", source: JSON.stringify(operationalProfileReceipt()) });
    },
  }],
};
