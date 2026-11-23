import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import productionProposal from "../site-worker/production-forecast.proposed.json" with { type: "json" };
import retention from "../rollback/production/retained.json" with { type: "json" };
import { CERTIFIED_WASM_ASSET, LEGACY_WASM_ASSET } from "../shared/generated/wasmRuntimeAssets.ts";
import { CERTIFIED_STAGING_ENGINE_PROFILE } from "../shared/certifiedEngineProfile.ts";
import { assertProductionForecastContract } from "./forecast-runtime-build.ts";
import { assertProductionAssetReferences, stageProductionAssetCoexistence } from "./production-asset-coexistence.ts";
import { assertServiceH14Build } from "./service-h14-integrity.ts";
import { readServiceH14Native } from "./service-h14-native-integrity.ts";
import { SERVICE_H14_EMITTED_MODULES } from "./service-h14-receipt.ts";
import {
  assertProductionSiteCandidateProfile, assertSiteDeploymentArtifact, operationalProfileReceipt,
} from "./site-deployment-artifact.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const SHA = "a".repeat(40);
const LEGACY_ENTRY_MODULES = [
  "src/main.tsx", "src/App.tsx", "src/hooks/useCalculatorApp.ts",
  "src/hooks/useServiceCertifiedSolver.ts",
];
// Independent of the receipt implementation: the FUSED lane is the service
// adapter selecting the serviceH14 browser client, not the old certified client.
const FUSED_LANE_MODULES = ["src/hooks/serviceCertifiedAdapter.ts", "src/serviceH14/browserClient.ts"];
const bundledProfile = {
  version: 1,
  profile: "local-shared-service-bundled",
  flags: { serviceCertifiedSolver: true, forecastRuntime: "bundled", onlineTrust: false },
  requiredEmittedModules: [...SERVICE_H14_EMITTED_MODULES],
  solverLane: "service-fused-h14-v1",
  solverPolicy: "horizon_best_earliest",
  solverNumericalContract: "bounded-error-h14-v1",
  solverApproval: "NONDEPLOYABLE_SERVICE_CANDIDATE",
  analyticsProviderApproved: false,
  entryBinding: "src/main.tsx SERVICE_CERTIFIED_SOLVER boots App; useCalculatorApp selects useServiceCertifiedSolver",
  deploymentApproved: false,
};

function artifact(t) {
  const root = mkdtempSync(join(tmpdir(), "site-profile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".vite"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, ".vite/manifest.json"), JSON.stringify({
    "index.html": { file: "assets/main-12345678.js", isEntry: true },
  }));
  writeFileSync(join(root, "assets/main-12345678.js"), `const revision="${SHA}";`);
  return { root, json: (file, value) => writeFileSync(join(root, file), JSON.stringify(value)) };
}

test("the required emitted lane keeps the existing entry selection and adds the FUSED service client", () => {
  for (const path of [...LEGACY_ENTRY_MODULES, ...FUSED_LANE_MODULES])
    assert.ok(SERVICE_H14_EMITTED_MODULES.includes(path), path);
  assert.ok(!SERVICE_H14_EMITTED_MODULES.some(path => path.startsWith("src/certifiedRuntime/")));
});

test("deployment rejects a same-SHA non-operational artifact, accepting the guarded bundled FUSED profile", t => {
  const f = artifact(t);
  assert.throws(() => assertSiteDeploymentArtifact(f.root, SHA), /local-operational-profile\.json/);
  const { requiredEmittedModules: _modules, ...withoutModules } = bundledProfile;
  const { solverApproval: _approval, ...withoutApproval } = bundledProfile;
  for (const invalid of [
    { ...bundledProfile, flags: { ...bundledProfile.flags, serviceCertifiedSolver: false } },
    { ...bundledProfile, flags: { ...bundledProfile.flags, forecastRuntime: "production" } },
    { ...bundledProfile, flags: { ...bundledProfile.flags, onlineTrust: true } },
    { ...bundledProfile, requiredEmittedModules: ["src/main.tsx"] },
    // A pre-FUSED receipt selected only the old lane and must not be accepted.
    { ...bundledProfile, requiredEmittedModules: LEGACY_ENTRY_MODULES },
    { ...bundledProfile, requiredEmittedModules: bundledProfile.requiredEmittedModules
      .filter(path => path !== "src/serviceH14/browserClient.ts") },
    withoutModules,
    { ...bundledProfile, entryBinding: "legacy selection" },
    { ...bundledProfile, solverLane: "certified-runtime" },
    { ...bundledProfile, solverPolicy: "earliest" },
    { ...bundledProfile, solverNumericalContract: "exact" },
    { ...bundledProfile, solverApproval: "APPROVED" },
    withoutApproval,
    { ...bundledProfile, analyticsProviderApproved: true },
    { ...bundledProfile, deploymentApproved: true },
    { ...bundledProfile, publicationApproved: true },
  ]) {
    f.json(".vite/local-operational-profile.json", invalid);
    assert.throws(() => assertSiteDeploymentArtifact(f.root, SHA), /approved certified operational profile/);
  }
  f.json(".vite/local-operational-profile.json", bundledProfile);
  f.json(".vite/forecast-runtime.json", { version: 1, mode: "bundled", keyId: "", publicKeyBase64: "" });
  assert.doesNotThrow(() => assertSiteDeploymentArtifact(f.root, SHA));
  assert.throws(() => assertSiteDeploymentArtifact(f.root, "b".repeat(40)), /approved SHA/);
});

