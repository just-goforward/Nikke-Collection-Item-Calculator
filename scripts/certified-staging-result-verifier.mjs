import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const ENGINES = ["chromium", "firefox", "webkit"];
const RESULT_VERSION = "certified-staging-independent-dist-worker-v1";
const EXPECTED_VERSION = "certified-staging-approved24-expected-v1";
const PANEL_ROOT = "scripts/certified-staging-approved-panel";
const PANEL_INDICES = [
  0, 1, 3, 4, 8, 15, 17, 21, 26, 29, 30, 31, 61, 73, 99, 137, 211, 313, 517, 731, 991, 1237, 1619,
  1999,
];
const REQUIRED_SOURCES = [
  ...["snapshot.json", "independent-physical-cohorts.json", "provenance.json", "panel.json"].map(
    (name) => `${PANEL_ROOT}/${name}`,
  ),
  "scripts/certified-staging-approved-panel.ts",
  "scripts/generate-certified-staging-approved-panel.ts",
  "scripts/certified-staging-oracle.ts",
  "scripts/certified-staging-oracle-fixtures.ts",
  "scripts/certified-staging-oracle-physical-supply.ts",
  "scripts/certified-staging-dist-validation.ts",
  "shared/game.ts",
  "e2e/certified-staging-api.spec.ts",
  "package-lock.json",
];
export const digest = (value) => createHash("sha256").update(value).digest("hex");
const jsonDigest = (value) => digest(JSON.stringify(value));
const fileDigest = (path) => digest(readFileSync(path));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const slash = (path) => path.split(sep).join("/");
const assertHash = (value, label) => assert.match(value ?? "", /^[a-f0-9]{64}$/, label);
const assertNonempty = (value, label) =>
  assert.ok(typeof value === "string" && value.length, label);

function writeNewJson(path, value) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function sourceSnapshot(commit) {
  assert.match(commit ?? "", /^[a-f0-9]{40}$/, "explicit candidate commit must be a full SHA");
  const git = (args) => execFileSync("git", ["--no-optional-locks", ...args], { encoding: "utf8" });
  const actualCommit = git(["rev-parse", "HEAD"]).trim();
  assert.equal(actualCommit, commit, "actual checkout HEAD differs from approved candidate commit");
  // Deterministic generators must not quietly relabel changed tracked bytes as this commit.
  // Only filenames are printed on drift, and Git's optional index writes are disabled.
  git(["diff", "--no-ext-diff", "--no-textconv", "--exit-code", "--name-only", "HEAD", "--"]);
  const paths = git(["ls-files", "-z"]).split("\0").filter(Boolean).sort();
  const trackedPaths = new Set(paths);
  assert.equal(trackedPaths.size, paths.length, "duplicate tracked source path");
  for (const path of REQUIRED_SOURCES)
    assert.ok(trackedPaths.has(path), `missing required tracked source: ${path}`);
  const files = paths.map((path) => {
    assert.ok(lstatSync(path).isFile(), `source is not a regular file: ${path}`);
    const bytes = readFileSync(path);
    return { path, bytes: bytes.length, sha256: digest(bytes) };
  });
  assert.ok(files.length > 0, "empty source inventory");
  return { commit, files, sha256: jsonDigest(files), lockSha256: fileDigest("package-lock.json") };
}

function distSnapshot() {
  const root = resolve("dist");
  const assets = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      assert.ok(!entry.isSymbolicLink(), `dist symlink is not accepted: ${path}`);
      if (entry.isDirectory()) walk(path);
      else {
        assert.ok(entry.isFile(), `dist is not a regular file: ${path}`);
        const bytes = readFileSync(path);
        assets.push({
          urlPath: `/${slash(relative(root, path))}`,
          bytes: bytes.length,
          sha256: digest(bytes),
        });
      }
    }
  };
  walk(root);
  assets.sort((first, second) => first.urlPath.localeCompare(second.urlPath));
  const manifest = readJson("dist/.vite/manifest.json");
  const client = manifest["src/certifiedUi/CertifiedCalculator.tsx"];
  assert.ok(client, "certified client missing from dist manifest");
  const workers =
    client.assets?.filter((path) => /^assets\/browserWorker-[^/]+\.js$/.test(path)) ?? [];
  assert.equal(workers.length, 1, "expected one shipped certified Worker");
  const asset = (path) => {
    const found = assets.find((row) => row.urlPath === `/${path}`);
    assert.ok(found, `missing dist asset: ${path}`);
    return found;
  };
  return {
    assets,
    inventorySha256: jsonDigest(assets),
    manifestSha256: fileDigest("dist/.vite/manifest.json"),
    worker: asset(workers[0]),
    shippedClient: asset(client.file),
  };
}

