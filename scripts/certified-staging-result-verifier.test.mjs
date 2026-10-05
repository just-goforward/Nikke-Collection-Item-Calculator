import assert from "node:assert/strict";
import test from "node:test";
import { digest, ENGINES, verifyApproved24 } from "./certified-staging-result-verifier.mjs";

// In-memory fixtures only: importing or running these tests does not launch a browser,
// inspect a real checkout, write artifacts, or delete a temporary fixture directory.
const hash = digest("fixture");
const sourcePaths = [
  ...["snapshot.json", "independent-physical-cohorts.json", "provenance.json", "panel.json"].map(
    (name) => `scripts/certified-staging-approved-panel/${name}`,
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

function fixtureCampaign() {
  const q = { numerator: "1", denominator: "2" };
  const fixtureIds = Array.from({ length: 24 }, (_, index) => `approved-${index}`);
  const fixtures = fixtureIds.map((id) => ({
    id,
    input: { stock: [1, 2, 3] },
    expected: {
      successP: q,
      weightedExpectedConsumptionB: q,
      expectedTotalConsumptionC: q,
      expectedConsumed: [q, q, q],
      action: "blue",
      mask: 1,
      rates: [q, q, q],
      prices: [q, q, q],
      cohortWeights: [q, q, q],
      actionGaps: [{ action: "blue", optimal: true }],
    },
  }));
  const worker = { urlPath: "/assets/browserWorker-fixture.js", bytes: 42, sha256: hash };
  const client = { urlPath: "/assets/CertifiedCalculator-fixture.js", bytes: 52, sha256: hash };
  const adapter = { urlPath: "/__certified_dist_client.js", bytes: 62, sha256: hash };
  const profile = { id: "reviewed-fixture-engine", codeHash: hash };
  const source = {
    commit: "a".repeat(40),
    sha256: hash,
    lockSha256: hash,
    files: sourcePaths.map((path) => ({ path, sha256: hash, bytes: 1 })),
  };
  const expected = {
    version: "certified-staging-approved24-expected-v1",
    source,
    dist: {
      assets: [worker, client],
      worker,
      shippedClient: client,
      inventorySha256: hash,
      manifestSha256: hash,
    },
    fixtureIds,
    fixtures,
    scenarioSha256: hash,
    engineProfile: profile,
    browsers: Object.fromEntries(
      ENGINES.map((name) => [
        name,
        {
          executable: `/installed/${name}`,
          executableSha256: hash,
          version: "1.0",
        },
      ]),
    ),
    platform: "linux",
    node: "v24.21.0",
    proofBoundary: "approved24 only",
  };
  const reports = ENGINES.map((browser) => ({
    version: "certified-staging-independent-dist-worker-v1",
    status: "passed",
    retry: 0,
    runId: "fixture-campaign",
    browser,
    browserVersion: "1.0",
    browserExecutable: `/installed/${browser}`,
    browserExecutableSha256: hash,
    launchOptions: { executablePath: `/installed/${browser}`, headless: true },
    expectedManifestSha256: hash,
    candidateIdentity: {
      commit: source.commit,
      sourceSha256: hash,
      lockSha256: hash,
      distInventorySha256: hash,
    },
    sourceProvenance: source.files.map(({ path, sha256 }) => ({ path, sha256 })),
    sourcesStable: true,
    scenarioSha256: hash,
    distProvenance: { ...expected.dist, manifest: { sha256: hash } },
    verifiedHttpResponses: expected.dist.assets,
    clientAdapter: adapter,
    served: [adapter, worker],
    servedResponses: [worker, worker, client],
    workerUrls: [`http://127.0.0.1:4321${worker.urlPath}`],
    platform: expected.platform,
    node: expected.node,
    userAgent: `${browser} actual runtime`,
    profile,
    cases: 24,
    pass: 24,
    fail: 0,
    failures: [],
    pageErrors: [],
    checks: fixtures.map((fixture) => ({
      id: fixture.id,
      independentCurrent: "PASS",
      directCandidateWaitingParity: "PASS",
      status: "partial",
      waitingStatus: "unresolved",
      independentWaitingProof: "NOTRUN_in_this_dist_suite",
      independentWaitingGap: "NOTRUN_in_this_dist_suite",
      workerActionGapFieldComparison: "NOTAVAILABLE_no_Worker_API_field",
      independentCurrentActionGaps: fixture.expected.actionGaps,
      failures: [],
    })),
    rows: fixtures.map((fixture) => ({
      id: fixture.id,
      engineProfile: profile,
      output: {
        status: "partial",
        waiting: { status: "unresolved" },
        current: {
          value: {
            successP: fixture.expected.successP,
            weightedExpectedConsumptionB: fixture.expected.weightedExpectedConsumptionB,
            expectedTotalConsumptionC: fixture.expected.expectedTotalConsumptionC,
            expectedConsumed: fixture.expected.expectedConsumed,
          },
          kit: fixture.expected.action,
          optimalActionMask: fixture.expected.mask,
        },
        pricing: {
          recurringRate: fixture.expected.rates,
          weights: fixture.expected.prices,
          cohortWeights: fixture.expected.cohortWeights,
          basisStock: fixture.input.stock,
        },
      },
    })),
  }));
  // Break reference aliases so a forged report cannot mutate its independent expectation.
  return {
    expected: structuredClone(expected),
    reports: structuredClone(reports),
    options: { manifestSha256: hash, commandExitCode: 0 },
  };
}

test("accepts exactly three genuine complete approved24 engine campaigns", () => {
  const { expected, reports, options } = fixtureCampaign();
  const verdict = verifyApproved24(expected, reports, options);
  assert.equal(verdict.status, "PASS");
  assert.deepEqual(verdict.engines, ENGINES);
  assert.equal(verdict.casesPerEngine, 24);
  assert.equal(verdict.proofBoundary, "approved24 only");
});

const corruptions = [
  ["missing Firefox", ({ reports }) => reports.splice(1, 1)],
  [
    "unknown engine",
    ({ reports }) => {
      reports[1].browser = "unknown";
    },
  ],
  [
    "duplicate engine",
    ({ reports }) => {
      reports[1] = structuredClone(reports[0]);
    },
  ],
  ["extra retry report", ({ reports }) => reports.push(structuredClone(reports[0]))],
  [
    "mixed campaigns",
    ({ reports }) => {
      reports[1].runId = "different-campaign";
    },
  ],
  [
    "failure-only report",
    ({ reports }) => {
      reports[1] = { browser: "firefox", status: "failed" };
    },
  ],
  [
    "retry accepted as clean",
    ({ reports }) => {
      reports[1].retry = 1;
    },
  ],
  [
    "outer command failed",
    ({ options }) => {
      options.commandExitCode = 1;
    },
  ],
  [
    "outer command exit missing",
    ({ options }) => {
      options.commandExitCode = undefined;
    },
  ],
  [
    "expected manifest drift",
    ({ reports }) => {
      reports[1].expectedManifestSha256 = digest("other");
    },
  ],
  [
    "candidate commit drift",
    ({ reports }) => {
      reports[1].candidateIdentity.commit = "b".repeat(40);
    },
  ],
  [
    "source inventory drift",
    ({ reports }) => {
      reports[1].candidateIdentity.sourceSha256 = digest("other");
    },
  ],
  [
    "lock drift",
    ({ reports }) => {
      reports[1].candidateIdentity.lockSha256 = digest("other");
    },
  ],
  [
    "scenario drift",
    ({ reports }) => {
      reports[1].scenarioSha256 = digest("other");
    },
  ],
  [
    "source mutation",
    ({ reports }) => {
      reports[1].sourcesStable = false;
    },
  ],
  [
    "missing mandatory source",
    ({ reports }) => {
      reports[1].sourceProvenance.pop();
    },
  ],
  [
    "source hash forgery",
    ({ reports }) => {
      reports[1].sourceProvenance[0].sha256 = digest("other");
    },
  ],
  [
    "unknown source",
    ({ reports }) => {
      reports[1].sourceProvenance.push({ path: "../outside", sha256: hash });
    },
  ],
  [
    "duplicate source",
    ({ reports }) => {
      reports[1].sourceProvenance.push(reports[1].sourceProvenance[0]);
    },
  ],
  [
    "dist mismatch",
    ({ reports }) => {
      reports[1].distProvenance.inventorySha256 = digest("other");
    },
  ],
  [
    "served asset hash forgery",
    ({ reports }) => {
      reports[1].verifiedHttpResponses = [
        { ...reports[1].verifiedHttpResponses[0], sha256: digest("other") },
      ];
    },
  ],
  [
    "wrong executable",
    ({ reports }) => {
      reports[1].browserExecutable = "/unused/firefox";
    },
  ],
  [
    "wrong executable hash",
    ({ reports }) => {
      reports[1].browserExecutableSha256 = digest("other");
    },
  ],
  [
    "version-only claimed compatible",
    ({ reports }) => {
      reports[1].browserVersion = "155.0";
    },
  ],
  [
    "launch differs from reported executable",
    ({ reports }) => {
      reports[1].launchOptions.executablePath = "/other/firefox";
    },
  ],
  [
    "engine profile mismatch",
    ({ reports }) => {
      reports[1].profile = { id: "other" };
    },
  ],
  [
    "returned row engine mismatch",
    ({ reports }) => {
      reports[1].rows[0].engineProfile = { id: "other" };
    },
  ],
  [
    "short fixture count",
    ({ reports }) => {
      reports[1].cases = 23;
    },
  ],
  [
    "failed case count",
    ({ reports }) => {
      reports[1].fail = 1;
    },
  ],
  [
    "hidden failure detail",
    ({ reports }) => {
      reports[1].failures = ["oracle mismatch"];
    },
  ],
  [
    "page error",
    ({ reports }) => {
      reports[1].pageErrors = ["module failed"];
    },
  ],
  [
    "fixture order changed",
    ({ reports }) => {
      reports[1].rows.reverse();
    },
  ],
  [
    "duplicate fixture",
    ({ reports }) => {
      reports[1].rows[1].id = reports[1].rows[0].id;
    },
  ],
  [
    "forged PASS with wrong current oracle",
    ({ reports }) => {
      reports[1].rows[0].output.current.value.successP = { numerator: "0", denominator: "1" };
    },
  ],
  [
    "forged PASS with wrong pricing",
    ({ reports }) => {
      reports[1].rows[0].output.pricing.weights = [];
    },
  ],
  [
    "waiting parity failure",
    ({ reports }) => {
      reports[1].checks[0].directCandidateWaitingParity = "FAIL";
    },
  ],
  [
    "waiting status label mismatch",
    ({ reports }) => {
      reports[1].checks[0].waitingStatus = "certified";
    },
  ],
  [
    "overclaimed independent waiting proof",
    ({ reports }) => {
      reports[1].checks[0].independentWaitingProof = "PASS";
    },
  ],
  [
    "missing Worker observation",
    ({ reports }) => {
      reports[1].workerUrls = [];
    },
  ],
  [
    "non-local Worker URL",
    ({ reports }) => {
      reports[1].workerUrls = ["https://example.invalid/assets/browserWorker-fixture.js"];
    },
  ],
  [
    "missing Worker fetched bytes",
    ({ reports }) => {
      reports[1].served = [];
    },
  ],
  [
    "missing repeated Worker serve",
    ({ reports }) => {
      reports[1].servedResponses = [];
    },
  ],
];

for (const [name, corrupt] of corruptions) {
  test(`rejects ${name} without trusting report PASS counters`, () => {
    const campaign = fixtureCampaign();
    corrupt(campaign);
    assert.throws(() => verifyApproved24(campaign.expected, campaign.reports, campaign.options));
  });
}
