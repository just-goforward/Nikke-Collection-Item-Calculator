// Seeded sampled comparison driver. Usage:
//   node --experimental-transform-types --max-old-space-size=512 main.ts <seed> <casesPerStratum> <wallMs> <outPrefix>
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const HERE = dirname(fileURLToPath(import.meta.url));
await import("./hooks.mjs");
const { CAPS, EDGES, encode } = await import("../../src/certified/game.ts");

const SEED = Number(process.argv[2] ?? 0x5f1d2c3b) >>> 0;
const PER_STRATUM = Number(process.argv[3] ?? 10);
const WALL_MS = Number(process.argv[4] ?? 60_000);
const PREFIX = process.argv[5] ?? "run";
const CASE_TIMEOUT_MS = 30_000;
const WORKER_HEAP_MB = 3072;
const started = Date.now();

// mulberry32
let rngState = SEED;
function rand(): number {
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const rint = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
const big = (bits: number) => {
  let v = 0n;
  for (let i = 0; i < bits; i += 16) v = (v << 16n) | BigInt(rint(0, 0xffff));
  return v & ((1n << BigInt(bits)) - 1n);
};
function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a;
}
type Wire = { numerator: string; denominator: string };
function wq(n: bigint, d: bigint): Wire {
  const g = gcd(n, d) || 1n;
  return { numerator: String(n / g), denominator: String(d / g) };
}

type Grade = "R" | "SR";
type State = { grade: Grade; level: number; exp: number };
const maxExp = (g: Grade) => (g === "R" ? 900 : 2900);
const legalExp = (g: Grade, level: number) => (level === 15 ? 0 : 100 * rint(0, maxExp(g) / 100));
function randomState(): State {
  const grade = pick(["R", "SR"] as const);
  const level = rint(0, 15);
  return { grade, level, exp: legalExp(grade, level) };
}
const sidOf = (s: State) => encode(s.grade, s.level, s.exp);
const capPieces = (s: State, k: number) => CAPS[sidOf(s)][k] * 10;