function expectedProfile() {
  const generated = readFileSync("shared/generated/certifiedEngineBuild.ts", "utf8");
  const codeHash = /CERTIFIED_ENGINE_CODE_HASH = "([a-f0-9]{64})"/.exec(generated)?.[1];
  assertHash(codeHash, "generated engine code hash missing");
  const wasmGenerated = readFileSync("shared/generated/certifiedWasmBuild.ts", "utf8");
  const wasmHash = /CERTIFIED_WASM_HASH = "([a-f0-9]{64})"/.exec(wasmGenerated)?.[1];
  assertHash(wasmHash, "generated WASM hash missing");
  assert.equal(fileDigest("public/certified_solver.wasm"), wasmHash, "pinned WASM hash drift");
  // This reviewed contract deliberately fails if the product profile evolves.
  return {
    id: "certified-staging-v1",
    environment: "staging",
    schemaVersion: "certified-daily-v1",
    priceVersion: "stock-plus-recurring-day-v1",
    solverVersion: "certified-exact-rust-wasm-v1",
    lawVersion: "documented-physical-supply-v1",
    wasmHash,
    codeHash,
    cacheNamespace: `certified-staging-v1:${codeHash}`,
    sessionNamespace: "collection-certified-staging-v1",
    diagnosticsEnvironment: "staging",
    recoveryEnvironment: "staging",
  };
}

export async function freezeExpected(commit) {
  const source = sourceSnapshot(commit);
  const panel = readJson(`${PANEL_ROOT}/panel.json`);
  assert.deepEqual(
    panel.map((row) => row.originalIndex),
    PANEL_INDICES,
    "approved24 panel changed",
  );
  assert.equal(new Set(panel.map((row) => row.id)).size, 24, "approved24 IDs must be unique");
  const snapshot = readJson(`${PANEL_ROOT}/snapshot.json`);
  const scenarios = panel.map((row) => ({ ...row, input: { ...row.input, snapshot } }));
  const require = createRequire(import.meta.url);
  const coreRoot = dirname(require.resolve("playwright-core/package.json"));
  const registry = readJson(resolve(coreRoot, "browsers.json"));
  const playwright = await import("@playwright/test");
  const browsers = Object.fromEntries(
    ENGINES.map((name) => {
      const executable = playwright[name].executablePath();
      const descriptor = registry.browsers.find((row) => row.name === name);
      assert.ok(descriptor?.browserVersion, `missing ${name} browser descriptor`);
      assert.ok(lstatSync(executable).isFile(), `missing ${name} launch entrypoint`);
      return [
        name,
        {
          executable,
          executableSha256: fileDigest(executable),
          version: descriptor.browserVersion,
          revision: descriptor.revision,
          revisionOverrides: descriptor.revisionOverrides ?? {},
        },
      ];
    }),
  );
  return {
    version: EXPECTED_VERSION,
    frozenAt: new Date().toISOString(),
    source,
    dist: distSnapshot(),
    fixtureIds: panel.map((row) => row.id),
    fixtures: panel,
    scenarioSha256: jsonDigest(scenarios),
    engineProfile: expectedProfile(),
    browsers,
    platform: process.platform,
    node: process.version,
    playwrightVersion: readJson(resolve(coreRoot, "package.json")).version,
    browserRegistrySha256: fileDigest(resolve(coreRoot, "browsers.json")),
    proofBoundary:
      "approved24 current oracle and candidate waiting parity; not independent waiting/gap, current2000, population latency, heap/RSS, child-library or OS transport attestation",
  };
}

