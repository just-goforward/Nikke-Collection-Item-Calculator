import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { chromium, expect, firefox, test, webkit } from "@playwright/test";
import {
  approvedFixtureProvenance,
  fileSha256,
  loadIndependentApprovedPanel,
} from "../scripts/certified-staging-approved-panel.ts";
import {
  assertDistStable,
  buildCandidateWaitingReference,
  buildDistClientAdapter,
  inspectCertifiedDist,
  sha256Bytes,
  startCertifiedDistServer,
} from "../scripts/certified-staging-dist-validation.ts";
import type { CertifiedOutput } from "../src/certified/types.ts";

const runLabel = process.env["CERTIFIED_PLATFORM_RUN_LABEL"] ?? "approved-platform-dist";
assert.match(runLabel, /^[a-zA-Z0-9_-]{1,80}$/);
const runId = `${runLabel}-${Date.now()}-${process.pid}`;
const directory = `test-results/certified-staging-dist-${runId}`;
mkdirSync(directory, { recursive: true });
let server: Awaited<ReturnType<typeof startCertifiedDistServer>>;
let dist: ReturnType<typeof inspectCertifiedDist>;
let adapter: Awaited<ReturnType<typeof buildDistClientAdapter>>;
let panel: ReturnType<typeof loadIndependentApprovedPanel>;
let reference: Awaited<ReturnType<typeof buildCandidateWaitingReference>>;
let sources: { path: string; sha256: string }[];
let scenarioSha256: string;
let expectedManifestSha256: string;
let expectedManifest: {
  source: { commit: string; sha256: string; lockSha256: string };
  dist: { inventorySha256: string };
  browsers: Record<string, { executable: string; executableSha256: string }>;
};

test.beforeAll(async () => {
  test.setTimeout(120_000);
  // Missing dist or tracked data is a hard failure on every platform, including CI.
  panel = loadIndependentApprovedPanel();
  dist = inspectCertifiedDist();
  const expectedPath = process.env["CERTIFIED_EXPECTED_MANIFEST"];
  assert.ok(expectedPath, "Freeze approved24 expectations before running the browser campaign");
  expectedManifestSha256 = fileSha256(expectedPath);
  expectedManifest = JSON.parse(readFileSync(expectedPath, "utf8")) as typeof expectedManifest;
  assert.equal(expectedManifest.source.lockSha256, fileSha256("package-lock.json"));
  assert.equal(expectedManifest.dist.inventorySha256, dist.inventorySha256);
  adapter = await buildDistClientAdapter(dist.worker.urlPath);
  reference = await buildCandidateWaitingReference(panel.map((row) => row.input));
  sources = [
    ...approvedFixtureProvenance(),
    ...adapter.sources,
    ...reference.sources,
    {
      path: "e2e/certified-staging-api.spec.ts",
      sha256: fileSha256("e2e/certified-staging-api.spec.ts"),
    },
    {
      path: "scripts/certified-staging-dist-validation.ts",
      sha256: fileSha256("scripts/certified-staging-dist-validation.ts"),
    },
    { path: "package-lock.json", sha256: fileSha256("package-lock.json") },
  ].filter((row, index, rows) => rows.findIndex((other) => other.path === row.path) === index);
  scenarioSha256 = createHash("sha256").update(JSON.stringify(panel)).digest("hex");
  writeFileSync(`${directory}/client-adapter.js`, adapter.bytes);
  writeFileSync(`${directory}/approved-panel.json`, JSON.stringify(panel, null, 2) + "\n");
  writeFileSync(
    `${directory}/dist-provenance.json`,
    JSON.stringify(
      {
        dist,
        clientAdapter: { ...adapter, bytes: adapter.bytes.length },
        sources,
        scenarioSha256,
      },
      null,
      2,
    ) + "\n",
  );
  server = await startCertifiedDistServer(dist, adapter);
});
test.afterAll(async () => {
  await server?.close();
});

