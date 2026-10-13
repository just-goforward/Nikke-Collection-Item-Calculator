// Resume of the sv1 plan (seed 0x5f1d2c3b, 150/stratum). Case inputs are taken verbatim
// from the original sv1-results.jsonl (records with harness not_executed:wall_budget);
// the sampler is not re-run. Evaluation reuses the unchanged worker.ts (same checks and
// status rules). Usage:
//   node --experimental-transform-types --max-old-space-size=512 resume.ts <workers> <wallMs>
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKERS = Number(process.argv[2] ?? 3);
const WALL_MS = Number(process.argv[3] ?? 840_000);
const CASE_TIMEOUT_MS = 30_000;
const WORKER_HEAP_MB = 3072;
const started = Date.now();

const ORIGINAL = join(HERE, "sv1-results.jsonl");
const ORIGINAL_SUMMARY = join(HERE, "sv1-summary.json");
const RESUME = join(HERE, "sv1-resume-results.jsonl");
const COMBINED = join(HERE, "sv1-combined-summary.json");
const FAIL_PATH = join(HERE, "sv1-resume-fail-repro.json");
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const originalSha = { results: sha(ORIGINAL), summary: sha(ORIGINAL_SUMMARY) };
const originalSummary = JSON.parse(readFileSync(ORIGINAL_SUMMARY, "utf8"));

const CASE_KEYS = ["id", "stratum", "grade", "level", "exp", "stock", "prices", "batchLimit"] as const;
const original = readFileSync(ORIGINAL, "utf8").trim().split("\n").map((line) => JSON.parse(line));
if (original.length !== originalSummary.planned) throw new Error("original record count mismatch");
original.forEach((r, i) => {
  if (r.id !== i) throw new Error(`original id order mismatch at ${i}`);
});
const notExecuted = (r: any) => r.checks?.harness?.reason === "not_executed:wall_budget";
const executedOriginal = original.filter((r) => !notExecuted(r));
const todo = original.filter(notExecuted).map((r) => {
  const c: any = {};
  for (const key of CASE_KEYS) if (r[key] !== undefined) c[key] = r[key];
  return c;
});
if (executedOriginal.length !== originalSummary.executed) throw new Error("executed count mismatch");
if (todo.some((c, i) => c.id !== originalSummary.executed + i)) throw new Error("resume index gap");
console.log(JSON.stringify({ resumeFrom: todo[0]?.id, cases: todo.length, workers: WORKERS }));

writeFileSync(RESUME, "");
const resumed: any[] = [];
const record = (r: any) => {
  resumed.push(r);
  appendFileSync(RESUME, `${JSON.stringify(r)}\n`);
};

let stopReason: string | null = null;
let failCase: any = null;
let executed = 0;
let next = 0;

function startWorker(): Promise<Worker> {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
  });
  return new Promise((resolve, reject) => {
    const onReady = (m: any) => {
      if (m.ready) {
        worker.off("message", onReady);
        worker.off("error", reject);
        resolve(worker);
      }
    };
    worker.on("message", onReady);
    worker.once("error", reject);
  });
}

function run(worker: Worker, c: any): Promise<any> {
  return new Promise((resolve) => {
    const done = (m: any) => {
      clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      resolve(m);
    };
    const onMessage = (m: any) => done(m);
    const onError = (e: unknown) => done({ ok: false, error: `worker_error:${e}` });
    const onExit = (code: number) => done({ ok: false, error: `worker_exit:${code}` });
    const timer = setTimeout(() => done({ ok: false, timeout: true }), CASE_TIMEOUT_MS);
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
    worker.postMessage(c);
  });
}

async function lane() {
  let worker = await startWorker();
  for (;;) {
    if (stopReason || next >= todo.length) break;
    if (Date.now() - started > WALL_MS) {
      stopReason = "wall_budget";
      break;
    }
    const c = todo[next++];
    const message = await run(worker, c);
    executed++;
    if (message.ok) {
      record(message.record);
      if (message.record.status === "FAIL") {
        stopReason = "FAIL_found";
        failCase ??= message.record;
      }
    } else if (message.timeout) {
      await worker.terminate();
      record({ ...c, status: "NOTRUN", endpoint: "NOTRUN", checks: { harness: { status: "NOTRUN", reason: `case_timeout_${CASE_TIMEOUT_MS}ms` } } });
      worker = await startWorker();
    } else {
      record({ ...c, status: "ERROR", endpoint: "ERROR", checks: { harness: { status: "ERROR", reason: message.error } } });
      stopReason = "ERROR_found";
      failCase ??= { ...c, error: message.error };
      if (String(message.error).startsWith("worker_")) worker = await startWorker();
    }
  }
  await worker.terminate();
}
await Promise.all(Array.from({ length: WORKERS }, lane));
for (const c of todo.slice(next))
  record({ ...c, status: "NOTRUN", endpoint: "NOTRUN", checks: { harness: { status: "NOTRUN", reason: `not_executed:${stopReason}` } } });
