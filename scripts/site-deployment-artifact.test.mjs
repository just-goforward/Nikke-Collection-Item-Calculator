import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSiteDeploymentArtifact } from "./site-deployment-artifact.mjs";

test("deployment rejects a same-SHA non-operational artifact, accepting the certified bundled profile", () => {
  const root = mkdtempSync(join(tmpdir(), "site-profile-"));
  try {
    mkdirSync(join(root, ".vite"));
    mkdirSync(join(root, "assets"));
    const sha = "a".repeat(40);
    writeFileSync(join(root, ".vite/manifest.json"), JSON.stringify({
      "index.html": { file: "assets/main-12345678.js", isEntry: true },
    }));
    writeFileSync(join(root, "assets/main-12345678.js"), `const revision="${sha}";`);
    assert.throws(() => assertSiteDeploymentArtifact(root, sha), /local-operational-profile\.json/);
    const profile = {
      version: 1,
      profile: "local-shared-service-bundled",
      flags: { serviceCertifiedSolver: true, forecastRuntime: "bundled", onlineTrust: false },
      requiredEmittedModules: [
        "src/main.tsx", "src/App.tsx", "src/hooks/useCalculatorApp.ts",
        "src/hooks/useServiceCertifiedSolver.ts",
      ],
      entryBinding: "src/main.tsx SERVICE_CERTIFIED_SOLVER boots App; useCalculatorApp selects useServiceCertifiedSolver",
      deploymentApproved: false,
    };
    const path = join(root, ".vite/local-operational-profile.json");
    for (const invalid of [
      { ...profile, flags: { ...profile.flags, serviceCertifiedSolver: false } },
      { ...profile, flags: { ...profile.flags, forecastRuntime: "production" } },
      { ...profile, flags: { ...profile.flags, onlineTrust: true } },
      { ...profile, requiredEmittedModules: ["src/main.tsx"] },
      { ...profile, entryBinding: "legacy selection" },
    ]) {
      writeFileSync(path, JSON.stringify(invalid));
      assert.throws(() => assertSiteDeploymentArtifact(root, sha), /approved certified operational profile/);
    }
    writeFileSync(path, JSON.stringify(profile));
    writeFileSync(join(root, ".vite/forecast-runtime.json"), JSON.stringify({
      version: 1, mode: "bundled", keyId: "", publicKeyBase64: "",
    }));
    assert.doesNotThrow(() => assertSiteDeploymentArtifact(root, sha));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