async function actualWorkerRows(page: import("@playwright/test").Page) {
  return page.evaluate(
    async ({ fixtures, clientUrl, worker }) => {
      const served = await Promise.all(
        [clientUrl, worker.urlPath].map(async (urlPath) => {
          const response = await fetch(urlPath, { cache: "no-store" });
          if (!response.ok) throw new Error(`Missing dist response: ${urlPath}`);
          const bytes = await response.arrayBuffer();
          const digest = await crypto.subtle.digest("SHA-256", bytes);
          return {
            urlPath,
            bytes: bytes.byteLength,
            sha256: [...new Uint8Array(digest)]
              .map((byte) => byte.toString(16).padStart(2, "0"))
              .join(""),
          };
        }),
      );
      const module = await import(/* @vite-ignore */ clientUrl);
      const createClient = module[
        "createBrowserCertifiedClient"
      ] as typeof import("../src/certifiedRuntime/browserClient.ts").createBrowserCertifiedClient;
      const profile = module[
        "CERTIFIED_STAGING_ENGINE_PROFILE"
      ] as typeof import("../shared/certifiedEngineProfile.ts").CERTIFIED_STAGING_ENGINE_PROFILE;
      const client = createClient();
      const rows = [];
      try {
        for (const fixture of fixtures) {
          const started = performance.now();
          const result = await client.request(fixture.input, {
            sessionId: fixture.id,
            engineProfile: profile,
          });
          rows.push({
            id: fixture.id,
            elapsedMs: performance.now() - started,
            output: result.output,
            timing: result.timing,
            memory: result.memory,
            engineProfile: result.engineProfile,
            forecastIdentity: result.forecastIdentity,
          });
        }
        return {
          rows,
          served,
          profile,
          memoryAfter: client.memory(),
          userAgent: navigator.userAgent,
          hardwareConcurrency: navigator.hardwareConcurrency,
        };
      } finally {
        await client.dispose();
      }
    },
    { fixtures: panel, clientUrl: adapter.urlPath, worker: dist.worker },
  );
}

function validateCurrent(fixture: (typeof panel)[number], actual: CertifiedOutput) {
  const failures: string[] = [];
  if (!actual.current || !actual.pricing) return [`${fixture.id}: current/pricing unavailable`];
  for (const key of [
    "successP",
    "weightedExpectedConsumptionB",
    "expectedTotalConsumptionC",
    "expectedConsumed",
  ] as const) {
    if (!isDeepStrictEqual(actual.current.value[key], fixture.expected[key]))
      failures.push(`${fixture.id}: ${key}`);
  }
  if (
    actual.current.kit !== fixture.expected.action ||
    actual.current.optimalActionMask !== fixture.expected.mask
  )
    failures.push(`${fixture.id}: action/mask`);
  if (!isDeepStrictEqual(actual.pricing.recurringRate, fixture.expected.rates))
    failures.push(`${fixture.id}: physicalRecurringRate`);
  if (!isDeepStrictEqual(actual.pricing.weights, fixture.expected.prices))
    failures.push(`${fixture.id}: fixedPhysicalPrices`);
  if (!isDeepStrictEqual(actual.pricing.basisStock, fixture.input.stock))
    failures.push(`${fixture.id}: rawPriceBasis`);
  if (!isDeepStrictEqual(actual.pricing.cohortWeights, fixture.expected.cohortWeights))
    failures.push(`${fixture.id}: originalCohortPrior`);
  return failures;
}

