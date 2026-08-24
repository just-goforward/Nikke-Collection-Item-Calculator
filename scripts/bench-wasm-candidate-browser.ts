import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type Browser, type BrowserType, chromium, firefox, webkit } from "@playwright/test";
import { ACTIVE_SUPPLY_FORECAST_BASE_PROFILE } from "../shared/generated/supplyForecast.ts";

type BuildName = "base" | "candidate";
type BenchProfile = "minef-terminal-cache-v1" | "rust-toolchain-upgrade-v1";
type EngineName = "chromium" | "firefox" | "webkit";
type Outcome = "completed" | "memo_full" | "budget_exceeded" | "failure";
type SolvePhase = "instance_cold_solve" | "allocation_warm_solve";
type Stock = readonly [blue: number, purple: number, yellow: number];
type Scenario = {
  id: string;
  measured: Stock;
  preparation: Stock;
  stateId: number;
};
type RecordSample = {
  build: BuildName;
  campaign: number;
  elapsedMs: number;
  memoryAfter: number;
  memoryBefore: number;
  outcome: Outcome;
  phase: SolvePhase;
  repeat: number;
  scenario: string;
};
type CampaignResult = {
  campaign: number;
  compileMs: Record<BuildName, number>;
  engine: EngineName;
  instantiateMs: Record<BuildName, number[]>;
  records: RecordSample[];
  version: string;
};
type BrowserSample = Omit<RecordSample, "build" | "campaign" | "repeat"> & {
  instantiateMs: number;
};

const TERMINAL_CACHE_PROFILE = "minef-terminal-cache-v1" satisfies BenchProfile;
const TOOLCHAIN_UPGRADE_PROFILE = "rust-toolchain-upgrade-v1" satisfies BenchProfile;
const WARM_RATIO_TARGET = 0.97;
const COLD_PERCENT_LIMIT = 0.05;
const COLD_ABSOLUTE_LIMIT_MS = 2;
const GROSS_PERCENT_LIMIT = 0.1;
const GROSS_ABSOLUTE_LIMIT_MS = 5;
const scenarios: Scenario[] = [
  {
    id: "R0-remainder-denominators",
    measured: [61, 121, 901],
    preparation: [60, 120, 900],
    stateId: 0,
  },
  {
    id: "SR5-balanced",
    measured: [301, 301, 301],
    preparation: [300, 300, 300],
    stateId: (16 + 5) * 30,
  },
];

function requiredPath(name: "WASM_BASE_PATH" | "WASM_CANDIDATE_PATH") {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return resolve(value);
}

function positiveInteger(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function configuredProfile(): BenchProfile {
  const value = process.env["WASM_BENCH_PROFILE"];
  if (value === TERMINAL_CACHE_PROFILE || value === TOOLCHAIN_UPGRADE_PROFILE) return value;
  throw new Error(
    `WASM_BENCH_PROFILE must be ${TERMINAL_CACHE_PROFILE} or ${TOOLCHAIN_UPGRADE_PROFILE}.`,
  );
}

function quantile(values: number[], q: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? null;
}

function buildOrder(repeat: number): readonly BuildName[] {
  return repeat % 2 === 0 ? ["base", "candidate"] : ["candidate", "base"];
}

function engineSelection() {
  const selected = process.env["WASM_BROWSER_ENGINES"]?.split(",").map((value) => value.trim());
  const all = {
    chromium,
    firefox,
    webkit,
  } satisfies Record<EngineName, BrowserType>;
  const available: [EngineName, BrowserType][] = [
    ["chromium", all.chromium],
    ["firefox", all.firefox],
    ["webkit", all.webkit],
  ];
  if (!selected || selected.length === 0) return available;
  return selected.map((name) => {
    if (!(name in all)) throw new Error(`Unsupported browser engine ${name}.`);
    const engine = name as EngineName;
    return [engine, all[engine]] satisfies [EngineName, BrowserType];
  });
}

async function measureCompile(browser: Browser, artifacts: Record<BuildName, string>) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(async (encoded) => {
      function decode(value: string) {
        const binary = atob(value);
        return Uint8Array.from(binary, (character) => character.charCodeAt(0));
      }
      const timings = {} as Record<"base" | "candidate", number>;
      for (const build of ["base", "candidate"] as const) {
        const startedAt = performance.now();
        await WebAssembly.compile(decode(encoded[build]));
        timings[build] = performance.now() - startedAt;
      }
      return timings;
    }, artifacts);
  } finally {
    await page.close();
  }
}