// Prices: any nonnegative rational at the kernel boundary; zero only where the
// product pricing could produce it (basis+rate = 0, not usable: stock < 10).
function positivePrice(): Wire {
  switch (rint(0, 5)) {
    case 0:
      return wq(1n, BigInt(rint(1, 100_000)));
    case 1:
      return wq(BigInt(rint(1, 1000)), BigInt(rint(1, 1000)));
    case 2:
      return wq(big(60) + 1n, big(60) + 1n);
    case 3: {
      // product-shaped 1/(basis + a/b)
      const basis = BigInt(rint(0, 100_000));
      const a = BigInt(rint(0, 1_000_000));
      const b = BigInt(rint(1, 1_000_000));
      return basis * b + a === 0n ? wq(1n, 1n) : wq(b, basis * b + a);
    }
    case 4:
      return wq(1n, 1n);
    default:
      return wq(big(90) + 1n, 1n);
  }
}
type PriceMode = "equal" | "skewed" | "independent" | "large" | "zero_where_legal";
function prices(stock: number[], mode: PriceMode, terminal: boolean): [Wire, Wire, Wire] {
  if (mode === "equal") {
    const p = positivePrice();
    return [p, p, p];
  }
  if (mode === "skewed") {
    const order = [wq(1n, 1_000_000_000n), wq(1n, 1n), wq(1_000_000_000n, 1n)];
    for (let i = 2; i > 0; i--) {
      const j = rint(0, i);
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order as [Wire, Wire, Wire];
  }
  if (mode === "large")
    return [0, 1, 2].map(() => wq(big(120) + 1n, big(120) + 1n)) as [Wire, Wire, Wire];
  const base = [positivePrice(), positivePrice(), positivePrice()];
  if (mode === "zero_where_legal")
    return base.map((p, k) =>
      terminal || stock[k] < 10 ? (rand() < 0.7 ? wq(0n, 1n) : p) : p,
    ) as [Wire, Wire, Wire];
  return base as [Wire, Wire, Wire];
}
const anyPriceMode = (): PriceMode =>
  pick(["equal", "skewed", "independent", "large", "zero_where_legal"] as const);
const batch = () => pick([undefined, 1, 2, 3, 5, 10, 1000, rint(1, 1000)]);

// Stocks
function smallStock(maxUses = 30): number[] {
  const uses = rint(0, maxUses);
  const a = rint(0, uses);
  const b = rint(0, uses - a);
  const units = [a, b, uses - a - b].sort(() => rand() - 0.5);
  return units.map((u) => u * 10 + (rand() < 0.5 ? rint(1, 9) : 0));
}
function nonMultipleStock(): number[] {
  return [0, 1, 2].map(() => pick([0, rint(1, 9), rint(1, 25) * 10 + rint(1, 9), rint(10, 99)]));
}
function nearCapStock(s: State): number[] {
  return [0, 1, 2].map((k) => Math.max(0, Math.min(100_000, capPieces(s, k) + rint(-15, 15))));
}
function largeStock(): number[] {
  return [0, 1, 2].map(() =>
    pick([100_000, 99_999, 0, 9, 10, rint(0, 100_000), Math.floor(10 ** (rand() * 5))]),
  );
}

type Case = State & {
  id: number;
  stratum: string;
  stock: [number, number, number];
  prices: [Wire, Wire, Wire];
  batchLimit?: number;
};
let nextId = 0;
function make(stratum: string, s: State, stock: number[], mode = anyPriceMode()): Case {
  const terminal = s.grade === "SR" && s.level === 15;
  const c: Case = {
    id: nextId++,
    stratum,
    ...s,
    stock: stock as [number, number, number],
    prices: prices(stock, mode, terminal),
  };
  const limit = batch();
  if (limit !== undefined) c.batchLimit = limit;
  return c;
}
const STRATA: Record<string, () => Case> = {
  small_random: () => make("small_random", randomState(), smallStock()),
  nonmultiple_stock: () => make("nonmultiple_stock", randomState(), nonMultipleStock()),
  near_saturation_caps: () => {
    const s = randomState();
    return make("near_saturation_caps", s, nearCapStock(s));
  },
  large_stock_le100000: () => make("large_stock_le100000", randomState(), largeStock()),
  stage_boundary_4_9_14: () => {
    const grade = pick(["R", "SR"] as const);
    const level = pick([4, 9, 14]);
    const exp = pick([0, maxExp(grade), maxExp(grade) - 100, legalExp(grade, level)]);
    const s = { grade, level, exp };
    return make("stage_boundary_4_9_14", s, pick([smallStock(), nearCapStock(s), nonMultipleStock()]));
  },
  R15_promotion: () => {
    const s: State =
      rand() < 0.6 ? { grade: "R", level: 15, exp: 0 } : { grade: "R", level: 14, exp: pick([0, 500, 800, 900]) };
    return make("R15_promotion", s, pick([smallStock(), nearCapStock(s), largeStock()]));
  },
  SR15_terminal: () => {
    const s: State = { grade: "SR", level: 15, exp: 0 };
    return make("SR15_terminal", s, pick([smallStock(), largeStock(), [0, 0, 0]]));
  },
  p1000_actions: () => {
    for (;;) {
      const s = randomState();
      if (s.level === 15) continue;
      const kits = [0, 1, 2].filter((k) => EDGES[sidOf(s)][k][0] === 1000);
      if (!kits.length) continue;
      const stock = pick([smallStock(12), nearCapStock(s), nonMultipleStock()]);
      const k = pick(kits);
      stock[k] = Math.max(stock[k], rint(10, 19));
      return make("p1000_actions", s, stock);
    }
  },
  ties: () => {
    const variant = rint(0, 2);
    if (variant === 0) {
      // R4/R9/R14: purple and yellow both p=1000; equal purple/yellow prices.
      const s: State = { grade: "R", level: pick([4, 9, 14]), exp: 100 * rint(0, 9) };
      const stock = [pick([0, rint(0, 40)]), rint(10, 60), rint(10, 60)];
      const c = make("ties", s, stock, "independent");
      c.prices[2] = c.prices[1];
      return c;
    }
    if (variant === 1) {
      // No usable stock: STOP (mask 0) unless terminal.
      const s = randomState();
      return make("ties", s, [rint(0, 9), rint(0, 9), rint(0, 9)]);
    }
    const s = randomState();
    return make("ties", s, smallStock(20), "equal");
  },
  price_extremes: () =>
    make("price_extremes", randomState(), pick([smallStock(), nearCapStock(randomState()), largeStock()]), pick(["skewed", "large", "zero_where_legal"] as const)),
};

const names = Object.keys(STRATA);
const cases: Case[] = [];
for (let i = 0; i < PER_STRATUM; i++) for (const name of names) cases.push(STRATA[name]());

const jsonl = join(HERE, `${PREFIX}-results.jsonl`);
const summaryPath = join(HERE, `${PREFIX}-summary.json`);
const failPath = join(HERE, `${PREFIX}-fail-repro.json`);
writeFileSync(jsonl, "");
const counts: Record<string, Record<string, number>> = {};
const reasons: Record<string, Record<string, number>> = {};
const bump = (table: Record<string, Record<string, number>>, a: string, b: string) => {
  table[a] ??= {};
  table[a][b] = (table[a][b] ?? 0) + 1;
};
function record(r: any) {
  appendFileSync(jsonl, `${JSON.stringify(r)}\n`);
  bump(counts, r.stratum, r.status);
  bump(counts, r.stratum, `endpoint_${r.endpoint}`);
  for (const [name, check] of Object.entries(r.checks ?? {}) as [string, any][]) {
    bump(counts, r.stratum, `${name}_${check.status}`);
    if (check.status !== "PASS") bump(reasons, `${name}_${check.status}`, check.reason.replace(/\d+/g, "#"));
  }
}

let worker: Worker;
let pending: { resolve: (m: any) => void } | null = null;
function spawn(): Promise<void> {
  worker = new Worker(new URL("./worker.ts", import.meta.url), {
    resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
  });
  return new Promise((resolve, reject) => {
    worker.once("error", reject);
    worker.on("message", (m) => {
      if (m.ready) return resolve();
      pending?.resolve(m);
    });
    worker.on("error", (e) => pending?.resolve({ ok: false, error: `worker_error:${e}` }));
    worker.on("exit", (code) => pending?.resolve({ ok: false, error: `worker_exit:${code}` }));
  });
}
await spawn();

let stopReason: string | null = null;
let failCase: any = null;
let executed = 0;
for (const c of cases) {
  if (stopReason) {
    record({ ...c, status: "NOTRUN", endpoint: "NOTRUN", checks: { harness: { status: "NOTRUN", reason: `not_executed:${stopReason}` } } });
    continue;
  }
  if (Date.now() - started > WALL_MS) {
    stopReason = "wall_budget";
    record({ ...c, status: "NOTRUN", endpoint: "NOTRUN", checks: { harness: { status: "NOTRUN", reason: "not_executed:wall_budget" } } });
    continue;
  }
  const message: any = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, timeout: true }), CASE_TIMEOUT_MS);
    pending = {
      resolve: (m) => {
        clearTimeout(timer);
        resolve(m);
      },
    };
    worker.postMessage(c);
  });
  pending = null;
  executed++;
  if (message.ok) {
    record(message.record);
    if (message.record.status === "FAIL") {
      stopReason = "FAIL_found";
      failCase = message.record;
    }
  } else if (message.timeout) {
    await worker.terminate();
    record({ ...c, status: "NOTRUN", endpoint: "NOTRUN", checks: { harness: { status: "NOTRUN", reason: `case_timeout_${CASE_TIMEOUT_MS}ms` } } });
    await spawn();
  } else {
    record({ ...c, status: "ERROR", endpoint: "ERROR", checks: { harness: { status: "ERROR", reason: message.error } } });
    stopReason = "ERROR_found";
    failCase = { ...c, error: message.error };
    if (String(message.error).startsWith("worker_")) await spawn();
  }
}
await worker.terminate();
if (failCase) writeFileSync(failPath, `${JSON.stringify(failCase, null, 2)}\n`);

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const totals: Record<string, number> = {};
for (const table of Object.values(counts))
  for (const status of ["PASS", "FAIL", "NOTRUN", "ERROR"]) totals[status] = (totals[status] ?? 0) + (table[status] ?? 0);