for (const [name, browserType] of [
  ["chromium", chromium],
  ["firefox", firefox],
  ["webkit", webkit],
] as const) {
  test(`installed ${name}: exact shipped dist Worker matches independent approved24 current oracle`, async ({
    browserName: _runnerBrowserName,
  }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    const workerUrls: string[] = [];
    let browser: Awaited<ReturnType<typeof browserType.launch>> | undefined;
    const servedStart = server.served.length;
    try {
      assertDistStable(dist);
      const runtime = expectedManifest.browsers[name];
      assert.ok(runtime, `Missing independently frozen ${name} launch entrypoint`);
      assert.equal(browserType.executablePath(), runtime.executable);
      assert.equal(fileSha256(runtime.executable), runtime.executableSha256);
      // Default headless Chromium may choose headless-shell. Submit the pinned entrypoint
      // explicitly so evidence never hashes a different, unused Chromium executable.
      browser = await browserType.launch({ executablePath: runtime.executable, headless: true });
      const context = await browser.newContext();
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("worker", (worker) => workerUrls.push(worker.url()));
      const verifiedHttpResponses = [];
      for (const asset of dist.assets) {
        const response = await page.request.get(`${server.origin}${asset.urlPath}`);
        expect(response.status(), asset.urlPath).toBe(200);
        const received = await response.body();
        expect(
          received.equals(readFileSync(asset.path)),
          `${asset.urlPath}: served bytes differ from pinned actual dist`,
        ).toBe(true);
        expect(sha256Bytes(received), asset.urlPath).toBe(asset.sha256);
        expect(response.headers()["x-content-sha256"], asset.urlPath).toBe(asset.sha256);
        verifiedHttpResponses.push({
          urlPath: asset.urlPath,
          sha256: sha256Bytes(received),
          bytes: received.length,
        });
      }
      await page.goto(`${server.origin}/__certified_dist_validation`);
      const results = await actualWorkerRows(page);
      expect(results.served).toEqual([
        { urlPath: adapter.urlPath, bytes: adapter.bytes.length, sha256: adapter.sha256 },
        { urlPath: dist.worker.urlPath, bytes: dist.worker.bytes, sha256: dist.worker.sha256 },
      ]);
      expect(workerUrls.length).toBeGreaterThan(0);
      expect(workerUrls.every((url) => url === `${server.origin}${dist.worker.urlPath}`)).toBe(
        true,
      );
      expect(results.rows.map((row) => row.id)).toEqual(panel.map((row) => row.id));
      const checks = results.rows.map((row, index) => {
        const fixture = panel[index];
        assert.ok(fixture);
        const currentFailures = validateCurrent(fixture, row.output);
        const waitingReference = reference.rows[index];
        assert.ok(waitingReference);
        const waitingParity =
          isDeepStrictEqual(row.output.waiting, waitingReference.waiting) &&
          row.output.status === waitingReference.status &&
          isDeepStrictEqual(row.output.refusal, waitingReference.refusal);
        if (!isDeepStrictEqual(row.engineProfile, results.profile))
          currentFailures.push(`${fixture.id}: returned profile mismatch`);
        return {
          id: fixture.id,
          independentCurrent: currentFailures.length ? "FAIL" : "PASS",
          independentCurrentActionGaps: fixture.expected.actionGaps,
          workerActionGapFieldComparison: "NOTAVAILABLE_no_Worker_API_field",
          directCandidateWaitingParity: waitingParity ? "PASS" : "FAIL",
          independentWaitingProof: "NOTRUN_in_this_dist_suite",
          independentWaitingGap: "NOTRUN_in_this_dist_suite",
          status: row.output.status,
          waitingStatus: row.output.waiting.status,
          failures: [
            ...currentFailures,
            ...(waitingParity ? [] : [`${fixture.id}: candidate waiting parity`]),
          ],
        };
      });
      const failures = checks.flatMap((check) => check.failures);
      const sourcesStable = sources.every((source) => fileSha256(source.path) === source.sha256);
      if (!sourcesStable) failures.push("source changed during dist Worker campaign");
      assertDistStable(dist);
      const servedResponses = server.served.slice(servedStart);
      expect(
        servedResponses.filter((row) => row.urlPath === dist.worker.urlPath).length,
      ).toBeGreaterThan(1);
      writeFileSync(
        `${directory}/${name}.json`,
        JSON.stringify(
          {
            version: "certified-staging-independent-dist-worker-v1",
            status: "passed",
            retry: testInfo.retry,
            generatedAt: new Date().toISOString(),
            runId,
            expectedManifestSha256,
            candidateIdentity: {
              commit: expectedManifest.source.commit,
              sourceSha256: expectedManifest.source.sha256,
              lockSha256: expectedManifest.source.lockSha256,
              distInventorySha256: expectedManifest.dist.inventorySha256,
            },
            sourceProvenance: sources,
            sourcesStable,
            scenarioSha256,
            distProvenance: dist,
            clientAdapter: {
              urlPath: adapter.urlPath,
              bytes: adapter.bytes.length,
              sha256: adapter.sha256,
              esbuildVersion: adapter.esbuildVersion,
              meaning: adapter.meaning,
            },
            browser: name,
            browserVersion: browser.version(),
            browserExecutable: runtime.executable,
            browserExecutableSha256: fileSha256(runtime.executable),
            launchOptions: { executablePath: runtime.executable, headless: true },
            browserExecutableMeaning:
              "Explicit Playwright launch entrypoint plus actual Browser.version(); child-library binaries and OS transport are not attested.",
            platform: process.platform,
            node: process.version,
            cases: panel.length,
            pass: checks.filter((check) => !check.failures.length).length,
            fail: checks.filter((check) => check.failures.length).length,
            failures,
            pageErrors: errors,
            checks,
            verifiedHttpResponses,
            servedResponses,
            workerUrls,
            arithmetic: "independent_reduced_bigint_rational",
            pricingMeaning:
              "independent ordered physical dispatch cohort expectations, exact box means and cadence; original priors and raw stock preserved",
            gapMeaning:
              "independent current action P/B/C lexicographic gap certificates; Worker API does not expose action-gap fields. Independent waiting/gap proof NOTRUN.",
            waitingMeaning: reference.meaning,
            coverageMeaning:
              "approved24 only; not a new current2000 or inherited large campaign pass",
            timingMeaning: "serial screening; no15s population acceptance claim",
            memoryMeaning:
              "logical client accounting only; no actual browser heap or RSS measurement",
            ...results,
          },
          null,
          2,
        ) + "\n",
      );
      expect(errors).toEqual([]);
      expect(failures).toEqual([]);
    } catch (error) {
      writeFileSync(
        `${directory}/${name}-failure.json`,
        JSON.stringify(
          {
            browser: name,
            status: "failed",
            retry: testInfo.retry,
            expectedManifestSha256,
            node: process.version,
            platform: process.platform,
            sourceProvenance: sources,
            scenarioSha256,
            distProvenance: dist,
            pageErrors: errors,
            workerUrls,
            servedResponses: server.served.slice(servedStart),
            error: error instanceof Error ? error.stack : String(error),
            interpretation:
              "Missing data, dist, browsers or page creation fail the suite; blocked execution never counts as PASS.",
          },
          null,
          2,
        ) + "\n",
      );
      throw error;
    } finally {
      await browser?.close();
    }
  });
}
