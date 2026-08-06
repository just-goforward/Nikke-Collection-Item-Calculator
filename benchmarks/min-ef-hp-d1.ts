import type { Stock } from "../src/types";
import type { SolverScenario } from "./scenarios/fixed-grid";

export type D1StockBucket =
  | "0"
  | "1_49"
  | "50_99"
  | "100_149"
  | "150_199"
  | "200_249"
  | "250_299"
  | "300_349"
  | "350_399"
  | "400_449"
  | "450_499"
  | "500_plus";

export type D1HpStratum = {
  grade: "R" | "SR";
  level: number;
  expBucket: number;
  stockBuckets: { blue: D1StockBucket; purple: D1StockBucket; yellow: D1StockBucket };
  events: number;
  firstDate: string;
  lastDate: string;
};

export type D1HpSnapshot = {
  kind: "min-ef-hp-d1-snapshot";
  version: 1;
  generatedAt: string;
  database: string;
  diagnosticVersion: number;
  querySince: string;
  sql: string;
  sqlHash: string;
  eventCount: number;
  firstDate: string | null;
  lastDate: string | null;
  rows: D1HpStratum[];
  resultHash: string;
};

export type D1ReplayProfile =
  | "finite_low"
  | "finite_mid"
  | "finite_high"
  | "censored_500"
  | "censored_1000";

const RIGHT_CENSOR_PROFILES = ["censored_500", "finite_mid", "censored_1000"] as const;

export type SelectedD1Strata = {
  rows: D1HpStratum[];
  totalEvents: number;
  selectedEvents: number;
  coverage: number;
};

const FINITE_BUCKETS: Record<Exclude<D1StockBucket, "500_plus">, [number, number]> = {
  "0": [0, 0],
  "1_49": [1, 49],
  "50_99": [50, 99],
  "100_149": [100, 149],
  "150_199": [150, 199],
  "200_249": [200, 249],
  "250_299": [250, 299],
  "300_349": [300, 349],
  "350_399": [350, 399],
  "400_449": [400, 449],
  "450_499": [450, 499],
};

export function selectD1HpStrata(
  rows: readonly D1HpStratum[],
  targetCoverage = 0.8,
): SelectedD1Strata {
  const ordered = [...rows].sort(
    (left, right) =>
      right.events - left.events || d1StratumKey(left).localeCompare(d1StratumKey(right)),
  );
  const totalEvents = ordered.reduce((sum, row) => sum + row.events, 0);
  const selected = new Map<string, D1HpStratum>();
  let cumulative = 0;
  for (const row of ordered) {
    if (totalEvents > 0 && cumulative / totalEvents >= targetCoverage) break;
    selected.set(d1StratumKey(row), row);
    cumulative += row.events;
  }
  for (const row of ordered) {
    if (Object.values(row.stockBuckets).some(isRiskBucket)) {
      selected.set(d1StratumKey(row), row);
    }
  }
  const selectedRows = [...selected.values()].sort(
    (left, right) =>
      right.events - left.events || d1StratumKey(left).localeCompare(d1StratumKey(right)),
  );
  const selectedEvents = selectedRows.reduce((sum, row) => sum + row.events, 0);
  return {
    rows: selectedRows,
    totalEvents,
    selectedEvents,
    coverage: totalEvents === 0 ? 0 : selectedEvents / totalEvents,
  };
}

export function replayD1Stratum(row: D1HpStratum, profile: D1ReplayProfile): SolverScenario {
  return {
    id: `d1-${d1StratumKey(row)}-${profile}`,
    group: Object.values(row.stockBuckets).some(isRiskBucket) ? "scarcity" : "balanced",
    start: { grade: row.grade, level: row.level, exp: row.expBucket },
    stock: Object.fromEntries(
      Object.entries(row.stockBuckets).map(([kit, bucket]) => [
        kit,
        representativeStock(bucket, profile),
      ]),
    ) as Stock,
  };
}

export function representativeStock(bucket: D1StockBucket, profile: D1ReplayProfile): number {
  if (bucket === "500_plus") {
    if (profile === "censored_500") return 500;
    if (profile === "censored_1000") return 1000;
    return 750;
  }
  const [low, high] = FINITE_BUCKETS[bucket];
  if (profile === "finite_low") return low;
  if (profile === "finite_high") return high;
  return Math.round((low + high) / 2);
}

export function classifyD1ProfilePasses(
  decisions: ReadonlyArray<{ profile: D1ReplayProfile; passed: boolean }>,
): "passed" | "failed" | "right_censoring_sensitive" {
  const rightCensorPassValues = new Set(
    decisions
      .filter((decision) =>
        RIGHT_CENSOR_PROFILES.includes(decision.profile as (typeof RIGHT_CENSOR_PROFILES)[number]),
      )
      .map((decision) => decision.passed),
  );
  if (rightCensorPassValues.size > 1) return "right_censoring_sensitive";
  return decisions.every((decision) => decision.passed) ? "passed" : "failed";
}

export function d1StratumKey(row: D1HpStratum): string {
  return [
    row.grade,
    row.level,
    row.expBucket,
    row.stockBuckets.blue,
    row.stockBuckets.purple,
    row.stockBuckets.yellow,
  ].join("_");
}

function isRiskBucket(bucket: D1StockBucket): boolean {
  return bucket === "0" || bucket === "1_49" || bucket === "500_plus";
}