const assetIdentity = ({ urlPath, bytes, sha256 }) => ({ urlPath, bytes, sha256 });

/** Pure validation: reports cannot define their own fixture, source, engine or build expectations. */
export function verifyApproved24(expected, reports, { manifestSha256, commandExitCode }) {
  assert.equal(expected.version, EXPECTED_VERSION, "unsupported expected manifest");
  assertHash(manifestSha256, "expected manifest hash missing");
  assert.equal(commandExitCode, 0, "general E2E command failed; partial approved24 is not PASS");
  assert.equal(expected.fixtureIds.length, 24, "expected fixture count is not approved24");
  assert.equal(new Set(expected.fixtureIds).size, 24, "duplicate expected fixture ID");
  assert.deepEqual(
    expected.fixtures.map((row) => row.id),
    expected.fixtureIds,
  );
  assert.equal(
    reports.length,
    3,
    "expected exactly three successful engine reports; failure/retry evidence is not hidden",
  );
  assert.deepEqual(
    reports.map((row) => row.browser).sort(),
    [...ENGINES].sort(),
    "missing, duplicate or unknown engine",
  );
  assert.equal(
    new Set(reports.map((row) => row.runId)).size,
    1,
    "engines belong to different campaigns",
  );
  const sourcePins = new Map(expected.source.files.map((row) => [row.path, row.sha256]));
  for (const report of reports) {
    const label = report.browser;
    assert.equal(report.version, RESULT_VERSION, `${label}: failure or unknown report`);
    assert.equal(report.status, "passed", `${label}: report not passed`);
    assertNonempty(report.runId, `${label}: campaign identity missing`);
    assert.equal(report.retry, 0, `${label}: retry/flaky execution is retained but not accepted`);
    assert.equal(
      report.expectedManifestSha256,
      manifestSha256,
      `${label}: expected manifest drift`,
    );
    assert.deepEqual(
      report.candidateIdentity,
      {
        commit: expected.source.commit,
        sourceSha256: expected.source.sha256,
        lockSha256: expected.source.lockSha256,
        distInventorySha256: expected.dist.inventorySha256,
      },
      `${label}: candidate identity drift`,
    );
    assert.equal(report.scenarioSha256, expected.scenarioSha256, `${label}: scenario drift`);
    assert.equal(report.sourcesStable, true, `${label}: source mutated`);
    assert.ok(Array.isArray(report.sourceProvenance), `${label}: missing source provenance`);
    assert.equal(
      new Set(report.sourceProvenance.map((row) => row.path)).size,
      report.sourceProvenance.length,
      `${label}: duplicate source path`,
    );
    for (const pin of report.sourceProvenance) {
      assert.ok(sourcePins.has(pin.path), `${label}: untracked/unknown source ${pin.path}`);
      assert.equal(pin.sha256, sourcePins.get(pin.path), `${label}: source hash drift ${pin.path}`);
    }
    for (const path of REQUIRED_SOURCES)
      assert.ok(
        report.sourceProvenance.some((pin) => pin.path === path),
        `${label}: missing source ${path}`,
      );
    assert.equal(
      report.distProvenance.inventorySha256,
      expected.dist.inventorySha256,
      `${label}: dist inventory drift`,
    );
    assert.equal(
      report.distProvenance.manifest.sha256,
      expected.dist.manifestSha256,
      `${label}: manifest drift`,
    );
    assert.deepEqual(
      report.distProvenance.assets.map(assetIdentity),
      expected.dist.assets,
      `${label}: dist assets drift`,
    );
    assert.deepEqual(
      assetIdentity(report.distProvenance.worker),
      expected.dist.worker,
      `${label}: Worker drift`,
    );
    assert.deepEqual(
      assetIdentity(report.distProvenance.shippedClient),
      expected.dist.shippedClient,
      `${label}: client drift`,
    );
    assert.deepEqual(
      report.verifiedHttpResponses,
      expected.dist.assets,
      `${label}: HTTP asset identity mismatch`,
    );
    const runtime = expected.browsers[label];
    assert.equal(report.browserExecutable, runtime.executable, `${label}: launch entrypoint drift`);
    assert.equal(
      report.browserExecutableSha256,
      runtime.executableSha256,
      `${label}: launch entrypoint hash drift`,
    );
    assert.equal(
      report.browserVersion,
      runtime.version,
      `${label}: actual runtime version differs from installed revision descriptor`,
    );
    assert.deepEqual(
      report.launchOptions,
      { executablePath: runtime.executable, headless: true },
      `${label}: launch options differ from pinned entrypoint`,
    );
    assert.equal(report.platform, expected.platform, `${label}: OS drift`);
    assert.equal(report.node, expected.node, `${label}: Node drift`);
    assertNonempty(report.userAgent, `${label}: browser runtime evidence missing`);
    assert.deepEqual(report.profile, expected.engineProfile, `${label}: engine profile drift`);
    assert.equal(report.cases, 24, `${label}: incomplete cases`);
    assert.equal(report.pass, 24, `${label}: incomplete pass count`);
    assert.equal(report.fail, 0, `${label}: failing case count`);
    assert.deepEqual(report.failures, [], `${label}: failures are present`);
    assert.deepEqual(report.pageErrors, [], `${label}: page errors are present`);
    assert.deepEqual(
      report.rows.map((row) => row.id),
      expected.fixtureIds,
      `${label}: row fixture identity/order drift`,
    );
    assert.deepEqual(
      report.checks.map((row) => row.id),
      expected.fixtureIds,
      `${label}: check fixture identity/order drift`,
    );
    for (const [index, fixture] of expected.fixtures.entries()) {
      const check = report.checks[index];
      const row = report.rows[index];
      assert.deepEqual(
        row.engineProfile,
        expected.engineProfile,
        `${label}/${fixture.id}: returned profile drift`,
      );
      assert.equal(check.independentCurrent, "PASS");
      assert.equal(check.directCandidateWaitingParity, "PASS");
      assert.ok(["completed", "partial", "refused"].includes(row.output.status));
      assert.ok(
        ["certified", "unresolved", "claim_required", "not_requested"].includes(
          row.output.waiting.status,
        ),
      );
      assert.equal(check.status, row.output.status);
      assert.equal(check.waitingStatus, row.output.waiting.status);
      assert.equal(check.independentWaitingProof, "NOTRUN_in_this_dist_suite");
      assert.equal(check.independentWaitingGap, "NOTRUN_in_this_dist_suite");
      assert.equal(check.workerActionGapFieldComparison, "NOTAVAILABLE_no_Worker_API_field");
      assert.deepEqual(check.independentCurrentActionGaps, fixture.expected.actionGaps);
      assert.deepEqual(check.failures, [], `${label}/${fixture.id}: failures`);
      for (const key of [
        "successP",
        "weightedExpectedConsumptionB",
        "expectedTotalConsumptionC",
        "expectedConsumed",
      ])
        assert.deepEqual(
          row.output.current.value[key],
          fixture.expected[key],
          `${label}/${fixture.id}: ${key}`,
        );
      assert.equal(row.output.current.kit, fixture.expected.action);
      assert.equal(row.output.current.optimalActionMask, fixture.expected.mask);
      for (const [actual, oracle] of [
        ["recurringRate", "rates"],
        ["weights", "prices"],
        ["cohortWeights", "cohortWeights"],
      ])
        assert.deepEqual(row.output.pricing[actual], fixture.expected[oracle]);
      assert.deepEqual(row.output.pricing.basisStock, fixture.input.stock);
    }
    assertHash(report.clientAdapter.sha256, `${label}: missing adapter hash`);
    assert.ok(report.clientAdapter.bytes > 0, `${label}: empty adapter`);
    assert.deepEqual(
      report.served,
      [assetIdentity(report.clientAdapter), expected.dist.worker],
      `${label}: browser fetched identity drift`,
    );
    assert.ok(report.workerUrls.length > 0, `${label}: no actual Worker observed`);
    for (const url of report.workerUrls) {
      const parsed = new URL(url);
      assert.equal(parsed.protocol, "http:");
      assert.equal(parsed.hostname, "127.0.0.1");
      assert.equal(parsed.pathname, expected.dist.worker.urlPath);
    }
    const servedPins = new Map(
      [...expected.dist.assets, assetIdentity(report.clientAdapter)].map((row) => [
        row.urlPath,
        row,
      ]),
    );
    for (const served of report.servedResponses)
      assert.deepEqual(
        assetIdentity(served),
        servedPins.get(served.urlPath),
        `${label}: served response drift`,
      );
    assert.ok(
      report.servedResponses.filter((row) => row.urlPath === expected.dist.worker.urlPath).length >
        1,
      `${label}: Worker fetch evidence missing`,
    );
  }
  return {
    status: "PASS",
    engines: [...ENGINES],
    casesPerEngine: 24,
    expectedManifestSha256: manifestSha256,
    proofBoundary: expected.proofBoundary,
  };
}

