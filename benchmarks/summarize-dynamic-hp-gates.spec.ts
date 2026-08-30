import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { type DynamicHpProfile, gainVectorSha256 } from "./dynamic-hp-profile-matrix";
import type { HpCandidate } from "./min-ef-hp-model";
import type { HpExactGateResult } from "./min-ef-hp-quality";
import type { HpStudyReport } from "./min-ef-hp-report";
import {
  summarizeDynamicHpGates,
  writeDynamicHpCertificateBundle,
} from "./summarize-dynamic-hp-gates";

const execFileAsync = promisify(execFile);

describe("dynamic H/p exact gate summary", () => {
  it("aggregates completed profile gates without granting adoption authority", () => {
    const report = fixtureReport();
    const summary = summarizeDynamicHpGates(
      [{ id: "approved-00", report }],
      "2026-08-28T00:00:00.000Z",
    );

    expect(summary).toMatchObject({
      kind: "dynamic-hp-exact-gate-summary",
      version: 2,
      profileCount: 1,
      evaluatedProfileCount: 1,
      uniqueGainVectorCount: 1,
      duplicateProfileCount: 0,
      allProfilesComplete: true,
      candidateCount: 3,
      decisionScope: { researchOnly: true, productAdoptionAuthorized: false },
    });
    expect(summary.candidates).toEqual([
      {
        candidateId: "H0.5-p3",
        status: "screened_out",
        profilesScreened: 1,
        profilesShortlisted: 0,
        exactNotSelected: 1,
        exactPassed: 0,
        exactFailed: 0,
        exactIncomplete: 0,
      },
      {
        candidateId: "H0.75-p3",
        status: "passed_all_profiles",
        profilesScreened: 1,
        profilesShortlisted: 1,
        exactNotSelected: 0,
        exactPassed: 1,
        exactFailed: 0,
        exactIncomplete: 0,
      },
      {
        candidateId: "H1-p3",
        status: "rejected",
        profilesScreened: 1,
        profilesShortlisted: 1,
        exactNotSelected: 0,
        exactPassed: 0,
        exactFailed: 1,
        exactIncomplete: 0,
      },
    ]);
  });

  it("certifies one result for duplicate gain vectors and retains their evidence aliases", () => {
    const duplicate = fixtureReport();
    duplicate.options.supplyForecast = {
      ...duplicate.options.supplyForecast,
      forecastProfileId: "supply-test-v1@duplicate-date",
    };
    const summary = summarizeDynamicHpGates(
      [
        { id: "approved-00", report: fixtureReport() },
        { id: "approved-01", report: duplicate },
      ],
      "2026-08-28T00:00:00.000Z",
    );

    expect(summary).toMatchObject({
      profileCount: 2,
      evaluatedProfileCount: 2,
      uniqueGainVectorCount: 1,
      duplicateProfileCount: 1,
      certificate: { identity: "dynamic-hp-gain-vector-certificate-v1" },
    });
    expect(summary.profiles).toHaveLength(1);
    expect(summary.profiles[0]?.evidenceProfileIds).toEqual(["approved-00", "approved-01"]);
    expect(summary.profiles[0]?.resultContractSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.candidates.find((entry) => entry.candidateId === "H0.75-p3")).toMatchObject({
      profilesScreened: 1,
      exactPassed: 1,
    });
  });

  it("restores every evidence alias when only the canonical gain profile was evaluated", () => {
    const report = fixtureReport();
    const canonicalContext = report.options.supplyForecast;
    const duplicateContext = {
      ...canonicalContext,
      forecastProfileId: "supply-test-v1@duplicate-date",
    };
    const matrix: DynamicHpProfile[] = [
      {
        id: "approved-00",
        cycleDays: null,
        scheduleStatus: "confirmed",
        phase: "approved",
        context: canonicalContext,
        gainVectorSha256: gainVectorSha256(canonicalContext.expectedGain),
        evidenceProfiles: [
          {
            id: "approved-00",
            cycleDays: null,
            scheduleStatus: "confirmed",
            phase: "approved",
            context: canonicalContext,
          },
          {
            id: "approved-01",
            cycleDays: null,
            scheduleStatus: "confirmed",
            phase: "approved",
            context: duplicateContext,
          },
        ],
      },
    ];
    const summary = summarizeDynamicHpGates(
      [{ id: "approved-00", report }],
      "2026-08-28T00:00:00.000Z",
      { matrix, solverWasmSha256: "a".repeat(64), rulesVersion: "schedule-kit-v2" },
    );

    expect(summary).toMatchObject({
      profileCount: 2,
      evaluatedProfileCount: 1,
      uniqueGainVectorCount: 1,
      duplicateProfileCount: 1,
      certificate: {
        solverWasmSha256: "a".repeat(64),
        rulesVersion: "schedule-kit-v2",
      },
    });
    expect(summary.profiles[0]?.evidenceForecastProfileIds).toEqual([
      "supply-test-v1@2026-08-28",
      "supply-test-v1@duplicate-date",
    ]);
  });

  it("rejects duplicate gain vectors that produced different decisions", () => {
    const conflicting = fixtureReport();
    conflicting.screening.shortlistIds = ["H0.75-p3"];
    expect(() =>
      summarizeDynamicHpGates([
        { id: "approved-00", report: fixtureReport() },
        { id: "approved-01", report: conflicting },
      ]),
    ).toThrow("dynamic_hp_duplicate_gain_result_conflict");
  });
});

