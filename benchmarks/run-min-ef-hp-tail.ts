import { readFile } from "node:fs/promises";
import { createServer } from "vite";

import { readHpStudyReport, writeHpStudyReport } from "./min-ef-hp-report.ts";
import { envValue, parseList, parsePositiveInteger } from "./runner-utils.ts";

const REPORT_FILE = new URL("./results/min-ef-hp-study.json", import.meta.url);
const WASM_URL = new URL("../public/solver_rs.wasm", import.meta.url);
const PANEL_IDS = ["R0-balanced150", "SR0-balanced200", "SR0-demand300"] as const;
const DISCOVERY_SEEDS = [20260811, 20260812, 20260813, 20260814] as const;
const CONFIRMATION_SEEDS = [20260821, 20260822] as const;

const phase = envValue("HP_STUDY_TAIL_PHASE") ?? "discovery";
if (phase !== "discovery" && phase !== "confirmation") {
  throw new Error("HP_STUDY_TAIL_PHASE must be discovery or confirmation.");
}
const runs = parsePositiveInteger(
  envValue("HP_STUDY_TAIL_RUNS"),
  phase === "discovery" ? 12_000 : 20_000,
);
const timeBudgetMs = parsePositiveInteger(envValue("HP_STUDY_TAIL_BUDGET_MS"), 900_000);
const wasm = await readFile(WASM_URL);
const server = await createServer({
  appType: "custom",
  configFile: false,
  logLevel: "error",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, hmr: false },
});

try {
  const report = await readHpStudyReport(REPORT_FILE);
  if (!report?.exact.complete) {
    throw new Error("Complete the H/p exact stage before tail-risk evaluation.");
  }
  const model = (await server.ssrLoadModule(
    "/benchmarks/min-ef-hp-model.ts",
  )) as typeof import("./min-ef-hp-model");
  const policy = (await server.ssrLoadModule(
    "/benchmarks/min-ef-hp-policy.ts",
  )) as typeof import("./min-ef-hp-policy");
  const trajectory = (await server.ssrLoadModule(
    "/benchmarks/evaluator/trajectory.ts",
  )) as typeof import("./evaluator/trajectory");
  const panels = (await server.ssrLoadModule(
    "/benchmarks/scenarios/journey-panels.ts",
  )) as typeof import("./scenarios/journey-panels");
  const metrics = (await server.ssrLoadModule(
    "/benchmarks/metrics.ts",
  )) as typeof import("./metrics");
  const gate = (await server.ssrLoadModule(
    "/benchmarks/significance-gate.ts",
  )) as typeof import("./significance-gate");
  const tail = (await server.ssrLoadModule(
    "/benchmarks/min-ef-hp-tail.ts",
  )) as typeof import("./min-ef-hp-tail");

  const existing = report.tailRisk.records as TailRunRecord[];
  const discoveryDecisions = tailDecisions(
    existing,
    "discovery",
    12_000,
    report.baselineVerification.candidateId,
    report.exact.finalistIds,
    gate,
    tail,
  );
  const exactChallengerIds = report.exact.finalistIds.filter(
    (candidateId) => candidateId !== report.baselineVerification.candidateId,
  );
  const confirmedChallengerIds = discoveryDecisions
    .filter((entry) => entry.passed)
    .map((entry) => entry.candidateId);
  const defaultCandidateIds =
    phase === "discovery"
      ? exactChallengerIds.length > 0
        ? [report.baselineVerification.candidateId, ...exactChallengerIds]
        : []
      : confirmedChallengerIds.length > 0
        ? [report.baselineVerification.candidateId, ...confirmedChallengerIds]
        : [];
  const candidateIds = parseList(envValue("HP_STUDY_CANDIDATES"), defaultCandidateIds);
  if (phase === "confirmation" && discoveryDecisions.some((decision) => !decision.judgeable)) {
    throw new Error("Complete the canonical discovery campaign before held-out confirmation.");
  }
  const seeds = phase === "discovery" ? DISCOVERY_SEEDS : CONFIRMATION_SEEDS;

  for (const candidateId of candidateIds) {
    const candidate = model.hpCandidateById(candidateId);
    for (const panelId of PANEL_IDS) {
      const panel = panels.journeyPanelById(panelId);
      for (const seed of seeds) {
        if (
          existing.some(
            (entry) =>
              entry.phase === phase &&
              entry.candidateId === candidateId &&
              entry.panelId === panelId &&
              entry.seed === seed &&
              entry.runs === runs,
          )
        ) {
          continue;
        }
        const session = await createSession(wasm, candidate, policy.createHpLadderSession);
        try {
          const result = trajectory.collectInteractiveTrajectories(panel, {
            modelId: candidateId,
            policySolver: session.policySolver,
            toleranceOverride: 0,
            runs,
            seed,
            timeBudgetMs,
          });
          const record: TailRunRecord =
            result.status === "completed"
              ? {
                  phase,
                  candidateId,
                  panelId,
                  seed,
                  runs,
                  status: "completed",
                  completionRate:
                    result.samples.filter((sample) => sample.completed).length /
                    result.samples.length,
                  maxSupplyDebtDaysSamples: result.samples.map((sample) =>
                    metrics.maxSupplyDebtDays(sample.consumption),
                  ),
                  elapsedMs: result.elapsedMs,
                  solveCalls: result.solveCalls,
                  cachedPolicies: result.cachedPolicies,
                }
              : {
                  phase,
                  candidateId,
                  panelId,
                  seed,
                  runs,
                  status: "verification_incomplete",
                  reason: result.reason,
                  runsCompleted: result.runsCompleted,
                  elapsedMs: result.elapsedMs,
                  solveCalls: result.solveCalls,
                  cachedPolicies: result.cachedPolicies,
                };
          existing.push(record);
          report.tailRisk.records = existing;
          await writeHpStudyReport(REPORT_FILE, report);
        } finally {
          session.release();
        }
      }
    }
  }

  const decisions = tailDecisions(
    existing,
    phase,
    runs,
    report.baselineVerification.candidateId,
    phase === "discovery"
      ? report.exact.finalistIds
      : [report.baselineVerification.candidateId, ...confirmedChallengerIds],
    gate,
    tail,
  );
  report.tailRisk.status =
    phase === "confirmation" && decisions.every((decision) => decision.judgeable)
      ? "completed"
      : "pending";
  report.tailRisk.records = existing;
  Object.assign(report.tailRisk, {
    protocol: {
      panels: PANEL_IDS,
      discovery: { seeds: DISCOVERY_SEEDS, runs: 12_000 },
      confirmation: { seeds: CONFIRMATION_SEEDS, runs: 20_000 },
      commonRandomNumbers: true,
      completionThreshold: gate.JOURNEY_COMPLETION_THRESHOLD,
      currentRun: { phase, runs, canonical: runs === (phase === "discovery" ? 12_000 : 20_000) },
      skippedReason:
        defaultCandidateIds.length === 0
          ? phase === "discovery"
            ? "no_exact_challenger"
            : "no_discovery_challenger"
          : null,
    },
    [`${phase}Decisions`]: decisions,
  });
  await writeHpStudyReport(REPORT_FILE, report);
  console.log(JSON.stringify({ phase, runs, decisions, output: REPORT_FILE.pathname }, null, 2));
} finally {
  await server.close();
}