async function measureBuildInBrowser({
  artifact,
  gain,
  scenarios: browserScenarios,
}: {
  artifact: string;
  gain: { blue: number; purple: number; yellow: number };
  scenarios: Scenario[];
}): Promise<BrowserSample[]> {
  type Exports = {
    configureMinEfMemo?: (tier: number) => void;
    configureNodeBudget?: (budget: number) => void;
    getSolveStatus?: () => number;
    memory?: WebAssembly.Memory;
    solveMinEf?: (
      stateId: number,
      blue: number,
      purple: number,
      yellow: number,
      blueGain: number,
      purpleGain: number,
      yellowGain: number,
      horizonFactor: number,
      normPower: number,
      tolerance: number,
    ) => void;
  };
  const binary = atob(artifact);
  const module = await WebAssembly.compile(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );

  function outcome(status: number): Outcome {
    if (status === 0) return "completed";
    if (status === 1) return "budget_exceeded";
    if (status === 2) return "memo_full";
    return "failure";
  }
  async function instantiate() {
    const startedAt = performance.now();
    const instance = await WebAssembly.instantiate(module);
    const elapsedMs = performance.now() - startedAt;
    const exports = instance.exports as Exports;
    exports.configureMinEfMemo?.(21);
    exports.configureNodeBudget?.(2_000_000);
    if (
      typeof exports.solveMinEf !== "function" ||
      typeof exports.getSolveStatus !== "function" ||
      !(exports.memory instanceof WebAssembly.Memory)
    ) {
      throw new Error("Required min-E[f] exports are missing.");
    }
    return { elapsedMs, exports };
  }
  function solve(exports: Exports, stateId: number, stock: readonly number[]) {
    exports.solveMinEf?.(
      stateId,
      stock[0] ?? 0,
      stock[1] ?? 0,
      stock[2] ?? 0,
      gain.blue,
      gain.purple,
      gain.yellow,
      0.75,
      3,
      0,
    );
    return outcome(exports.getSolveStatus?.() ?? -1);
  }

  const result: BrowserSample[] = [];
  for (const scenario of browserScenarios) {
    for (const phase of ["instance_cold_solve", "allocation_warm_solve"] as const) {
      const { elapsedMs: instantiateMs, exports } = await instantiate();
      if (phase === "allocation_warm_solve") {
        const preparation = solve(exports, scenario.stateId, scenario.preparation);
        if (preparation !== "completed") {
          throw new Error(`${scenario.id} warm preparation returned ${preparation}.`);
        }
      }
      const memoryBefore = exports.memory?.buffer.byteLength ?? 0;
      const startedAt = performance.now();
      const solveOutcome = solve(exports, scenario.stateId, scenario.measured);
      const elapsedMs = performance.now() - startedAt;
      result.push({
        elapsedMs,
        instantiateMs,
        memoryAfter: exports.memory?.buffer.byteLength ?? 0,
        memoryBefore,
        outcome: solveOutcome,
        phase,
        scenario: scenario.id,
      });
    }
  }
  return result;
}

async function collectBuildSample(browser: Browser, artifact: string) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(measureBuildInBrowser, {
      artifact,
      gain: ACTIVE_SUPPLY_FORECAST_BASE_PROFILE.expectedGain,
      scenarios,
    });
  } finally {
    await page.close();
  }
}