test("production promotion of the FUSED service candidate is explicitly unapproved", async t => {
  assert.throws(() => operationalProfileReceipt("staging"), /Invalid operational profile/);
  assert.throws(() => operationalProfileReceipt("production"),
    /service_h14_production_promotion_unapproved/);
  const f = artifact(t);
  const contract = { ...productionProposal, approvalRef: "test-only-current-engine",
    engineProfile: { ...CERTIFIED_STAGING_ENGINE_PROFILE } };
  const approved = assertProductionForecastContract(contract);
  // This process-local fixture isolates the solver gate without rewriting the
  // real operator proposal, whose prior engine identity must remain unchanged.
  f.json(".vite/forecast-runtime.json", {
    version: 1, mode: "production", keyId: approved.keyId, publicKeyBase64: approved.publicKeyBase64,
    approvalRef: approved.approvalRef, engineProfile: approved.engineProfile,
  });
  f.json(".vite/local-operational-profile.json", {
    ...bundledProfile, profile: "production-shared-service-online",
    flags: { ...bundledProfile.flags, forecastRuntime: "production", onlineTrust: true },
    productionContract: approved,
  });
  assert.throws(() => assertSiteDeploymentArtifact(f.root, SHA, "production"),
    /service_h14_production_promotion_unapproved/);
  await assert.rejects(assertProductionSiteCandidateProfile(f.root, SHA, contract),
    /service_h14_production_promotion_unapproved/);
});

