import { readFile, writeFile } from "node:fs/promises";

const RUNTIME_FILE = new URL("./results/rust-runtime-benchmark.json", import.meta.url);
const RERANK_FILE = new URL("./results/rust-rerank-benchmark.json", import.meta.url);
const OUTPUT_FILE = new URL("./results/rust-solver-direction-analysis.json", import.meta.url);
const RAW_POLICY_KEY = "raw";
const TWO_FOLD_POLICY_KEY = "twoFold";
const PAIRED_95_POLICY_KEY = "paired95";
const ADAPTIVE_90_POLICY_KEY = "adaptive90";
const A2_GATE_POLICY_KEY = "a2Gate";

type RuntimeComparison = {
  meanDeltaMs: number | null;
  p50DeltaMs: number | null;
  p95DeltaMs: number | null;
  maxDeltaMs: number | null;
  weightedMeanDeltaMs: number | null;
  meanRatio: number | null;
  p95Ratio: number | null;
};

type RuntimeResult = {
  byBackend?: Record<
    string,
    {
      meanElapsedMs: number | null;
      p50ElapsedMs: number | null;
      p95ElapsedMs: number | null;
      maxElapsedMs: number | null;
      weightedMeanElapsedMs: number | null;
      errorCount: number;
    }
  >;
  backendComparisons?: Record<string, RuntimeComparison>;
  options?: { weightSpec?: { profile?: string; note?: string } } & Record<string, unknown>;
};

type PolicySummary = {
  interventionCount: number;
  interventionRate: number | null;
  weightedInterventionRate: number | null;
  weightedSumDelta: number | null;
  weightedMeanDelta: number | null;
  weightedInterventionSumDelta: number | null;
  weightedInterventionMeanDelta: number | null;
  positiveDeltaCount: number;
  positiveDeltaSum: number;
  negativeDeltaCount: number;
  negativeDeltaSum: number;
  falsePositiveCount: number | null;
  falseNegativeCount: number | null;
};

type RerankResult = {
  policySummaries?: Record<string, PolicySummary>;
  gateSweep?: Record<string, unknown>;
  gateSweepBySource?: Record<string, unknown>;
  pairedMcDiagnostics?: Record<string, unknown>;
  a2Summary?: {
    comparableCount: number;
    errorCount: number;
    meanDelta: number | null;
    positiveDeltaCount: number;
    negativeDeltaCount: number;
    maxNodeCount: number;
  };
  a1Summary?: {
    comparableCount: number;
    errorCount: number;
    mcSignAgreementCount: number;
    a2SignAgreementCount: number;
    signComparableCount: number;
    paired95InterventionCount: number;
    paired95PositiveA1Count: number;
  };
  options?: { weightSpec?: { profile?: string; note?: string } } & Record<string, unknown>;
};

