import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { digest, ENGINES, verifyApproved24 } from "./certified-staging-result-verifier.mjs";

// Pure report tests are followed by real Git repositories and child freeze CLI tests.
// Fixtures copy actual source bytes and preserve repositories, configs and command receipts.
// Only the positive freeze fixture gets synthetic dist/browser metadata and inert binaries.
// These tests never import or execute the panel generator and never launch a browser.
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

const verifierPath = "scripts/certified-staging-result-verifier.mjs";
const generatedPath = "shared/generated/certifiedEngineBuild.ts";
const generatorPath = "scripts/generate-certified-staging-approved-panel.ts";
const fixtureIdentity = {
  name: "Certified Freeze Fixture",
  email: "certified-freeze-fixture@example.invalid",
};
const diffArgs = [
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--exit-code",
  "--name-only",
  "HEAD",
  "--",
];

function resolveFixtureGit() {
  const explicit = process.env.CERTIFIED_TEST_GIT;
  const inheritedPath =
    Object.entries(process.env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  if (explicit) assert.ok(isAbsolute(explicit), "CERTIFIED_TEST_GIT must be absolute");
  const candidates = explicit
    ? [explicit]
    : inheritedPath
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory.replace(/^"|"$/g, ""), "git"));
  for (const candidate of candidates) {
    const path = process.platform === "win32" && !explicit ? `${candidate}.exe` : candidate;
    if (!existsSync(path)) continue;
    const git = realpathSync(path);
    assert.ok(isAbsolute(git), "resolved Git path must be absolute");
    assert.match(basename(git), /^git(?:\.exe)?$/i, "resolved executable must be Git");
    assert.ok(lstatSync(git).isFile(), "resolved Git executable must be a regular file");
    accessSync(git, constants.X_OK);
    return { git, inheritedPath };
  }
  assert.fail("Git is required: set CERTIFIED_TEST_GIT to an absolute executable path");
}

function writeFixtureJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function fixtureEnvironment(root, git, inheritedPath) {
  const configRoot = join(root, "config");
  mkdirSync(configRoot);
  const paths = Object.fromEntries(
    ["global", "system", "attributes", "excludes"].map((name) => {
      const path = join(configRoot, name);
      writeFileSync(path, "", { flag: "wx" });
      return [name, path];
    }),
  );
  paths.hooks = join(configRoot, "hooks");
  paths.template = join(configRoot, "template");
  mkdirSync(paths.hooks);
  mkdirSync(paths.template);
  const settings = [
    ["user.name", fixtureIdentity.name],
    ["user.email", fixtureIdentity.email],
    ["user.useConfigOnly", "true"],
    ["core.hooksPath", paths.hooks],
    ["commit.gpgSign", "false"],
    ["tag.gpgSign", "false"],
    ["core.autocrlf", "false"],
    ["core.eol", "lf"],
    ["core.attributesFile", paths.attributes],
    ["core.excludesFile", paths.excludes],
    ["core.longpaths", "true"],
    ["core.fsmonitor", "false"],
    ["core.untrackedCache", "false"],
    ["color.ui", "never"],
    ["init.defaultBranch", "certified-freeze-fixture"],
    ["init.templateDir", paths.template],
  ];
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(?:GIT_|GCM_|SSH_ASKPASS|NODE_OPTIONS$|NODE_PATH$|NODE_TEST_CONTEXT$)/i.test(key) &&
        !/^(?:FORCE_COLOR|CLICOLOR|CLICOLOR_FORCE)$/i.test(key) &&
        key.toUpperCase() !== "PATH",
    ),
  );
  Object.assign(env, {
    PATH: `${dirname(git)}${delimiter}${inheritedPath}`,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: paths.global,
    GIT_CONFIG_SYSTEM: paths.system,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: fixtureIdentity.name,
    GIT_AUTHOR_EMAIL: fixtureIdentity.email,
    GIT_COMMITTER_NAME: fixtureIdentity.name,
    GIT_COMMITTER_EMAIL: fixtureIdentity.email,
    GIT_AUTHOR_DATE: "2026-10-05T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-10-05T00:00:00Z",
    GIT_CONFIG_COUNT: String(settings.length),
    NO_COLOR: "1",
    LANG: "C",
    LC_ALL: "C",
  });
  for (const [index, [key, value]] of settings.entries()) {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  }
  return { env, config: { paths, settings: Object.fromEntries(settings) } };
}