describe("dynamic H/p exact gate certificate bundle", () => {
  it("runs through the Node 24 CLI used by the workflow", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dynamic-hp-cli-"));
    const inputDirectory = join(directory, "reports");
    const outputFile = join(directory, "nested", "summary.json");

    try {
      await mkdir(inputDirectory);
      await writeFile(
        join(inputDirectory, "approved-00.json"),
        `${JSON.stringify(fixtureReport())}\n`,
        "utf8",
      );
      await execFileAsync(process.execPath, [
        fileURLToPath(new URL("./summarize-dynamic-hp-gates.ts", import.meta.url)),
        inputDirectory,
        outputFile,
      ]);

      const summary = JSON.parse(await readFile(outputFile, "utf8")) as {
        kind: string;
        allProfilesComplete: boolean;
      };
      expect(summary).toEqual(
        expect.objectContaining({
          kind: "dynamic-hp-exact-gate-summary",
          allProfilesComplete: true,
        }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stores one canonical profile report per gain vector in the certificate bundle", async () => {
    const canonical = fixtureReport();
    const duplicate = fixtureReport();
    duplicate.options.supplyForecast = {
      ...duplicate.options.supplyForecast,
      forecastProfileId: "supply-test-v1@duplicate-date",
    };
    const reports = [
      { id: "approved-00", report: canonical },
      { id: "approved-01", report: duplicate },
    ];
    const summary = summarizeDynamicHpGates(reports, "2026-08-28T00:00:00.000Z");
    const directory = await mkdtemp(join(tmpdir(), "dynamic-hp-certificate-"));

    try {
      const result = await writeDynamicHpCertificateBundle(reports, summary, directory);
      const profileFiles = await readdir(join(directory, "profiles"));
      const storedSummary = JSON.parse(
        await readFile(join(directory, "dynamic-hp-exact-gate-summary.json"), "utf8"),
      ) as typeof summary;
      const storedReport = JSON.parse(
        await readFile(join(directory, "profiles", profileFiles[0] ?? "missing"), "utf8"),
      ) as HpStudyReport;

      expect(result).toEqual({ evidenceProfiles: 2, canonicalProfiles: 1, duplicatesRemoved: 1 });
      expect(profileFiles).toEqual([`${gainVectorSha256({ blue: 1, purple: 1, yellow: 1 })}.json`]);
      expect(storedSummary.profiles[0]?.evidenceProfileIds).toEqual(["approved-00", "approved-01"]);
      expect(storedReport.options.supplyForecast.forecastProfileId).toBe(
        "supply-test-v1@2026-08-28",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function fixtureReport(): HpStudyReport {
  const candidate = (id: string): HpCandidate => {
    const horizonFactor =
      id === "H1-p3" ? (1 as const) : id === "H0.5-p3" ? (0.5 as const) : (0.75 as const);
    return {
      id,
      horizonFactor,
      horizonDays: horizonFactor * 28,
      normPower: 3 as const,
      tolerance: 0 as const,
    };
  };
  const gate = (status: "passed" | "failed"): HpExactGateResult => ({
    status,
    violations: status === "failed" ? ["total_uses"] : [],
    strictImprovement: false,
  });
  return {
    kind: "min-ef-hp-study",
    version: 2,
    generatedAt: "2026-08-28T00:00:00.000Z",
    options: {
      candidates: [candidate("H0.75-p3"), candidate("H1-p3"), candidate("H0.5-p3")],
      scenarioIds: ["s1"],
      exactScenarioIds: ["s1"],
      tolerance: 0,
      minEfMemoTier: 21,
      phase2MemoTier: 22,
      exactSliceBudgetMs: 1,
      supplyForecast: {
        forecastId: "supply-test-v1",
        forecastProfileId: "supply-test-v1@2026-08-28",
        expectedGain: { blue: 1, purple: 1, yellow: 1 },
      },
    },
    measurementProtocol: {},
    decisionPolicy: {},
    decisionScope: { researchOnly: true, productAdoptionAuthorized: false },
    baselineVerification: { candidateId: "H0.75-p3", status: "passed", notes: [] },
    screening: { complete: true, records: [], summaries: [], shortlistIds: ["H0.75-p3", "H1-p3"] },
    exact: {
      complete: true,
      records: [],
      gates: [
        { candidateId: "H0.75-p3", scenarioId: "s1", gate: gate("passed") },
        { candidateId: "H1-p3", scenarioId: "s1", gate: gate("failed") },
      ],
      finalistIds: ["H0.75-p3"],
    },
    tailRisk: { status: "pending", records: [] },
    d1Robustness: { status: "pending", records: [] },
    performance: { status: "pending", records: [] },
    candidateGrades: [],
  };
}
