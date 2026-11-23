import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assertForecastBuild, assertProductionForecastContract, productionTimedTrust } from "./forecast-runtime-build.ts";
import productionProposal from "../site-worker/production-forecast.proposed.json" with { type: "json" };
import { renderDecisionProductionCatalog } from "./render-production-operations.mjs";
import { SERVICE_H14_EMITTED_MODULES, K1R2_NATIVE_SHA256 } from "./service-h14-receipt.ts";
import { assertServiceH14Build } from "./service-h14-integrity.ts";
import staging from "../site-worker/forecast-runtime.json" with { type: "json" };

/** Both valid local profiles are nondeployable (see the separate deploy-site upload gate). */
export function operationalProfileReceipt(mode = "bundled") {
  if (mode !== "bundled" && mode !== "production") throw new Error("Invalid operational profile");
  const online = mode === "production";
  return {
    version: 1,
    profile: online ? "production-k1r2-verification-only" : "local-shared-service-bundled",
    flags: { serviceCertifiedSolver: true, forecastRuntime: mode, onlineTrust: online },
    ...(online ? { releaseAuthorization: "SEPARATE_APPROVAL_REQUIRED", decisionAnalytics: "disabled",
      nativeSha256: K1R2_NATIVE_SHA256 } : {}),
    requiredEmittedModules: [...SERVICE_H14_EMITTED_MODULES],
    solverLane: "service-fused-h14-v1",
    solverPolicy: "horizon_best_earliest",
    solverNumericalContract: "bounded-error-h14-v1",
    solverApproval: "NONDEPLOYABLE_SERVICE_CANDIDATE",
    analyticsProviderApproved: false,
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
  if (!isDeepStrictEqual(approved, assertProductionForecastContract(productionProposal)))
    throw new Error("production_forecast_configured_contract_mismatch");
  await assertForecastBuild(directory, "production", approved);
  assertSiteDeploymentArtifact(directory, sha, "production");
  const json = file => JSON.parse(readFileSync(resolve(directory, file), "utf8"));
  if (!isDeepStrictEqual(json("decision-production-catalog.json"), JSON.parse(renderDecisionProductionCatalog({ enabled: false }))))
    throw new Error("Production verification requires disabled decision analytics");
  const timed = productionTimedTrust(approved);
  const service = json(".vite/service-h14.json");
  const identity = await assertServiceH14Build();
  if (!isDeepStrictEqual(service.identity, identity) || identity.exactWasmHash !== K1R2_NATIVE_SHA256 ||
      service.status !== "NONDEPLOYABLE_SERVICE_CANDIDATE" || service.publicationApproved !== false ||
      service.analyticsProviderApproved !== false || service.promotionGate !== "NOT_APPROVED")
    throw new Error("production_service_verification_identity_mismatch");
  const manifest = json(".vite/manifest.json");
  const workers = json(".vite/certified-boundary.json").perWorker.filter(w => w.source === "src/serviceH14/browserWorker.ts");
  if (workers.length !== 1 || !isDeepStrictEqual(workers[0], service.worker))
    throw new Error("production_service_worker_boundary_mismatch");
  for (const files of [Object.values(manifest).map(c => c.file), workers[0].chunks.map(c => c.file)]) {
    const js = files.filter(file => /^assets\/[\w.-]+\.js$/.test(file))
      .map(file => readFileSync(resolve(directory, file), "utf8")).join("\n");
    if (![timed.publicKeyBase64, timed.keyId, identity.codeHash, K1R2_NATIVE_SHA256].every(pin => js.includes(pin)) ||
        (js.includes(staging.publicKeyBase64) || js.includes(approved.publicKeyBase64)))
      throw new Error("production_service_emitted_pins_mismatch");
  }
  return approved;
}

export function assertSiteDeploymentArtifact(directory, sha, mode = "bundled") {
  const profile = JSON.parse(readFileSync(resolve(directory, ".vite/local-operational-profile.json"), "utf8"));
  if (!isDeepStrictEqual(profile, operationalProfileReceipt(mode)))
    throw new Error("Built artifact is not the approved certified operational profile");
  const runtime = JSON.parse(readFileSync(resolve(directory, ".vite/forecast-runtime.json"), "utf8"));
  const contract = mode === "production" ? assertProductionForecastContract(productionProposal) : null;
  if (!isDeepStrictEqual(runtime, { version: 1, mode, keyId: contract?.keyId ?? "", publicKeyBase64: contract?.publicKeyBase64 ?? "",
    ...(contract ? { timedV1: productionTimedTrust(contract), engineProfile: contract.engineProfile, approvalRef: contract.approvalRef } : {}) }))
    throw new Error("Built runtime does not match the approved operational profile");
  const manifest = JSON.parse(readFileSync(resolve(directory, ".vite/manifest.json"), "utf8"));
  const emitted = Object.values(manifest).filter(entry => entry.isEntry);
  if (!/^[a-f0-9]{40}$/.test(sha) || !emitted.length || emitted.some(entry =>
    !/^assets\/[A-Za-z0-9_.-]+\.js$/.test(entry.file) ||
    !readFileSync(resolve(directory, entry.file), "utf8").includes(sha)))
    throw new Error("Built entry revision does not match the approved SHA");
}
