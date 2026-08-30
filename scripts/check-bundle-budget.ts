import { spawnSync } from "node:child_process";

type BundleTotals = Record<string, { rawBytes: number; gzipBytes: number }>;

const result = spawnSync(process.execPath, ["scripts/report-bundle.ts"], {
  encoding: "utf8",
});
if (result.status !== 0) throw new Error(result.stderr || "Bundle report failed.");

const report = JSON.parse(result.stdout) as { totals: BundleTotals };
const budgets = {
  "initial-js": { metric: "gzipBytes", limit: 130_000 },
  "lazy-detail": { metric: "gzipBytes", limit: 6_500 },
  "lazy-forecast": { metric: "gzipBytes", limit: 2_500 },
  "lazy-solver": { metric: "gzipBytes", limit: 5_000 },
  "lazy-stats": { metric: "gzipBytes", limit: 90_000 },
  worker: { metric: "rawBytes", limit: 450_000 },
  css: { metric: "gzipBytes", limit: 20_000 },
  wasm: { metric: "rawBytes", limit: 115_000 },
} as const;

const failures: string[] = [];
for (const [kind, budget] of Object.entries(budgets)) {
  const actual = report.totals[kind]?.[budget.metric] ?? 0;
  if (actual > budget.limit) failures.push(`${kind} ${actual} exceeds ${budget.limit}`);
}

if (failures.length > 0) throw new Error(`Bundle budget exceeded:\n${failures.join("\n")}`);
console.log(JSON.stringify({ budgets, totals: report.totals }, null, 2));