if (failCase) writeFileSync(FAIL_PATH, `${JSON.stringify(failCase, null, 2)}\n`);

// Combined counts: original executed records + resume records (same tallying as main.ts).
const counts: Record<string, Record<string, number>> = {};
const reasons: Record<string, Record<string, number>> = {};
const bump = (table: Record<string, Record<string, number>>, a: string, b: string) => {
  table[a] ??= {};
  table[a][b] = (table[a][b] ?? 0) + 1;
};
const combined = [...executedOriginal, ...resumed].sort((a, b) => a.id - b.id);
if (combined.length !== originalSummary.planned) throw new Error("combined count mismatch");
for (const r of combined) {
  bump(counts, r.stratum, r.status);
  bump(counts, r.stratum, `endpoint_${r.endpoint}`);
  for (const [name, check] of Object.entries(r.checks ?? {}) as [string, any][]) {
    bump(counts, r.stratum, `${name}_${check.status}`);
    if (check.status !== "PASS") bump(reasons, `${name}_${check.status}`, check.reason.replace(/\d+/g, "#"));
  }
}
const totals = (records: any[]) => {
  const t: Record<string, number> = { PASS: 0, FAIL: 0, NOTRUN: 0, ERROR: 0 };
  for (const r of records) t[r.status] = (t[r.status] ?? 0) + 1;
  return t;
};
if (sha(ORIGINAL) !== originalSha.results || sha(ORIGINAL_SUMMARY) !== originalSha.summary)
  throw new Error("original files changed during resume");
const summary = {
  label: "SAMPLED EVIDENCE ONLY - not a proof of correctness over the domain",
  seed: originalSummary.seed,
  prng: originalSummary.prng,
  perStratum: originalSummary.perStratum,
  planned: originalSummary.planned,
  statusDefinition: originalSummary.statusDefinition,
  original: { executed: executedOriginal.length, totals: totals(executedOriginal), sha256: originalSha },
  resume: {
    caseIds: [todo[0]?.id, todo.at(-1)?.id],
    cases: todo.length,
    executed,
    stopReason,
    workers: WORKERS,
    workerHeapMb: WORKER_HEAP_MB,
    mainHeapMb: 512,
    caseTimeoutMs: CASE_TIMEOUT_MS,
    wallMs: Date.now() - started,
    node: process.version,
    totals: totals(resumed),
    resultsJsonl: { path: RESUME, sha256: sha(RESUME) },
    failRepro: failCase ? FAIL_PATH : null,
  },
  combinedTotals: totals(combined),
  counts,
  nonPassReasons: reasons,
  inputSha256: {
    ...originalSummary.inputSha256,
    harness_main: sha(join(HERE, "main.ts")),
    harness_worker: sha(join(HERE, "worker.ts")),
    harness_hooks: sha(join(HERE, "hooks.mjs")),
    harness_resume: sha(fileURLToPath(import.meta.url)),
    "public/certified_solver.wasm": sha("public/certified_solver.wasm"),
    "scripts/certified-staging-oracle.ts": sha("scripts/certified-staging-oracle.ts"),
    "scripts/certified-staging-oracle-lane.ts": sha("scripts/certified-staging-oracle-lane.ts"),
    "src/certified/wasmBackend.ts": sha("src/certified/wasmBackend.ts"),
    "src/certified/kernel.ts": sha("src/certified/kernel.ts"),
    "src/certified/current.ts": sha("src/certified/current.ts"),
  },
  inputsUnchangedSinceOriginal: Object.keys(originalSummary.inputSha256).every(
    (key) =>
      key === "harness_main" || key === "harness_worker" || key === "harness_hooks" ||
      originalSummary.inputSha256[key] ===
        sha(key.startsWith("harness_") ? "" : key),
  ),
  harnessUnchangedSinceOriginal:
    originalSummary.inputSha256.harness_main === sha(join(HERE, "main.ts")) &&
    originalSummary.inputSha256.harness_worker === sha(join(HERE, "worker.ts")) &&
    originalSummary.inputSha256.harness_hooks === sha(join(HERE, "hooks.mjs")),
};
writeFileSync(COMBINED, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ resume: summary.resume.totals, combined: summary.combinedTotals, stopReason, executed, wallMs: summary.resume.wallMs }));
