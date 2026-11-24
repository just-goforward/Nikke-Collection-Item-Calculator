import test from "node:test";
import assert from "node:assert/strict";
import fs, * as fsExports from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, relative, sep } from "node:path";
import { buildProductionOffService } from "./build-production-off-service.mjs";
import { assertProductionOffSiteProfile } from "./site-deployment-artifact.mjs";
import { assertProductionOffSiteConfiguration, assertSiteUploadApproved, deploy } from "./deploy-site.ts";
import { SERVICE_H14_EMITTED_MODULES } from "./service-h14-receipt.ts";

const ROOT = resolve(import.meta.dirname, "..");
const SHA = "a".repeat(40);
const ACCOUNT = "15be33fd20ea78eb3d60b719be831148";
const TOKEN = "SYNTHETIC_DEPLOY_BOUNDARY_ONLY";
const bundledRuntime = { version: 1, mode: "bundled", keyId: "", publicKeyBase64: "" };
const disabledCatalog = {
  enabled: false,
  producer: { producerVersion: "", producerCodeHash: "" },
  allowedProducers: [], turnstileSiteKey: "", publications: [],
};
const bundledProfile = {
  version: 1, profile: "local-shared-service-bundled",
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

function outputExists(t, occupied) {
  const original = fs.existsSync;
  const mocked = t.mock.method(fs, "existsSync", value =>
    String(value) === resolve(ROOT, "dist") ? occupied : original(value));
  syncBuiltinESMExports();
  assert.equal(fsExports.existsSync, mocked);
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test("OFF build fixes compiled solver, bundled empty trust and revision without inheriting ambient authority", t => {
  outputExists(t, false);
  const calls = [];
  buildProductionOffService(SHA, {
    PATH: "synthetic-path", VITE_SERVICE_CERTIFIED_SOLVER: "false",
    VITE_FORECAST_RUNTIME: "production", VITE_FORECAST_PUBLIC_KEY_ID: "ambient-key",
    VITE_FORECAST_PUBLIC_KEY_BASE64: "ambient-trust", CLOUDFLARE_API_TOKEN: TOKEN,
    GITHUB_SHA: "b".repeat(40),
  }, (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(command, process.execPath);
    assert.equal(options.cwd, ROOT);
    assert.equal(options.env.VITE_SERVICE_CERTIFIED_SOLVER, "true");
    assert.equal(options.env.VITE_FORECAST_RUNTIME, "bundled");
    assert.equal(options.env.VITE_FORECAST_PUBLIC_KEY_ID, "");
    assert.equal(options.env.VITE_FORECAST_PUBLIC_KEY_BASE64, "");
    assert.equal(options.env.GITHUB_SHA, SHA);
    assert.equal(options.env.CLOUDFLARE_API_TOKEN, undefined);
    return { status: 0 };
  });
  assert.equal(calls.length, 5);
  const bundle = calls.find(call => call.args.includes("--outDir"));
  assert.ok(bundle);
  assert.equal(bundle.args[bundle.args.indexOf("--outDir") + 1], "dist");
  assert.deepEqual(calls.at(-1).args.slice(-2), ["dist", SHA]);
});

test("OFF builder rejects malformed SHA and occupied output without starting any build", t => {
  let executions = 0;
  const execute = () => { executions++; return { status: 0 }; };
  for (const sha of ["", "short", "A".repeat(40), `${SHA}extra`])
    assert.throws(() => buildProductionOffService(sha, {}, execute), /source SHA/);
  outputExists(t, true);
  assert.throws(() => buildProductionOffService(SHA, {}, execute), /Preserve existing dist/);
  assert.equal(executions, 0);
});

test("OFF build failure stops once and never retries or runs downstream packaging", t => {
  outputExists(t, false);
  let executions = 0;
  assert.throws(() => buildProductionOffService(SHA, {}, () => {
    executions++;
    return { status: 1 };
  }), /Production OFF build failed/);
  assert.equal(executions, 1);
});

async function artifact(t) {
  const directory = await mkdtemp(join(tmpdir(), "production-off-profile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, ".vite"));
  await mkdir(join(directory, "assets"));
  const json = (file, value) => writeFile(join(directory, file), JSON.stringify(value));
  await json(".vite/manifest.json", {
    "index.html": { file: "assets/main-12345678.js", isEntry: true },
  });
  await writeFile(join(directory, "assets/main-12345678.js"), `const revision="${SHA}";`);
  await json(".vite/local-operational-profile.json", bundledProfile);
  await json(".vite/forecast-runtime.json", bundledRuntime);
  await json("decision-production-catalog.json", disabledCatalog);
  return { directory, json };
}

test("explicit OFF profile accepts the existing bundled receipt without forging deployment approval", async t => {
  const f = await artifact(t);
  await assertProductionOffSiteProfile(f.directory, SHA);
});

test("OFF profile rejects online trust or approval metadata even with the same entry revision", async t => {
  const f = await artifact(t);
  for (const runtime of [
    { ...bundledRuntime, mode: "production" },
    { ...bundledRuntime, keyId: "online-key" },
    { ...bundledRuntime, publicKeyBase64: "online-trust" },
    { ...bundledRuntime, approvalRef: "synthetic-online-approval" },
  ]) {
    await f.json(".vite/forecast-runtime.json", runtime);
    await assert.rejects(assertProductionOffSiteProfile(f.directory, SHA));
  }
});

test("OFF composition retains operational profile and source revision validation", async t => {
  const f = await artifact(t);
  for (const profile of [
    { ...bundledProfile, flags: { ...bundledProfile.flags, serviceCertifiedSolver: false } },
    // The pre-FUSED receipt (old lane only) and any forged solver/analytics approval stay rejected.
    { ...bundledProfile, requiredEmittedModules: [
      "src/main.tsx", "src/App.tsx", "src/hooks/useCalculatorApp.ts", "src/hooks/useServiceCertifiedSolver.ts",
    ] },
    { ...bundledProfile, solverApproval: "APPROVED" },
    { ...bundledProfile, analyticsProviderApproved: true },
    { ...bundledProfile, deploymentApproved: true },
  ]) {
    await f.json(".vite/local-operational-profile.json", profile);
    await assert.rejects(assertProductionOffSiteProfile(f.directory, SHA), /operational profile/);
  }
  await f.json(".vite/local-operational-profile.json", bundledProfile);
  await assert.rejects(assertProductionOffSiteProfile(f.directory, "b".repeat(40)), /approved SHA/);
});

for (const state of ["enabled", "missing", "malformed"]) {
  test(`OFF artifact rejects ${state} built decision catalog despite matching solver, trust and SHA`, async t => {
    const f = await artifact(t);
    const file = join(f.directory, "decision-production-catalog.json");
    if (state === "enabled") await f.json("decision-production-catalog.json", { ...disabledCatalog, enabled: true });
    else if (state === "missing") await rm(file);
    else await writeFile(file, '{"enabled":false,');
    await assert.rejects(assertProductionOffSiteProfile(f.directory, SHA), /decision catalog/);
  });
}

const namedConfiguration = `name = "collection-kit-site-production"
[vars]
SITE_ENV = "production"
FORECAST_RUNTIME_MODE = "off"
[[services]]
binding = "STATS_INGEST"
service = "collection-kit-stats"
entrypoint = "Ingest"
[[services]]
binding = "STATS_PUBLIC"
service = "collection-kit-stats"
entrypoint = "PublicStats"
`;

test("OFF configuration accepts exactly the existing worker's two named Stats capabilities", () => {
  assert.doesNotThrow(() => assertProductionOffSiteConfiguration(namedConfiguration));
  assert.doesNotThrow(() => assertProductionOffSiteConfiguration(namedConfiguration.replaceAll("\n", "\r\n")));
});

for (const [label, configuration] of [
  ["v2 Site worker", namedConfiguration.replace("collection-kit-site-production", "collection-kit-site-v2-production")],
  ["v2 Stats destination", namedConfiguration.replaceAll('service = "collection-kit-stats"', 'service = "collection-kit-stats-v2-production"')],
  ["legacy-only Stats binding", `name = "collection-kit-site-production"
[vars]
SITE_ENV = "production"
FORECAST_RUNTIME_MODE = "off"
[[services]]
binding = "STATS"
service = "collection-kit-stats"
`],
  ["missing PublicStats capability", namedConfiguration.slice(0, namedConfiguration.lastIndexOf("[[services]]"))],
  ["swapped public entrypoint", namedConfiguration.replace('entrypoint = "PublicStats"', 'entrypoint = "Ingest"')],
  ["additional service authority", `${namedConfiguration}[[services]]\nbinding = "EXTRA"\nservice = "other"\n`],
  ["direct D1 binding", `${namedConfiguration}[[d1_databases]]\nbinding = "DB"\ndatabase_id = "synthetic"\n`],
  ["staging environment", namedConfiguration.replace('SITE_ENV = "production"', 'SITE_ENV = "staging"')],
  ["online runtime", namedConfiguration.replace('FORECAST_RUNTIME_MODE = "off"', 'FORECAST_RUNTIME_MODE = "production"')],
]) {
  test(`OFF configuration rejects ${label}`, () => {
    assert.throws(() => assertProductionOffSiteConfiguration(configuration));
  });
}

function deploymentParent(changes = {}) {
  return {
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN, SITE_DEPLOY_ACCOUNT_ID: ACCOUNT,
    SITE_DEPLOY_WORKER: "collection-kit-site-production", SITE_DEPLOY_HOSTNAME: "nikkecollection.com",
    ...changes,
  };
}

const DIST = resolve(ROOT, "dist");
// deploy() always validates, authorizes and uploads the checkout's dist; tests
// redirect only reads below it to a temporary artifact instead of writing dist.
function distReadsFrom(t, directory) {
  const original = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (path, ...rest) => {
    const absolute = typeof path === "string" ? resolve(path) : "";
    return original(absolute.startsWith(DIST + sep) ? join(directory, relative(DIST, absolute)) : path, ...rest);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

// Wrapper-mechanics fixture only: these tests fake the artifact validator, and the
// real validator never accepts this profile (it requires deploymentApproved=false).
function approvedUploadFixture(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), "site-upload-wrapper-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(join(directory, ".vite"));
  fs.writeFileSync(join(directory, ".vite/local-operational-profile.json"), JSON.stringify({ deploymentApproved: true }));
  distReadsFrom(t, directory);
}

function fakeDeployment(options = {}) {
  const calls = [];
  let snapshots = 0;
  const execute = (command, args, configuration) => {
    calls.push({ command, args, configuration });
    if (command === "git") {
      assert.equal(configuration.env.CLOUDFLARE_API_TOKEN, undefined);
      if (args[0] === "rev-parse") return options.head ?? SHA;
      if (args[0] === "ls-tree") return ""; // Historical pre-enrollment wrapper fixture.
      assert.deepEqual(args, ["status", "--porcelain", "--untracked-files=all"]);
      snapshots++;
      return options.status?.(snapshots) ?? "";
    }
    if (args.includes("deploy")) return "";
    assert.equal(command, process.execPath);
    assert.equal(configuration.env.CLOUDFLARE_API_TOKEN, undefined);
    assert.equal(configuration.env.GITHUB_SHA, SHA);
    assert.deepEqual(args.slice(-3), [DIST, "production", SHA]);
    if (options.validationFailure) throw new Error("synthetic OFF artifact rejection");
    return "";
  };
  return { calls, execute };
}
const uploads = f => f.calls.filter(call => call.args.includes("deploy"));

test("OFF promotion validates an existing-worker artifact before the synthetic credentialled upload boundary", t => {
  approvedUploadFixture(t);
  const f = fakeDeployment();
  deploy("site", ["production-off", SHA], deploymentParent(), f.execute);
  const upload = uploads(f);
  assert.equal(upload.length, 1);
  assert.equal(f.calls.at(-1), upload[0]);
  const args = upload[0].args;
  assert.equal(args[args.indexOf("--config") + 1], "site-worker/rebuild.production.wrangler.toml");
  assert.equal(args[args.indexOf("--env") + 1], "");
  assert.equal(args[args.indexOf("--tag") + 1], SHA);
  // The upload names the same artifact the validator and authorization checked.
  assert.equal(args[args.indexOf("--assets") + 1], DIST);
  assert.equal(upload[0].configuration.env.CLOUDFLARE_ACCOUNT_ID, ACCOUNT);
  assert.equal(upload[0].configuration.env.CLOUDFLARE_API_TOKEN, TOKEN);
  assert.equal(f.calls.filter(call => call.command === "git").length, 5);
  assert.equal(f.calls.filter(call => call.args.includes("--input-type=module")).length, 1);
});

test("OFF promotion refuses wrong approved account, worker or hostname before any subprocess boundary", () => {
  for (const changes of [
    { CLOUDFLARE_ACCOUNT_ID: "b".repeat(32), SITE_DEPLOY_ACCOUNT_ID: "b".repeat(32) },
    { SITE_DEPLOY_WORKER: "collection-kit-site-v2-production" },
    { SITE_DEPLOY_HOSTNAME: "staging.nikkecollection.com" },
  ]) {
    const f = fakeDeployment();
    assert.throws(() => deploy("site", ["production-off", SHA], deploymentParent(changes), f.execute));
    assert.equal(f.calls.length, 0);
  }
});

for (const [label, options] of [
  ["wrong HEAD", { head: "b".repeat(40) }],
  ["tracked changes", { status: () => " M src/application.ts" }],
  ["untracked changes", { status: () => "?? scripts/unsealed-candidate.mjs" }],
  ["source changed after artifact validation", { status: count => count === 2 ? " M src/application.ts" : "" }],
  ["rejected artifact", { validationFailure: true }],
]) {
  test(`OFF promotion rejects ${label} without invoking upload`, t => {
    approvedUploadFixture(t);
    const f = fakeDeployment(options);
    assert.throws(() => deploy("site", ["production-off", SHA], deploymentParent(), f.execute));
    assert.equal(uploads(f).length, 0);
  });
}

test("the Site OFF selector grants no implicit Stats deployment authority", () => {
  const f = fakeDeployment();
  assert.throws(() => deploy("stats", ["production-off", SHA], deploymentParent(), f.execute));
  assert.equal(f.calls.length, 0);
});

test("every Site upload mode rejects the validated NONDEPLOYABLE FUSED artifact before Wrangler receives credentials", async t => {
  const f = await artifact(t);
  // As emitted by serviceH14ReceiptPlugin for the bundled FUSED candidate.
  await f.json(".vite/service-h14.json", {
    version: 1, status: "NONDEPLOYABLE_SERVICE_CANDIDATE", promotionGate: "NOT_APPROVED",
    publicationApproved: false, analyticsProviderApproved: false,
  });
  // Local packaging stays possible: the real OFF validator accepts this artifact.
  await assertProductionOffSiteProfile(f.directory, SHA);
  assert.throws(() => assertSiteUploadApproved(f.directory), { message: "site_upload_nondeployable_artifact" });
  distReadsFrom(t, f.directory);
  const production = ["collection-kit-site-production", "nikkecollection.com", "production"];
  for (const [selection, worker, hostname, target] of [
    ["production", ...production], ["production-off", ...production], ["production-online", ...production],
    ["production-online-sealed", ...production], ["rebuild-production", ...production],
    ["staging", "collection-kit-site-staging", "staging.nikkecollection.com", "staging"],
    ["rebuild-staging", "collection-kit-site-v2-staging", "staging.nikkecollection.com", "staging"],
  ]) {
    const calls = [];
    const execute = (command, args, options) => {
      calls.push({ command, args });
      // Reaching Wrangler would surface the token here instead of the authorization error.
      assert.equal(options.env.CLOUDFLARE_API_TOKEN, undefined);
      assert.equal(options.env.CLOUDFLARE_ACCOUNT_ID, undefined);
      return command === "git" && args[0] === "rev-parse" ? SHA : "";
    };
    assert.throws(() => deploy("site", [selection, SHA], deploymentParent({
      SITE_DEPLOY_WORKER: worker, SITE_DEPLOY_HOSTNAME: hostname,
      SITE_RELEASE_DIR: f.directory, SITE_RELEASE_MANIFEST_SHA256: "c".repeat(64),
      GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1",
    }), execute), { message: "site_upload_nondeployable_artifact" }, selection);
    assert.equal(calls.some(call => call.args.includes("deploy")), false, selection);
    // Ordinary artifact validation still ran first, on the same dist the gate read.
    assert.deepEqual(calls.find(call => call.args.includes("--input-type=module"))?.args.slice(-3),
      [DIST, target, SHA], selection);
  }
});