async function runCampaign({
  artifacts,
  browserType,
  campaign,
  engine,
  repeats,
}: {
  artifacts: Record<BuildName, string>;
  browserType: BrowserType;
  campaign: number;
  engine: EngineName;
  repeats: number;
}): Promise<CampaignResult> {
  const browser = await browserType.launch({ headless: true });
  try {
    const version = browser.version();
    const compileMs = await measureCompile(browser, artifacts);
    const instantiateMs: Record<BuildName, number[]> = { base: [], candidate: [] };
    const records: RecordSample[] = [];
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      for (const build of buildOrder(repeat)) {
        const sample = await collectBuildSample(browser, artifacts[build]);
        for (const entry of sample) {
          instantiateMs[build].push(entry.instantiateMs);
          records.push({
            build,
            campaign,
            elapsedMs: entry.elapsedMs,
            memoryAfter: entry.memoryAfter,
            memoryBefore: entry.memoryBefore,
            outcome: entry.outcome,
            phase: entry.phase,
            repeat,
            scenario: entry.scenario,
          });
        }
      }
      if ((repeat + 1) % 10 === 0 || repeat + 1 === repeats) {
        console.error(`${engine} campaign ${campaign}: ${repeat + 1}/${repeats}`);
      }
    }
    return { campaign, compileMs, engine, instantiateMs, records, version };
  } finally {
    await browser.close();
  }
}

function campaignSummary(campaign: CampaignResult) {
  return Object.fromEntries(
    scenarios.flatMap((scenario) =>
      (["instance_cold_solve", "allocation_warm_solve"] as const).map((phase) => {
        const values = (build: BuildName) =>
          campaign.records.filter(
            (record) =>
              record.build === build && record.scenario === scenario.id && record.phase === phase,
          );
        const base = values("base");
        const candidate = values("candidate");
        const ratios = base.flatMap((baseRecord) => {
          const candidateRecord = candidate.find((record) => record.repeat === baseRecord.repeat);
          return candidateRecord?.outcome === "completed" && baseRecord.outcome === "completed"
            ? [candidateRecord.elapsedMs / baseRecord.elapsedMs]
            : [];
        });
        return [
          `${scenario.id}:${phase}`,
          {
            base: {
              outcomes: [...new Set(base.map((record) => record.outcome))],
              p50Ms: quantile(
                base.map((record) => record.elapsedMs),
                0.5,
              ),
              p95Ms: quantile(
                base.map((record) => record.elapsedMs),
                0.95,
              ),
            },
            candidate: {
              outcomes: [...new Set(candidate.map((record) => record.outcome))],
              p50Ms: quantile(
                candidate.map((record) => record.elapsedMs),
                0.5,
              ),
              p95Ms: quantile(
                candidate.map((record) => record.elapsedMs),
                0.95,
              ),
            },
            pairedMedianRatio: quantile(ratios, 0.5),
          },
        ];
      }),
    ),
  );
}

type CampaignSummaryEntry = NonNullable<ReturnType<typeof campaignSummary>[string]>;

function outcomesAreStable(entry: CampaignSummaryEntry) {
  return (
    entry.base.outcomes.length === 1 &&
    entry.candidate.outcomes.length === 1 &&
    entry.base.outcomes[0] === "completed" &&
    entry.candidate.outcomes[0] === "completed"
  );
}

function exceedsLimit(
  entry: CampaignSummaryEntry,
  percent: number,
  absoluteMs: number,
  quantileName: "p50Ms" | "p95Ms",
) {
  const base = entry.base[quantileName];
  const candidate = entry.candidate[quantileName];
  return (
    base !== null && candidate !== null && candidate > base + Math.max(absoluteMs, base * percent)
  );
}