function collectReports(root) {
  const files = [];
  const walk = (directory, inCampaign = false) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      assert.ok(!entry.isSymbolicLink(), `result symlink is not accepted: ${path}`);
      if (entry.isDirectory())
        walk(path, inCampaign || entry.name.startsWith("certified-staging-dist-"));
      else if (
        inCampaign &&
        entry.name.endsWith(".json") &&
        !["approved-panel.json", "dist-provenance.json"].includes(entry.name)
      )
        files.push(path);
    }
  };
  walk(resolve(root));
  return files.sort().map((path) => ({ path, sha256: fileDigest(path), report: readJson(path) }));
}

function verifyFrozenInputs(expected) {
  assert.deepEqual(
    sourceSnapshot(expected.source.commit),
    expected.source,
    "tracked sources/lock changed after freeze",
  );
  assert.deepEqual(distSnapshot(), expected.dist, "dist changed after freeze");
  for (const [name, browser] of Object.entries(expected.browsers))
    assert.equal(
      fileDigest(browser.executable),
      browser.executableSha256,
      `${name}: executable changed after freeze`,
    );
}

async function main(args) {
  const [command, ...pairs] = args;
  assert.equal(pairs.length % 2, 0, "arguments must be option/value pairs");
  const options = Object.fromEntries(
    Array.from({ length: pairs.length / 2 }, (_, index) => [
      pairs[index * 2],
      pairs[index * 2 + 1],
    ]),
  );
  assertNonempty(options["--expected"], "--expected is required");
  if (command === "freeze") {
    const expected = await freezeExpected(options["--commit"]);
    writeNewJson(options["--expected"], expected);
    console.info(
      JSON.stringify({
        status: "FROZEN",
        path: resolve(options["--expected"]),
        sha256: fileDigest(options["--expected"]),
        commit: expected.source.commit,
      }),
    );
    return;
  }
  assert.equal(command, "verify", "expected freeze or verify");
  assertNonempty(options["--results"], "--results is required");
  assertNonempty(options["--output"], "--output is required");
  let records = [];
  let verdict;
  try {
    const expected = readJson(options["--expected"]);
    const manifestSha256 = fileDigest(options["--expected"]);
    records = collectReports(options["--results"]);
    verifyFrozenInputs(expected);
    verdict = verifyApproved24(
      expected,
      records.map((row) => row.report),
      {
        manifestSha256,
        commandExitCode: Number(options["--command-exit-code"] ?? Number.NaN),
      },
    );
  } catch (error) {
    verdict = { status: "FAIL", error: error instanceof Error ? error.stack : String(error) };
    process.exitCode = 1;
  }
  writeNewJson(options["--output"], {
    ...verdict,
    generatedAt: new Date().toISOString(),
    evidence: records.map(({ path, sha256, report }) => ({
      path,
      sha256,
      browser: report.browser,
      status: report.status,
      retry: report.retry,
    })),
  });
  console.info(JSON.stringify({ status: verdict.status, output: resolve(options["--output"]) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
