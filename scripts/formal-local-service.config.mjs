import assert from "node:assert/strict";
import { resolve } from "node:path";
import preview from "../vite.config.ts";
import { SERVICE_H14_PROFILE } from "../src/serviceH14/profile.ts";
import { serviceEnvironment } from "./build-local-service.mjs";
import { operationalProfileReceipt } from "./site-deployment-artifact.mjs";
import { serviceH14ReceiptPlugin } from "./service-h14-receipt.ts";

// Like the isolated root target, replace only preview's target-specific trust guard.
// Unlike either root target this has no key, origin alias, root capability or stats injection.
const common = preview.plugins.filter(plugin => plugin?.name !== "preview-only-trust");
assert.equal(common.length, preview.plugins.length - 1, "expected one preview trust guard");
const root = resolve(import.meta.dirname, "..");
const expectedEnv = serviceEnvironment({});

export default {
  ...preview,
  base: "/",
  envDir: false,
  build: { ...preview.build, outDir: "dist-service-bundled", emptyOutDir: false },
  plugins: [...common, {
    name: "formal-local-bundled-only",
    configResolved(config) {
      assert.equal(config.command, "build");
      assert.equal(config.base, "/");
      assert.equal(resolve(config.root), root);
      assert.equal(resolve(config.root, config.build.outDir), resolve(root, "dist-service-bundled"));
      assert.equal(config.define.__ISOLATED_ROOT_CANDIDATE__, "false");
      assert.equal(config.define.__PRODUCTION_ROOT_SITE__, undefined);
      assert.deepEqual(Object.fromEntries(Object.entries(config.env).filter(([key]) => key.startsWith("VITE_"))), expectedEnv);
    },
    transformIndexHtml: { order: "pre", handler: html => html.replaceAll("/preview/", "/") },
    generateBundle() {
      // The H14 receipt plugin separately verifies actual selected app and Worker modules,
      // service identity and native bytes. Do not claim the legacy K1R2 solver policy here.
      const profile = { ...operationalProfileReceipt("bundled"), solverPolicy: SERVICE_H14_PROFILE.policy,
        formalAdmission: "DIAGNOSTIC_ONLY" };
      this.emitFile({ type: "asset", fileName: ".vite/local-operational-profile.json", source: JSON.stringify(profile) });
    },
  }, serviceH14ReceiptPlugin()],
};
