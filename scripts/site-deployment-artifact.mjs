import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assertForecastBuild, assertProductionForecastContract } from "./forecast-runtime-build.ts";
import productionProposal from "../site-worker/production-forecast.proposed.json" with { type: "json" };
import { renderDecisionProductionCatalog } from "./render-production-operations.mjs";

export function operationalProfileReceipt(mode = "bundled", contract) {
  if (mode !== "bundled" && mode !== "production") throw new Error("Invalid operational profile");
  const approved = mode === "production" ? assertProductionForecastContract(contract) : null;
  return {
    version: 1,
    profile: approved ? "production-shared-service-online" : "local-shared-service-bundled",
    flags: { serviceCertifiedSolver: true, forecastRuntime: mode, onlineTrust: Boolean(approved) },
    ...(approved ? { productionContract: approved } : {}),
    requiredEmittedModules: [
      "src/main.tsx", "src/App.tsx", "src/hooks/useCalculatorApp.ts",
      "src/hooks/useServiceCertifiedSolver.ts",
    ],
    entryBinding: "src/main.tsx SERVICE_CERTIFIED_SOLVER boots App; useCalculatorApp selects useServiceCertifiedSolver",
    deploymentApproved: false,
  };
}

export async function assertProductionOffSiteProfile(directory, sha) {
  await assertForecastBuild(directory, "bundled");
  const runtime = JSON.parse(readFileSync(resolve(directory, ".vite/forecast-runtime.json"), "utf8"));
  if (!isDeepStrictEqual(runtime, { version: 1, mode: "bundled", keyId: "", publicKeyBase64: "" }))
    throw new Error("Production OFF artifact contains online trust");
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(resolve(directory, "decision-production-catalog.json"), "utf8"));
  } catch {
    throw new Error("Production OFF artifact decision catalog missing or malformed");
  }
  if (!isDeepStrictEqual(catalog, JSON.parse(renderDecisionProductionCatalog({ enabled: false }))))
    throw new Error("Production OFF artifact decision catalog is not disabled");
  assertSiteDeploymentArtifact(directory, sha);
}

export async function assertProductionSiteCandidateProfile(directory, sha, contract = productionProposal) {
  const approved = assertProductionForecastContract(contract);
  await assertForecastBuild(directory, "production", approved);
  assertSiteDeploymentArtifact(directory, sha, "production", approved);
  return approved;
}

export function assertSiteDeploymentArtifact(directory, sha, mode = "bundled", contract = productionProposal) {
  const profile = JSON.parse(readFileSync(resolve(directory, ".vite/local-operational-profile.json"), "utf8"));
  const expected = operationalProfileReceipt(mode, contract);
  if (!isDeepStrictEqual(profile, expected))
    throw new Error("Built artifact is not the approved certified operational profile");
  const runtime = JSON.parse(readFileSync(resolve(directory, ".vite/forecast-runtime.json"), "utf8"));
  const approved = expected.productionContract;
  if (runtime.version !== 1 || runtime.mode !== expected.flags.forecastRuntime ||
      runtime.keyId !== (approved?.keyId ?? "") ||
      runtime.publicKeyBase64 !== (approved?.publicKeyBase64 ?? "") ||
      (approved && (runtime.approvalRef !== approved.approvalRef ||
        !isDeepStrictEqual(runtime.engineProfile, approved.engineProfile))))
    throw new Error("Built runtime does not match the approved operational profile");
  const manifest = JSON.parse(readFileSync(resolve(directory, ".vite/manifest.json"), "utf8"));
  const emitted = Object.values(manifest).filter(entry => entry.isEntry);
  if (!/^[a-f0-9]{40}$/.test(sha) || !emitted.length || emitted.some(entry =>
    !/^assets\/[A-Za-z0-9_.-]+\.js$/.test(entry.file) ||
    !readFileSync(resolve(directory, entry.file), "utf8").includes(sha)))
    throw new Error("Built entry revision does not match the approved SHA");
}