const summary = {
  label: "SAMPLED EVIDENCE ONLY - not a proof of correctness over the domain",
  seed: SEED,
  prng: "mulberry32",
  perStratum: PER_STRATUM,
  planned: cases.length,
  executed,
  stopReason,
  wallMs: Date.now() - started,
  caseTimeoutMs: CASE_TIMEOUT_MS,
  workerHeapMb: WORKER_HEAP_MB,
  node: process.version,
  statusDefinition:
    "PASS = lane verifyCurrent (exact P,B,C,consumed,mask,kit,status,pieces) PASS for WASM and JS backends, verifyBatch PASS, and the supplementary solveOracle cross-check PASS when admitted (<=24 uses; its non-admission does not downgrade); any FAIL => FAIL; otherwise any other NOTRUN => NOTRUN. endpoint_* = current endpoint checks (WASM+JS) only",
  totals,
  counts,
  nonPassReasons: reasons,
  failRepro: failCase ? failPath : null,
  inputSha256: {
    "public/certified_solver.wasm": sha("public/certified_solver.wasm"),
    "scripts/certified-staging-oracle.ts": sha("scripts/certified-staging-oracle.ts"),
    "scripts/certified-staging-oracle-lane.ts": sha("scripts/certified-staging-oracle-lane.ts"),
    "src/certified/wasmBackend.ts": sha("src/certified/wasmBackend.ts"),
    "src/certified/kernel.ts": sha("src/certified/kernel.ts"),
    "src/certified/current.ts": sha("src/certified/current.ts"),
    harness_main: sha(fileURLToPath(import.meta.url)),
    harness_worker: sha(join(HERE, "worker.ts")),
    harness_hooks: sha(join(HERE, "hooks.mjs")),
  },
  resultsJsonl: { path: jsonl, sha256: sha(jsonl) },
};
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ totals, stopReason, executed, planned: cases.length, wallMs: summary.wallMs }));
