import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

export function operationalProfileReceipt() {
  return {
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
}

export function assertSiteDeploymentArtifact(directory, sha) {
  const profile = JSON.parse(readFileSync(resolve(directory, ".vite/local-operational-profile.json"), "utf8"));
  if (!isDeepStrictEqual(profile, operationalProfileReceipt()))
    throw new Error("Built artifact is not the certified bundled operational profile");
  const manifest = JSON.parse(readFileSync(resolve(directory, ".vite/manifest.json"), "utf8"));
  const emitted = Object.values(manifest).filter(entry => entry.isEntry);
  if (!/^[a-f0-9]{40}$/.test(sha) || !emitted.length || emitted.some(entry =>
    !/^assets\/[A-Za-z0-9_.-]+\.js$/.test(entry.file) ||
    !readFileSync(resolve(directory, entry.file), "utf8").includes(sha)))
    throw new Error("Built entry revision does not match the approved SHA");
}
