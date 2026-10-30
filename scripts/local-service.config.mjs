import assert from "node:assert/strict";
import { relative } from "node:path";
import base from "../vite.config.ts";
const required = ["src/main.tsx", "src/App.tsx", "src/hooks/useCalculatorApp.ts", "src/hooks/useServiceCertifiedSolver.ts"];
let root, flags;
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
      flags = { serviceCertifiedSolver: true, forecastRuntime: "bundled", onlineTrust: false };
    },
    generateBundle(_options, bundle) {
      const modules = new Set(Object.values(bundle).filter(v => v.type === "chunk").flatMap(v => Object.keys(v.modules)).map(id => relative(root, id).replaceAll("\\", "/")));
      for (const path of required) assert(modules.has(path), `Selected service module absent: ${path}`);
      this.emitFile({ type: "asset", fileName: ".vite/local-operational-profile.json", source: JSON.stringify({ version: 1, profile: "local-shared-service-bundled", flags, requiredEmittedModules: required, entryBinding: "src/main.tsx SERVICE_CERTIFIED_SOLVER boots App; useCalculatorApp selects useServiceCertifiedSolver", deploymentApproved: false }) });
    },
  }],
};