type TailRunRecord =
  | {
      phase: "discovery" | "confirmation";
      candidateId: string;
      panelId: string;
      seed: number;
      runs: number;
      status: "completed";
      completionRate: number;
      maxSupplyDebtDaysSamples: number[];
      elapsedMs: number;
      solveCalls: number;
      cachedPolicies: number;
    }
  | {
      phase: "discovery" | "confirmation";
      candidateId: string;
      panelId: string;
      seed: number;
      runs: number;
      status: "verification_incomplete";
      reason: string;
      runsCompleted: number;
      elapsedMs: number;
      solveCalls: number;
      cachedPolicies: number;
    };

function tailDecisions(
  records: readonly TailRunRecord[],
  phase: "discovery" | "confirmation",
  runs: number,
  baselineId: string,
  candidateIds: readonly string[],
  completionGate: typeof import("./significance-gate"),
  tail: typeof import("./min-ef-hp-tail"),
) {
  return candidateIds
    .filter((candidateId) => candidateId !== baselineId)
    .map((candidateId) => {
      const panelSamples = PANEL_IDS.map((panelId) => {
        const baseline = seedSamples(records, phase, runs, baselineId, panelId);
        const candidate = seedSamples(records, phase, runs, candidateId, panelId);
        const gated = completionGate.gatePairedSeeds(baseline, candidate);
        return { panelId, gated };
      });
      if (panelSamples.some((entry) => entry.gated.status !== "completed")) {
        return { candidateId, judgeable: false, passed: false, result: null };
      }
      const result = tail.evaluateHpTailGate(
        panelSamples.map((entry) => ({
          panelId: entry.panelId,
          baseline: entry.gated.basePool,
          candidate: entry.gated.candPool,
        })),
      );
      return { candidateId, judgeable: true, passed: result.passed, result };
    });
}

function seedSamples(
  records: readonly TailRunRecord[],
  phase: "discovery" | "confirmation",
  runs: number,
  candidateId: string,
  panelId: string,
) {
  return records
    .filter(
      (record): record is Extract<TailRunRecord, { status: "completed" }> =>
        record.phase === phase &&
        record.runs === runs &&
        record.candidateId === candidateId &&
        record.panelId === panelId &&
        record.status === "completed",
    )
    .sort((left, right) => left.seed - right.seed)
    .map((record) => ({
      seed: record.seed,
      completionRate: record.completionRate,
      samples: record.maxSupplyDebtDaysSamples,
    }));
}

async function createSession(
  wasm: Uint8Array,
  candidate: import("./min-ef-hp-model").HpCandidate,
  factory: typeof import("./min-ef-hp-policy").createHpLadderSession,
) {
  const [minEfInstance, phase2Instance] = await Promise.all([instantiate(wasm), instantiate(wasm)]);
  return factory(minEfInstance, phase2Instance, candidate);
}

async function instantiate(wasm: Uint8Array): Promise<WebAssembly.Instance> {
  const result = (await WebAssembly.instantiate(wasm)) as
    | WebAssembly.Instance
    | { instance: WebAssembly.Instance };
  return result instanceof WebAssembly.Instance ? result : result.instance;
}
