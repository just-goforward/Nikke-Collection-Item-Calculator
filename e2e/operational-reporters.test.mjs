import { deepStrictEqual } from "node:assert";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import PlaywrightReporter from "./operational-playwright-reporter.ts";
import { approvedNames } from "./operational-case-map.mjs";

const source = fileURLToPath(new URL("./operational-production.spec.ts", import.meta.url));
function cases() {
  return approvedNames["production-policy"].map(title => ({
    title, location: { file: source }, results: [{ status: "passed", errors: [] }],
  }));
}
async function run(observed, fullStatus = "passed", globalError = false) {
  const prior = process.env.OPERATIONAL_PRIVATE_RESULTS_DIR;
  const path = mkdtempSync(join(tmpdir(), "operational-reporter-unit-"));
  process.env.OPERATIONAL_PRIVATE_RESULTS_DIR = path;
  try {
    const reporter = new PlaywrightReporter({ suiteId: "production-policy" });
    reporter.onBegin({}, { allTests: () => observed });
    reporter.onStepEnd({}, {}, { title: "Install clock", startTime: new Date("2026-09-30T04:00:00Z"), duration: 16 });
    if (globalError) reporter.onError();
    const outcome = await reporter.onEnd({ status: fullStatus });
    const report = join(path, "production-policy.json");
    const diagnostics = join(path, "production-policy-diagnostics.json");
    return { outcome, report: existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : null,
      consoleOwned: reporter.printsToStdio(),
      diagnostics: existsSync(diagnostics) ? JSON.parse(readFileSync(diagnostics, "utf8")) : null };
  } finally {
    if (prior === undefined) delete process.env.OPERATIONAL_PRIVATE_RESULTS_DIR;
    else process.env.OPERATIONAL_PRIVATE_RESULTS_DIR = prior;
  }
}
test("reporter claims console without default fallback and emits only approved fields", async () => {
  const result = await run(cases());
  deepStrictEqual(result.outcome, { status: "passed" });
  deepStrictEqual(result.consoleOwned, true);
  deepStrictEqual(Object.keys(result.report).sort(), ["cases", "complete", "inventoryDigest", "schemaVersion", "suiteId"]);
  deepStrictEqual(result.report.cases[0], { id: "P001", status: "passed", attempts: 1 });
  deepStrictEqual(result.diagnostics.entries.at(-1).clockSteps, [
    { title: "Install clock", started: "2026-09-30T04:00:00.000Z", duration: 16 },
  ]);
});
test("framework unknown, malformed and duplicate cases fail closed", async () => {
  for (const observed of [
    [...cases(), { title: "UNKNOWN", location: { file: source }, results: [] }],
    [...cases(), cases()[0]],
    [{ title: null }],
  ]) deepStrictEqual((await run(observed)).outcome, { status: "failed" });
});
test("framework missing, skipped, retry and interrupted results never become complete", async () => {
  const skipped = cases(); skipped[0].results[0].status = "skipped";
  const retried = cases(); retried[0].results.push({ status: "passed", errors: [] });
  const interrupted = cases(); interrupted[0].results = [];
  for (const observed of [cases().slice(1), skipped, retried, interrupted]) {
    const result = await run(observed);
    deepStrictEqual(result.outcome, { status: "failed" });
    deepStrictEqual(result.report.complete, false);
  }
  deepStrictEqual((await run(cases(), "interrupted")).report.complete, false);
  deepStrictEqual((await run(cases(), "passed", true)).report.complete, false);
});