async function readJson<T>(url: URL): Promise<T> {
  try {
    return JSON.parse(await readFile(url, "utf8")) as T;
  } catch (error) {
    throw new Error(
      `Missing or invalid benchmark result: ${url.pathname}. Run bench:rust-runtime and bench:rust-rerank first. (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function finite(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function verdict(runtime: RuntimeResult, rerank: RerankResult) {
  const phase2VsJs = runtime.backendComparisons?.["rust-phase2_vs_js-phase2"];
  const rerankVsPhase2 = runtime.backendComparisons?.["rust-phase2-rerank_vs_rust-phase2"];
  const paired95 = rerank.policySummaries?.[PAIRED_95_POLICY_KEY];
  const adaptive90 = rerank.policySummaries?.[ADAPTIVE_90_POLICY_KEY];
  const phase2MeanDelta = finite(phase2VsJs?.weightedMeanDeltaMs);
  const rerankMeanDelta = finite(rerankVsPhase2?.weightedMeanDeltaMs);
  const adaptiveWeightedDelta = finite(adaptive90?.weightedSumDelta);
  const adaptiveFalsePositive = adaptive90?.falsePositiveCount ?? null;
  const pairedWeightedDelta = finite(paired95?.weightedSumDelta);
  const pairedFalsePositive = paired95?.falsePositiveCount ?? null;

  return {
    rustPhase2:
      phase2MeanDelta !== null && phase2MeanDelta < 0
        ? "strong_candidate_for_default_backend"
        : "needs_more_runtime_evidence",
    rustPhase2Rerank:
      adaptiveWeightedDelta !== null &&
      adaptiveWeightedDelta < 0 &&
      adaptiveFalsePositive === 0 &&
      rerankMeanDelta !== null &&
      rerankMeanDelta < 50
        ? "staging_candidate_with_low_observed_added_latency"
        : pairedWeightedDelta !== null && pairedWeightedDelta < 0 && pairedFalsePositive === 0
          ? "paired95_quality_ok_but_product_adaptive_or_latency_needs_work"
          : "keep_staging_until_quality_or_latency_is_clear",
    a2:
      (rerank.a2Summary?.comparableCount ?? 0) > 0
        ? "deterministic_surrogate_research_track"
        : "missing_surrogate_evidence",
  };
}

function weightProfile(runtime: RuntimeResult, rerank: RerankResult) {
  const runtimeProfile = runtime.options?.weightSpec?.profile ?? "unknown";
  const rerankProfile = rerank.options?.weightSpec?.profile ?? "unknown";
  return {
    runtimeProfile,
    rerankProfile,
    aligned: runtimeProfile === rerankProfile,
    note:
      runtime.options?.weightSpec?.note ??
      rerank.options?.weightSpec?.note ??
      (runtimeProfile === "uniform" && rerankProfile === "uniform"
        ? "Uniform weights are benchmark coverage weights, not observed traffic weights."
        : null),
  };
}

const runtime = await readJson<RuntimeResult>(RUNTIME_FILE);
const rerank = await readJson<RerankResult>(RERANK_FILE);

const analysis = {
  generatedAt: new Date().toISOString(),
  inputs: {
    runtime: RUNTIME_FILE.pathname,
    rerank: RERANK_FILE.pathname,
    runtimeOptions: runtime.options ?? null,
    rerankOptions: rerank.options ?? null,
  },
  weightProfile: weightProfile(runtime, rerank),
  runtime: {
    byBackend: runtime.byBackend ?? {},
    rustPhase2VsJs: runtime.backendComparisons?.["rust-phase2_vs_js-phase2"] ?? null,
    rustRerankVsPhase2: runtime.backendComparisons?.["rust-phase2-rerank_vs_rust-phase2"] ?? null,
  },
  quality: {
    raw: rerank.policySummaries?.[RAW_POLICY_KEY] ?? null,
    twoFold: rerank.policySummaries?.[TWO_FOLD_POLICY_KEY] ?? null,
    paired95: rerank.policySummaries?.[PAIRED_95_POLICY_KEY] ?? null,
    adaptive90: rerank.policySummaries?.[ADAPTIVE_90_POLICY_KEY] ?? null,
    a2Gate: rerank.policySummaries?.[A2_GATE_POLICY_KEY] ?? null,
    gateSweep: rerank.gateSweep ?? null,
    gateSweepBySource: rerank.gateSweepBySource ?? null,
    pairedMcDiagnostics: rerank.pairedMcDiagnostics ?? null,
    a2: rerank.a2Summary ?? null,
    a1: rerank.a1Summary ?? null,
  },
  verdict: verdict(runtime, rerank),
  interpretation: [
    "rust-phase2 default readiness is primarily a full-contract parity and runtime question.",
    "rust-phase2-rerank should be judged by weighted net E[f] improvement and added latency, not intervention count alone.",
    "A2 is a deterministic surrogate research track; it is not an exact oracle.",
    "Weight profiles are explicit; uniform and usage-proxy-v1 are not substitutes for private D1 telemetry.",
  ],
};

await writeFile(OUTPUT_FILE, `${JSON.stringify(analysis, null, 2)}\n`);

console.log(
  JSON.stringify(
    {
      verdict: analysis.verdict,
      weightProfile: analysis.weightProfile,
      rustPhase2VsJs: analysis.runtime.rustPhase2VsJs,
      rustRerankVsPhase2: analysis.runtime.rustRerankVsPhase2,
      paired95: analysis.quality.paired95,
      adaptive90: analysis.quality.adaptive90,
      a2Gate: analysis.quality.a2Gate,
      gateSweep: analysis.quality.gateSweep,
      gateSweepBySource: analysis.quality.gateSweepBySource,
      pairedMcDiagnostics: analysis.quality.pairedMcDiagnostics,
      a2: analysis.quality.a2,
      a1: analysis.quality.a1,
      output: OUTPUT_FILE.pathname,
    },
    null,
    2,
  ),
);