// Packaging guard (production-asset-coexistence.ts) used by every Site artifact
// validation payload. The FUSED worker may replace the certified worker in the
// current graph, but never the packaged legacy/certified/retained bytes.
function referenceArtifact(t, workers, entry = "") {
  const root = mkdtempSync(join(tmpdir(), "site-references-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "assets"));
  mkdirSync(join(root, "wasm"));
  const native = readServiceH14Native(ROOT).wasm;
  copyFileSync(join(ROOT, "public", native.assetPath.slice(1)), join(root, native.assetPath.slice(1)));
  writeFileSync(join(root, "assets/main-12345678.js"), entry);
  const perWorker = Object.entries(workers).map(([source, body], index) => {
    const file = `assets/worker${index}-12345678.js`;
    writeFileSync(join(root, file), body);
    return { version: "worker-chunk-graph-v1", source, entryFile: file, chunks: [{ file, imports: [], dynamicImports: [] }] };
  });
  const manifest = { "index.html": { file: "assets/main-12345678.js", isEntry: true } };
  const boundary = {
    version: "certified-initial-boundary-v1", initialFiles: [], initialModules: [], certifiedFiles: [], perWorker,
  };
  return { root, native, check: () => assertProductionAssetReferences(root, manifest, boundary) };
}
const pinned = (file, hash) => `fetch(new URL("/${file}",location));const pin="${hash}";`;
const legacy = pinned(LEGACY_WASM_ASSET.file, LEGACY_WASM_ASSET.sha256);
const certified = pinned(CERTIFIED_WASM_ASSET.file, CERTIFIED_WASM_ASSET.sha256);
const service = () => {
  const { wasm } = readServiceH14Native(ROOT);
  return pinned(wasm.assetPath.slice(1), wasm.sha256);
};

test("a FUSED-only worker graph may omit the old certified worker but keeps legacy and FUSED pins bound", async t => {
  await referenceArtifact(t, {
    "src/worker.ts": legacy, "src/serviceH14/browserWorker.ts": service(),
  }).check();
  // Hashed URLs embed the hash, so an unbound worker is one whose URL appears
  // only outside its own chunks (here: the page entry).
  const serviceUrl = `"${readServiceH14Native(ROOT).wasm.assetPath}"`;
  for (const [workers, code, entry] of [
    [{ "src/serviceH14/browserWorker.ts": service() }, "production_asset_client_reference_missing:src/worker.ts"],
    [{ "src/worker.ts": "", "src/serviceH14/browserWorker.ts": service() },
      "production_asset_worker_pin_missing:src/worker.ts", `"/${LEGACY_WASM_ASSET.file}"`],
    [{ "src/worker.ts": legacy, "src/serviceH14/browserWorker.ts": "" },
      "production_asset_worker_pin_missing:src/serviceH14/browserWorker.ts", serviceUrl],
    [{ "src/worker.ts": legacy, "src/serviceH14/browserWorker.ts": "" },
      "production_asset_client_reference_missing:src/serviceH14/browserWorker.ts"],
    // An emitted certified worker beside the FUSED worker is still bound to the certified pin.
    [{ "src/worker.ts": legacy, "src/serviceH14/browserWorker.ts": service(), "src/certifiedRuntime/browserWorker.ts": "" },
      "production_asset_client_reference_missing:src/certifiedRuntime/browserWorker.ts"],
    // Without the FUSED worker the pre-existing certified requirement is unchanged.
    [{ "src/worker.ts": legacy }, "production_asset_client_reference_missing:src/certifiedRuntime/browserWorker.ts"],
  ])
    await assert.rejects(referenceArtifact(t, workers, entry).check(), { message: code });
  await referenceArtifact(t, {
    "src/worker.ts": legacy, "src/serviceH14/browserWorker.ts": service(), "src/certifiedRuntime/browserWorker.ts": certified,
  }).check();
});

test("the packaged FUSED native bytes are checked against the pinned identity", async t => {
  const tampered = referenceArtifact(t, { "src/worker.ts": legacy, "src/serviceH14/browserWorker.ts": service() });
  const path = join(tampered.root, tampered.native.assetPath.slice(1));
  const bytes = readFileSync(path);
  bytes[bytes.length - 1] ^= 1;
  writeFileSync(path, bytes);
  await assert.rejects(tampered.check(), { message: "service_h14_packaged_native_mismatch" });
  const missing = referenceArtifact(t, { "src/worker.ts": legacy, "src/serviceH14/browserWorker.ts": service() });
  rmSync(join(missing.root, missing.native.assetPath.slice(1)));
  await assert.rejects(missing.check(), { code: "ENOENT" });
});

const LEGACY_WORKERS = ["src/certifiedRuntime/browserWorker.ts", "src/worker.ts"];
const FUSED_WORKERS = ["src/serviceH14/browserWorker.ts", "src/worker.ts"];
function packagedOutput(t, workers = LEGACY_WORKERS) {
  const root = mkdtempSync(join(tmpdir(), "site-coexistence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".vite"));
  mkdirSync(join(root, "wasm"));
  // Vite copies public/: canonical aliases, hashed current assets and the FUSED native asset.
  const native = readServiceH14Native(ROOT).wasm;
  for (const file of ["solver_rs.wasm", "certified_solver.wasm", LEGACY_WASM_ASSET.file, CERTIFIED_WASM_ASSET.file,
    native.assetPath.slice(1)])
    copyFileSync(join(ROOT, "public", file), join(root, file));
  // The emitted worker graph decides whether the FUSED lane was packaged.
  writeFileSync(join(root, ".vite/certified-boundary.json"), JSON.stringify({
    version: "certified-initial-boundary-v1", initialFiles: [], initialModules: [], certifiedFiles: [],
    perWorker: workers.map(source => ({ version: "worker-chunk-graph-v1", source, entryFile: "", chunks: [] })),
  }));
  return { root, native };
}

test("old certified, legacy and retained assets stay packaged and checksummed beside the FUSED asset without a FUSED worker", async t => {
  const output = packagedOutput(t);
  const staged = await stageProductionAssetCoexistence(output.root);
  assert.equal(staged.publicationApproved, false);
  assert.equal(staged.serviceCandidate, undefined);
  assert.deepEqual(staged.current.wasm.map(({ file, sha256: hash }) => [file, hash]), [
    [LEGACY_WASM_ASSET.file, LEGACY_WASM_ASSET.sha256], [CERTIFIED_WASM_ASSET.file, CERTIFIED_WASM_ASSET.sha256],
  ]);
  const pins = retention.generations.flatMap(generation => generation.files);
  assert.ok(pins.some(pin => pin.url === "/certified_solver.wasm"));
  for (const pin of pins)
    assert.equal(sha256(readFileSync(join(output.root, pin.url.slice(1)))), pin.sha256, pin.url);
  await stageProductionAssetCoexistence(output.root, true);

  const retained = pins.find(pin => pin.url.endsWith(".js"));
  assert.ok(retained);
  writeFileSync(join(output.root, retained.url.slice(1)), "tampered");
  await assert.rejects(stageProductionAssetCoexistence(output.root, true),
    { message: `production_retained_asset_mismatch:${retained.url}` });

  for (const [mutate, code] of [
    [root => rmSync(join(root, CERTIFIED_WASM_ASSET.file)), `production_required_asset_missing:${CERTIFIED_WASM_ASSET.file}`],
    [root => writeFileSync(join(root, CERTIFIED_WASM_ASSET.file), "tampered"),
      `production_required_asset_mismatch:${CERTIFIED_WASM_ASSET.file}`],
    [root => rmSync(join(root, LEGACY_WASM_ASSET.file)), `production_required_asset_missing:${LEGACY_WASM_ASSET.file}`],
  ]) {
    const candidate = packagedOutput(t);
    mutate(candidate.root);
    await assert.rejects(stageProductionAssetCoexistence(candidate.root), { message: code });
  }
});

test("a packaged FUSED receipt must carry the verified nondeployable identity", async t => {
  const identity = await assertServiceH14Build(ROOT);
  const receipt = native => ({
    version: 1, status: "NONDEPLOYABLE_SERVICE_CANDIDATE", identity, asset: native,
    publicationApproved: false, analyticsProviderApproved: false,
  });
  const accepted = packagedOutput(t, FUSED_WORKERS);
  writeFileSync(join(accepted.root, ".vite/service-h14.json"), JSON.stringify(receipt(accepted.native)));
  const staged = await stageProductionAssetCoexistence(accepted.root);
  assert.deepEqual(staged.serviceCandidate, {
    profileId: identity.profileId, codeHash: identity.codeHash, asset: accepted.native,
    publicationApproved: false, analyticsProviderApproved: false,
  });
  for (const forge of [
    value => ({ ...value, publicationApproved: true }),
    value => ({ ...value, analyticsProviderApproved: true }),
    value => ({ ...value, status: "DEPLOYABLE_SERVICE_CANDIDATE" }),
    value => ({ ...value, identity: { ...value.identity, codeHash: "0".repeat(64) } }),
  ]) {
    const output = packagedOutput(t, FUSED_WORKERS);
    writeFileSync(join(output.root, ".vite/service-h14.json"), JSON.stringify(forge(receipt(output.native))));
    await assert.rejects(stageProductionAssetCoexistence(output.root), { message: "service_h14_packaged_identity_mismatch" });
  }
});

test("an emitted FUSED worker requires the packaged receipt before any staging write", async t => {
  const retainedFile = retention.generations.flatMap(generation => generation.files)
    .find(pin => pin.url.endsWith(".js")).url.slice(1);
  const missing = packagedOutput(t, FUSED_WORKERS);
  await assert.rejects(stageProductionAssetCoexistence(missing.root), { message: "service_h14_packaged_receipt_missing" });
  assert.throws(() => readFileSync(join(missing.root, retainedFile)), { code: "ENOENT" });
  // The worker graph is required evidence: an absent or malformed boundary cannot select the legacy path.
  const absent = packagedOutput(t);
  rmSync(join(absent.root, ".vite/certified-boundary.json"));
  await assert.rejects(stageProductionAssetCoexistence(absent.root), { code: "ENOENT" });
  const malformed = packagedOutput(t);
  writeFileSync(join(malformed.root, ".vite/certified-boundary.json"), JSON.stringify({ perWorker: {} }));
  await assert.rejects(stageProductionAssetCoexistence(malformed.root), { message: "production_certified_boundary_invalid" });
});