function reviewEntry(
  engine: EngineName,
  label: string,
  phase: SolvePhase,
  entry: CampaignSummaryEntry | undefined,
) {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (!entry) return { blockers: [`${engine}:${label} campaign summary is missing`], warnings };
  if (!outcomesAreStable(entry)) {
    return {
      blockers: [`${engine}:${label} outcome was not stable and completed`],
      warnings,
    };
  }
  if (exceedsLimit(entry, GROSS_PERCENT_LIMIT, GROSS_ABSOLUTE_LIMIT_MS, "p50Ms")) {
    blockers.push(`${engine}:${label} exceeded the gross regression limit`);
  }
  if (
    phase === "instance_cold_solve" &&
    exceedsLimit(entry, COLD_PERCENT_LIMIT, COLD_ABSOLUTE_LIMIT_MS, "p50Ms")
  ) {
    blockers.push(`${engine}:${label} exceeded the cold limit`);
  }
  if (exceedsLimit(entry, 0.05, 2, "p95Ms")) {
    warnings.push(`${engine}:${label} p95 warning`);
  }
  return { blockers, warnings };
}

function warmCampaignsPass(
  profile: BenchProfile,
  entries: Array<CampaignSummaryEntry | undefined>,
) {
  return (
    entries.length >= 2 &&
    entries.every(
      (entry) =>
        entry !== undefined &&
        (profile === TERMINAL_CACHE_PROFILE
          ? entry.pairedMedianRatio !== null && entry.pairedMedianRatio <= WARM_RATIO_TARGET
          : !exceedsLimit(entry, 0.05, 2, "p50Ms")),
    )
  );
}

function review(profile: BenchProfile, results: CampaignResult[]) {
  const blockers: string[] = [];
  const warnings: string[] = [];
  for (const engine of [...new Set(results.map((result) => result.engine))]) {
    const campaigns = results.filter((result) => result.engine === engine);
    for (const scenario of scenarios) {
      for (const phase of ["instance_cold_solve", "allocation_warm_solve"] as const) {
        const label = `${scenario.id}:${phase}`;
        const entries = campaigns.map((campaign) => campaignSummary(campaign)[label]);
        for (const entry of entries) {
          const entryReview = reviewEntry(engine, label, phase, entry);
          blockers.push(...entryReview.blockers);
          warnings.push(...entryReview.warnings);
        }
        if (phase === "allocation_warm_solve" && !warmCampaignsPass(profile, entries)) {
          blockers.push(`${engine}:${label} did not pass both p50 campaigns`);
        }
      }
    }
  }
  return { blockers, passed: blockers.length === 0, warnings };
}

async function main() {
  const profile = configuredProfile();
  const repeats = positiveInteger("WASM_BROWSER_REPEATS", 51);
  const campaignCount = positiveInteger("WASM_BROWSER_CAMPAIGNS", 2);
  const artifacts = {
    base: (await readFile(requiredPath("WASM_BASE_PATH"))).toString("base64"),
    candidate: (await readFile(requiredPath("WASM_CANDIDATE_PATH"))).toString("base64"),
  };
  const results: CampaignResult[] = [];
  for (const [engine, browserType] of engineSelection()) {
    for (let campaign = 1; campaign <= campaignCount; campaign += 1) {
      results.push(await runCampaign({ artifacts, browserType, campaign, engine, repeats }));
    }
  }
  const report = {
    generatedAt: new Date().toISOString(),
    profile,
    repeats,
    campaignCount,
    campaigns: results.map((result) => ({
      campaign: result.campaign,
      compileMs: result.compileMs,
      engine: result.engine,
      instantiateP50Ms: {
        base: quantile(result.instantiateMs.base, 0.5),
        candidate: quantile(result.instantiateMs.candidate, 0.5),
      },
      scenarios: campaignSummary(result),
      version: result.version,
    })),
    gate: review(profile, results),
    limitations: [
      "Playwright WebKit is not an iOS Safari device measurement",
      "p95 confirmation runs are required only when both n=51 campaigns warn",
    ],
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.gate.passed) process.exitCode = 1;
}

await main();
