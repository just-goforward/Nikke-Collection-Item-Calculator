import { readFile, rm } from "node:fs/promises";
import { createServer } from "vite";
import type { ExactInteractiveEvaluation } from "./evaluator/exact-replan-types";
import {
  readExactCheckpoint,
  readHpStudyReport,
  shouldAdvanceExactEvaluation,
  summarizeLadderTraces,
  writeExactCheckpoint,
  writeHpStudyReport,
} from "./min-ef-hp-report.ts";
import { envValue, parseList, parsePositiveInteger } from "./runner-utils.ts";

const REPORT_FILE = new URL("./results/min-ef-hp-study.json", import.meta.url);
const SNAPSHOT_FILE = new URL("./results/min-ef-hp-d1-snapshot.json", import.meta.url);
const CHECKPOINT_DIRECTORY = new URL("./results/min-ef-hp-d1-checkpoints/", import.meta.url);
const WASM_URL = new URL("../public/solver_rs.wasm", import.meta.url);
const PROFILES = [
  "finite_low",
  "finite_mid",
  "finite_high",
  "censored_500",
  "censored_1000",
] as const;
const exactSliceBudgetMs = parsePositiveInteger(envValue("HP_STUDY_D1_BUDGET_MS"), 120_000);

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
    throw new Error("Complete the H/p exact stage before D1 robustness evaluation.");
  }
  if (report.tailRisk.status !== "completed") {
    throw new Error("Complete held-out H/p tail confirmation before D1 robustness evaluation.");
  }
  const snapshot = JSON.parse(
    await readFile(SNAPSHOT_FILE, "utf8"),
  ) as import("./min-ef-hp-d1").D1HpSnapshot;
  if (snapshot.kind !== "min-ef-hp-d1-snapshot" || snapshot.version !== 1) {
    throw new Error("Unsupported H/p D1 snapshot.");
  }
  const d1 = (await server.ssrLoadModule(
    "/benchmarks/min-ef-hp-d1.ts",
  )) as typeof import("./min-ef-hp-d1");
  const model = (await server.ssrLoadModule(
    "/benchmarks/min-ef-hp-model.ts",
  )) as typeof import("./min-ef-hp-model");
  const policy = (await server.ssrLoadModule(
    "/benchmarks/min-ef-hp-policy.ts",
  )) as typeof import("./min-ef-hp-policy");
  const evaluator = (await server.ssrLoadModule(
    "/benchmarks/evaluator/exact-replan.ts",
  )) as typeof import("./evaluator/exact-replan");

  const selected = d1.selectD1HpStrata(snapshot.rows);
  const baselineId = report.baselineVerification.candidateId;
  const confirmedCandidateIds = readConfirmedCandidateIds(report.tailRisk);
  const defaultCandidateIds =
    confirmedCandidateIds.length > 0 ? [baselineId, ...confirmedCandidateIds] : [];
  const candidateIds = parseList(envValue("HP_STUDY_CANDIDATES"), defaultCandidateIds);
  const records = report.d1Robustness.records as D1EvaluationRecord[];

  for (const candidateId of candidateIds) {
    const candidate = model.hpCandidateById(candidateId);
    for (const row of selected.rows) {
      const stratumKey = d1.d1StratumKey(row);
      for (const profile of PROFILES) {
        const existing = records.find(
          (record) =>
            record.candidateId === candidateId &&
            record.stratumKey === stratumKey &&
            record.profile === profile,
        );
        if (!shouldAdvanceExactEvaluation(existing?.evaluation)) continue;
        const scenario = d1.replayD1Stratum(row, profile);
        const session = await createSession(wasm, candidate, policy.createHpLadderSession);
        const checkpointUrl = new URL(
          `${candidateId}/${stratumKey}-${profile}.json`,
          CHECKPOINT_DIRECTORY,
        );
        try {
          const checkpoint = await readExactCheckpoint(checkpointUrl);
          const exactSession = evaluator.createExactInteractiveReplanSession(
            scenario,
            {
              modelId: candidateId,
              policySolver: session.policySolver,
              toleranceOverride: 0,
            },
            checkpoint,
          );
          const evaluation = exactSession.advance(exactSliceBudgetMs);
          upsert(records, {
            candidateId,
            stratumKey,
            profile,
            events: row.events,
            hasRightCensoredBucket: Object.values(row.stockBuckets).includes("500_plus"),
            evaluation,
            ladderOutcomes: summarizeLadderTraces(session.traces()),
          });
          if (evaluation.status === "verification_incomplete") {
            await writeExactCheckpoint(checkpointUrl, exactSession.checkpoint());
          } else {
            await rm(checkpointUrl, { force: true });
          }
          report.d1Robustness.records = records;
          await writeHpStudyReport(REPORT_FILE, report);
        } finally {
          session.release();
        }
      }
    }
  }

  const decisions = candidateIds
    .filter((candidateId) => candidateId !== baselineId)
    .map((candidateId) => d1Decision(records, baselineId, candidateId, d1.classifyD1ProfilePasses));
  const complete = candidateIds.every((candidateId) =>
    selected.rows.every((row) =>
      PROFILES.every((profile) => {
        const record = records.find(
          (entry) =>
            entry.candidateId === candidateId &&
            entry.stratumKey === d1.d1StratumKey(row) &&
            entry.profile === profile,
        );
        return record && record.evaluation.status !== "verification_incomplete";
      }),
    ),
  );
  report.d1Robustness.status = complete
    ? decisions.some((decision) => decision.status === "verification_incomplete")
      ? "verification_incomplete"
      : "completed"
    : "pending";
  Object.assign(report.d1Robustness, {
    snapshot: {
      generatedAt: snapshot.generatedAt,
      database: snapshot.database,
      diagnosticVersion: snapshot.diagnosticVersion,
      querySince: snapshot.querySince,
      eventCount: snapshot.eventCount,
      firstDate: snapshot.firstDate,
      lastDate: snapshot.lastDate,
      sqlHash: snapshot.sqlHash,
      resultHash: snapshot.resultHash,
    },
    selectedStrata: {
      count: selected.rows.length,
      eventCoverage: selected.coverage,
      profiles: PROFILES,
    },
    skippedReason: defaultCandidateIds.length === 0 ? "no_tail_confirmed_challenger" : null,
    decisions,
  });
  await writeHpStudyReport(REPORT_FILE, report);
  console.log(
    JSON.stringify(
      {
        status: report.d1Robustness.status,
        selected: {
          strata: selected.rows.length,
          totalEvents: selected.totalEvents,
          selectedEvents: selected.selectedEvents,
          coverage: selected.coverage,
        },
        decisions,
        output: REPORT_FILE.pathname,
      },
      null,
      2,
    ),
  );
} finally {
  await server.close();
}

