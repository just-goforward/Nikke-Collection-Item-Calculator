// Auto-finish orchestrator: waits for the deep run to reach phase=completed, then runs
// significance -> select -> analyze in sequence (each gated on the previous succeeding). Safe to
// launch WHILE the deep run is still in progress — it only polls the deep results file and never
// touches the deep checkpoint.
//
// Liveness without a fragile process check: progress is the deep's completed journey-job count.
// If that count does not advance for FINISH_STALL_MS, the deep is assumed dead/stuck and the
// orchestrator bails WITHOUT running downstream stages, so they never consume a half-finished sweep.
//
// Env:
//   FINISH_POLL_MS     poll interval while waiting (default 60000)
//   FINISH_STALL_MS    no-progress window that counts as "deep died" (default 1800000 = 30m)
//   FINISH_MAX_WAIT_MS overall safety cap (default 28800000 = 8h)
//   AVAILABILITY_SIG_* passed through to the significance stage

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SLICE = new URL("./results/availability-deep-slice.json", import.meta.url);
const pollMs = Number(process.env.FINISH_POLL_MS || 60_000);
const stallMs = Number(process.env.FINISH_STALL_MS || 30 * 60 * 1000);
const maxWaitMs = Number(process.env.FINISH_MAX_WAIT_MS || 8 * 3600 * 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function deepState() {
  try {
    const j = JSON.parse(await readFile(SLICE, "utf8"));
    const jobs = (j.journeyDemand || []).flatMap((c) => c.panels);
    return { phase: j.phase, journeyDone: jobs.filter((p) => p.status === "completed").length };
  } catch {
    return { phase: null, journeyDone: null }; // absent or mid-write — treat as "no reading"
  }
}

function runStage(scriptFile) {
  console.log(`[finish] === running ${scriptFile} ===`);
  const r = spawnSync(process.execPath, [fileURLToPath(new URL(scriptFile, import.meta.url))], {
    stdio: "inherit",
    env: process.env,
  });
  if (r.status !== 0) {
    console.error(`[finish] ${scriptFile} failed (exit ${r.status}); stopping pipeline.`);
    process.exit(r.status || 1);
  }
}

const startedAt = Date.now();
let lastDone = -1;
let lastProgressAt = Date.now();
console.log(
  `[finish] waiting for deep completion (poll ${pollMs}ms, stall ${stallMs}ms, maxWait ${maxWaitMs}ms)...`,
);
for (;;) {
  const { phase, journeyDone } = await deepState();
  if (phase === "completed") {
    console.log(`[finish] deep completed (journeyDone=${journeyDone}). Proceeding.`);
    break;
  }
  if (journeyDone !== null && journeyDone !== lastDone) {
    if (lastDone !== -1)
      console.log(`[finish] deep progress: journeyDone ${lastDone} -> ${journeyDone}`);
    lastDone = journeyDone;
    lastProgressAt = Date.now();
  }
  if (Date.now() - startedAt > maxWaitMs) {
    console.error("[finish] max wait exceeded; bailing without running downstream stages.");
    process.exit(3);
  }
  if (Date.now() - lastProgressAt > stallMs) {
    console.error(
      `[finish] deep made no progress for ${Math.round(stallMs / 1000)}s (phase=${phase}, ` +
        `journeyDone=${journeyDone}); assuming it died. Bailing. Re-launch the deep run to finish, ` +
        "then re-run this orchestrator.",
    );
    process.exit(2);
  }
  await sleep(pollMs);
}

runStage("./run-availability-significance.mjs");
runStage("./run-availability-select.mjs");
runStage("./analyze-availability.mjs");
console.log("[finish] pipeline complete: significance -> select -> analyze done.");