function recordedCommand(fixture, label, command, args) {
  const number = String(++fixture.commandCount).padStart(2, "0");
  const prefix = join(fixture.receipts, `${number}-${label}`);
  const stdoutPath = `${prefix}.stdout`;
  const stderrPath = `${prefix}.stderr`;
  const receiptPath = `${prefix}.json`;
  const stdout = openSync(stdoutPath, "wx");
  const stderr = openSync(stderrPath, "wx");
  let result;
  try {
    result = spawnSync(command, args, {
      cwd: fixture.repo,
      env: fixture.env,
      stdio: ["ignore", stdout, stderr],
      windowsHide: true,
    });
  } catch (error) {
    result = { error, signal: null, status: null };
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
  const receipt = {
    command,
    args,
    cwd: fixture.repo,
    git: fixture.git,
    error: result.error
      ? {
          name: result.error.name,
          message: result.error.message,
          code: result.error.code ?? null,
          stack: result.error.stack,
        }
      : null,
    signal: result.signal ?? null,
    exitCode: result.status ?? null,
    stdoutPath,
    stderrPath,
    receiptPath,
  };
  // Persist error, signal and exit status before any command-outcome assertion.
  writeFixtureJson(receiptPath, receipt);
  return {
    ...receipt,
    stdout: readFileSync(stdoutPath, "utf8"),
    stderr: readFileSync(stderrPath, "utf8"),
  };
}

function assertExit(result, expected) {
  assert.equal(result.error, null, `child error; receipt: ${result.receiptPath}`);
  assert.equal(result.signal, null, `child signal; receipt: ${result.receiptPath}`);
  assert.equal(result.exitCode, expected, `child exit; receipt: ${result.receiptPath}`);
}

function fixtureGit(fixture, label, args, expectedExit = 0) {
  const result = recordedCommand(fixture, label, fixture.git, ["--no-optional-locks", ...args]);
  assertExit(result, expectedExit);
  return result;
}

function createGitFixture(suite, label, omittedPath) {
  const root = mkdtempSync(join(suite.root, `${label}-`));
  const repo = join(root, "repo");
  const receipts = join(root, "receipts");
  mkdirSync(repo);
  mkdirSync(receipts);
  const { env, config } = fixtureEnvironment(root, suite.git, suite.inheritedPath);
  const fixture = { root, repo, receipts, env, git: suite.git, commandCount: 0 };
  const copied = [];
  for (const [path, bytes] of suite.sources) {
    if (path === omittedPath) continue;
    const destination = resolve(repo, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(resolve(suite.sourceRoot, path), destination);
    assert.deepEqual(readFileSync(destination), bytes, `actual source copy drift: ${path}`);
    copied.push({ path, bytes: bytes.length, sha256: digest(bytes) });
  }
  const metadataPath = join(root, "fixture.json");
  writeFixtureJson(metadataPath, {
    label,
    repo,
    git: suite.git,
    node: { executable: process.execPath, version: process.version },
    identity: fixtureIdentity,
    config,
    sourceRoot: suite.sourceRoot,
    copied,
    omittedPath: omittedPath ?? null,
    receipts,
  });
  console.info(
    JSON.stringify({
      fixture: repo,
      git: suite.git,
      identity: fixtureIdentity,
      config: config.paths,
      receipts,
      metadataPath,
    }),
  );
  fixtureGit(fixture, "git-version", ["--version"]);
  fixtureGit(fixture, "git-init", ["init", "."]);
  fixtureGit(fixture, "git-config", ["config", "--list", "--show-origin", "--show-scope"]);
  fixtureGit(fixture, "git-add", ["add", "--", ...copied.map(({ path }) => path)]);
  fixtureGit(fixture, "git-commit", [
    "commit",
    "--no-gpg-sign",
    "--no-verify",
    "-m",
    "Preserve actual source bytes for freeze CLI regression",
  ]);
  fixture.commit = fixtureGit(fixture, "git-head", ["rev-parse", "HEAD"]).stdout.trim();
  assert.match(fixture.commit, /^[a-f0-9]{40}$/);
  const tracked = fixtureGit(fixture, "git-tracked", ["ls-files", "-z"]);
  assert.deepEqual(
    tracked.stdout.split("\0").filter(Boolean).sort(),
    copied.map(({ path }) => path).sort(),
  );
  const clean = fixtureGit(fixture, "git-diff-clean", diffArgs);
  assert.equal(clean.stdout, "");
  assert.equal(clean.stderr, "");
  return fixture;
}

function addPositiveFreezeStubs(fixture) {
  const put = (path, bytes) => {
    const destination = resolve(fixture.repo, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes, { flag: "wx" });
  };
  put("dist/assets/browserWorker-fixture.js", "// Inert freeze fixture Worker bytes.\n");
  put("dist/assets/CertifiedCalculator-fixture.js", "// Inert freeze fixture client bytes.\n");
  put(
    "dist/.vite/manifest.json",
    JSON.stringify({
      "src/certifiedUi/CertifiedCalculator.tsx": {
        file: "assets/CertifiedCalculator-fixture.js",
        assets: ["assets/browserWorker-fixture.js"],
      },
    }),
  );
  put(
    "node_modules/@playwright/test/package.json",
    JSON.stringify({
      name: "@playwright/test",
      type: "module",
      exports: "./index.mjs",
    }),
  );
  put(
    "node_modules/@playwright/test/index.mjs",
    [
      'import { fileURLToPath } from "node:url";',
      ...ENGINES.map(
        (name) =>
          `export const ${name} = { executablePath: () => ` +
          `fileURLToPath(new URL("./${name}.bin", import.meta.url)) };`,
      ),
      "",
    ].join("\n"),
  );
  for (const name of ENGINES) {
    put(`node_modules/@playwright/test/${name}.bin`, Buffer.from(`inert-${name}-fixture\n`));
  }
  put(
    "node_modules/playwright-core/package.json",
    JSON.stringify({
      name: "playwright-core",
      version: "0.0.0-freeze-fixture",
    }),
  );
  put(
    "node_modules/playwright-core/browsers.json",
    JSON.stringify({
      browsers: ENGINES.map((name) => ({ name, browserVersion: "fixture-only", revision: "0" })),
    }),
  );
}

function runFreeze(fixture) {
  const expected = join(fixture.root, "expected-output", "expected.json");
  const result = recordedCommand(fixture, "freeze", process.execPath, [
    resolve(fixture.repo, verifierPath),
    "freeze",
    "--commit",
    fixture.commit,
    "--expected",
    expected,
  ]);
  console.info(
    JSON.stringify({
      freeze: fixture.repo,
      exitCode: result.exitCode,
      signal: result.signal,
      error: result.error,
      receiptPath: result.receiptPath,
    }),
  );
  return { ...result, expected };
}

function assertNegativeFreeze(fixture, result) {
  assertExit(result, 1);
  assert.equal(result.stdout, "", "a failed freeze must not report FROZEN");
  assert.equal(existsSync(result.expected), false, "failed freeze wrote an expected manifest");
  assert.equal(existsSync(dirname(result.expected)), false, "failed freeze created output parent");
  assert.equal(existsSync(join(fixture.repo, "dist")), false);
  assert.equal(existsSync(join(fixture.repo, "node_modules")), false);
}

function assertMissingRequiredSource(fixture, path) {
  const result = runFreeze(fixture);
  assertNegativeFreeze(fixture, result);
  const assertion = result.stderr
    .split(/\r?\n/)
    .find((line) => line.startsWith("AssertionError [ERR_ASSERTION]: "));
  assert.equal(
    assertion,
    `AssertionError [ERR_ASSERTION]: missing required tracked source: ${path}`,
  );
}

function assertDiffGateFailure(fixture, path) {
  const diff = fixtureGit(fixture, "git-diff-head", diffArgs, 1);
  assert.deepEqual(diff.stdout.trim().split(/\r?\n/), [path]);
  assert.equal(diff.stderr, "");
  const result = runFreeze(fixture);
  assertNegativeFreeze(fixture, result);
  assert.equal(
    result.stderr.split(/\r?\n/)[0],
    `Error: Command failed: git --no-optional-locks ${diffArgs.join(" ")}`,
  );
  assert.match(result.stderr, /status: 1,/);
  assert.match(result.stderr, /signal: null,/);
  assert.ok(result.stderr.includes(path), "freeze must preserve the Git drift filename");
  assert.ok(
    !result.stderr.includes("missing required tracked source:"),
    "tracked drift must fail at the earlier diff HEAD gate",
  );
}

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

test("freeze CLI enforces required source membership in actual Git repositories", async (t) => {
  assert.equal(process.version, "v24.21.0", "freeze CLI fixtures require Node v24.21.0");
  assert.equal(sourcePaths.length, 13, "all 13 required sources must have omission coverage");
  const { git, inheritedPath } = resolveFixtureGit();
  const parent = resolve(process.env.CERTIFIED_FREEZE_FIXTURE_ROOT ?? tmpdir());
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(realpathSync(parent), "freeze-"));
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const sources = new Map(
    [...sourcePaths, verifierPath, generatedPath].map((path) => [
      path,
      readFileSync(resolve(sourceRoot, path)),
    ]),
  );
  const suite = { root, sourceRoot, sources, git, inheritedPath };

  await t.test("freezes all 13 actual required sources with metadata-only browser stubs", () => {
    const fixture = createGitFixture(suite, "positive");
    addPositiveFreezeStubs(fixture);
    const result = runFreeze(fixture);
    assertExit(result, 0);
    assert.equal(result.stderr, "");
    const frozen = JSON.parse(result.stdout);
    assert.equal(frozen.status, "FROZEN");
    assert.equal(frozen.path, result.expected);
    assert.equal(frozen.commit, fixture.commit);
    const expectedBytes = readFileSync(result.expected);
    assert.equal(frozen.sha256, digest(expectedBytes));
    const expected = JSON.parse(expectedBytes.toString("utf8"));
    assert.equal(expected.source.commit, fixture.commit);
    assert.deepEqual(
      expected.source.files.map(({ path }) => path),
      [...sources.keys()].sort(),
    );
    for (const path of sourcePaths) {
      const source = expected.source.files.find((row) => row.path === path);
      assert.ok(source, `FROZEN manifest must contain required source: ${path}`);
      assert.equal(source.sha256, digest(sources.get(path)), `actual source hash: ${path}`);
      assert.equal(source.bytes, sources.get(path).length, `actual source byte count: ${path}`);
    }
    const generator = expected.source.files.find(({ path }) => path === generatorPath);
    assert.equal(generator.sha256, digest(readFileSync(resolve(sourceRoot, generatorPath))));
    assert.equal(expected.source.lockSha256, digest(sources.get("package-lock.json")));
    assert.deepEqual(Object.keys(expected.browsers), ENGINES);
    for (const name of ENGINES) {
      assert.equal(expected.browsers[name].version, "fixture-only");
      assert.equal(
        expected.browsers[name].executableSha256,
        digest(Buffer.from(`inert-${name}-fixture\n`)),
      );
    }
  });

  for (const [index, path] of sourcePaths.entries()) {
    const label = path === generatorPath ? "published 12/13 generator omission" : path;
    await t.test(`rejects required-source omission: ${label}`, () => {
      const fixture = createGitFixture(suite, `omit-${String(index).padStart(2, "0")}`, path);
      assert.equal(existsSync(resolve(fixture.repo, path)), false);
      assertMissingRequiredSource(fixture, path);
    });
  }

  await t.test("rejects an actual generator present on disk but absent from Git", () => {
    const fixture = createGitFixture(suite, "untracked", generatorPath);
    const destination = resolve(fixture.repo, generatorPath);
    copyFileSync(resolve(sourceRoot, generatorPath), destination);
    assert.deepEqual(readFileSync(destination), sources.get(generatorPath));
    const tracked = fixtureGit(fixture, "git-generator-tracked", [
      "ls-files",
      "-z",
      "--",
      generatorPath,
    ]);
    assert.equal(tracked.stdout, "");
    const untracked = fixtureGit(fixture, "git-generator-untracked", [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      generatorPath,
    ]);
    assert.equal(untracked.stdout, `${generatorPath}\0`);
    assertMissingRequiredSource(fixture, generatorPath);
    assert.deepEqual(readFileSync(destination), sources.get(generatorPath));
  });

  await t.test("rejects actual index/HEAD drift before required-source membership", () => {
    const fixture = createGitFixture(suite, "index-drift");
    fixtureGit(fixture, "git-rm-cached", ["rm", "--cached", "--", generatorPath]);
    assert.deepEqual(
      readFileSync(resolve(fixture.repo, generatorPath)),
      sources.get(generatorPath),
    );
    const tracked = fixtureGit(fixture, "git-generator-tracked", [
      "ls-files",
      "-z",
      "--",
      generatorPath,
    ]);
    assert.equal(tracked.stdout, "");
    assertDiffGateFailure(fixture, generatorPath);
    assert.deepEqual(
      readFileSync(resolve(fixture.repo, generatorPath)),
      sources.get(generatorPath),
    );
  });

  await t.test("rejects a tracked file absent from disk while preserving its bytes", () => {
    const fixture = createGitFixture(suite, "disk-absence");
    const holding = join(fixture.root, "holding");
    mkdirSync(holding);
    const preserved = join(holding, basename(generatorPath));
    renameSync(resolve(fixture.repo, generatorPath), preserved);
    assert.deepEqual(readFileSync(preserved), sources.get(generatorPath));
    assert.equal(existsSync(resolve(fixture.repo, generatorPath)), false);
    const tracked = fixtureGit(fixture, "git-generator-tracked", [
      "ls-files",
      "-z",
      "--",
      generatorPath,
    ]);
    assert.equal(tracked.stdout, `${generatorPath}\0`);
    assertDiffGateFailure(fixture, generatorPath);
    assert.deepEqual(readFileSync(preserved), sources.get(generatorPath));
  });
});