type D1EvaluationRecord = {
  candidateId: string;
  stratumKey: string;
  profile: (typeof PROFILES)[number];
  events: number;
  hasRightCensoredBucket: boolean;
  evaluation: ExactInteractiveEvaluation;
  ladderOutcomes: Record<string, number>;
};

function d1Decision(
  records: readonly D1EvaluationRecord[],
  baselineId: string,
  candidateId: string,
  classifyProfilePasses: typeof import("./min-ef-hp-d1").classifyD1ProfilePasses,
) {
  const profileDecisions = PROFILES.map((profile) => {
    const baseline = records.filter(
      (record) => record.candidateId === baselineId && record.profile === profile,
    );
    const candidate = records.filter(
      (record) => record.candidateId === candidateId && record.profile === profile,
    );
    if (
      baseline.length === 0 ||
      candidate.length === 0 ||
      baseline.some((record) => record.evaluation.status === "verification_incomplete") ||
      candidate.some((record) => record.evaluation.status === "verification_incomplete")
    ) {
      return { profile, status: "verification_incomplete" as const, passed: false };
    }
    if (baseline.some((record) => record.evaluation.status === "solver_failure")) {
      return {
        profile,
        status: "verification_incomplete" as const,
        passed: false,
        reason: "baseline_solver_failure",
      };
    }
    if (candidate.some((record) => record.evaluation.status === "solver_failure")) {
      return {
        profile,
        status: "completed" as const,
        passed: false,
        reason: "candidate_solver_failure",
      };
    }
    const baselineAggregate = aggregateD1(baseline);
    const candidateAggregate = aggregateD1(candidate);
    if (!baselineAggregate || !candidateAggregate) {
      return { profile, status: "verification_incomplete" as const, passed: false };
    }
    const passed =
      candidateAggregate.successProbability >= baselineAggregate.successProbability - 1e-12 &&
      candidateAggregate.totalExpectedUses <= baselineAggregate.totalExpectedUses + 1e-9 &&
      candidateAggregate.exhaustion.blue <= baselineAggregate.exhaustion.blue + 1e-12 &&
      candidateAggregate.exhaustion.purple <= baselineAggregate.exhaustion.purple + 1e-12 &&
      candidateAggregate.exhaustion.yellow <= baselineAggregate.exhaustion.yellow + 1e-12;
    return {
      profile,
      status: "completed" as const,
      passed,
      baseline: baselineAggregate,
      candidate: candidateAggregate,
    };
  });
  if (profileDecisions.some((decision) => decision.status === "verification_incomplete")) {
    return { candidateId, status: "verification_incomplete" as const, profileDecisions };
  }
  const profileResult = classifyProfilePasses(profileDecisions);
  if (profileResult === "right_censoring_sensitive") {
    return {
      candidateId,
      status: "verification_incomplete" as const,
      reason: "right_censoring_sensitivity",
      profileDecisions,
    };
  }
  return {
    candidateId,
    status: "completed" as const,
    passed: profileResult === "passed",
    profileDecisions,
  };
}

function aggregateD1(records: readonly D1EvaluationRecord[]) {
  if (records.length === 0 || records.some((record) => record.evaluation.status !== "completed")) {
    return null;
  }
  const completed = records as Array<
    D1EvaluationRecord & {
      evaluation: Extract<ExactInteractiveEvaluation, { status: "completed" }>;
    }
  >;
  const totalWeight = completed.reduce((sum, record) => sum + record.events, 0);
  if (totalWeight <= 0) return null;
  const weighted = (read: (record: (typeof completed)[number]) => number) =>
    completed.reduce((sum, record) => sum + read(record) * record.events, 0) / totalWeight;
  return {
    successProbability: weighted((record) => record.evaluation.successProbability),
    totalExpectedUses: weighted((record) => {
      const stock = record.evaluation.expectedConsumption;
      return (stock.blue + stock.purple + stock.yellow) / 10;
    }),
    exhaustion: {
      blue: weighted((record) => record.evaluation.exhaustionProbability.blue),
      purple: weighted((record) => record.evaluation.exhaustionProbability.purple),
      yellow: weighted((record) => record.evaluation.exhaustionProbability.yellow),
    },
  };
}

function upsert(records: D1EvaluationRecord[], record: D1EvaluationRecord): void {
  const index = records.findIndex(
    (entry) =>
      entry.candidateId === record.candidateId &&
      entry.stratumKey === record.stratumKey &&
      entry.profile === record.profile,
  );
  if (index < 0) records.push(record);
  else records[index] = record;
}

function readConfirmedCandidateIds(tailRisk: { records: unknown[] }): string[] {
  const value = tailRisk as { confirmationDecisions?: unknown };
  if (!Array.isArray(value.confirmationDecisions)) return [];
  return value.confirmationDecisions.flatMap((entry) => {
    if (
      typeof entry === "object" &&
      entry !== null &&
      "candidateId" in entry &&
      typeof entry.candidateId === "string" &&
      "passed" in entry &&
      entry.passed === true
    ) {
      return [entry.candidateId];
    }
    return [];
  });
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
