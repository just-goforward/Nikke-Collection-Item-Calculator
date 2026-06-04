// Auto-finish orchestrator: waits for the deep run to reach phase=completed, then runs
// significance -> select -> analyze in sequence. Safe to launch while the deep run is still in
// progress because it only polls the deep results file and never touches the deep checkpoint.
//
// Liveness without a fragile process check: progress is the deep's completed journey-job count.
// If that count does not advance for FINISH_STALL_MS, the deep is assumed dead/stuck and the
// orchestrator bails without running downstream stages, so they never consume a half-finished
// sweep.
//
// Env:
//   FINISH_POLL_MS     poll interval while waiting (default 60000)
//   FINISH_STALL_MS    no-progress window that counts as "deep died" (default 1800000 = 30m)
//   FINISH_MAX_WAIT_MS overall safety cap (default 28800000 = 8h)
//   AVAILABILITY_SIG_* passed through to the significance stage

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parsePositiveInteger } from "./runner-utils";

const SLICE = new URL("./results/availability-deep-slice.json", import.meta.url);
const pollMs = parsePositiveInteger(process.env.FINISH_POLL_MS, 60_000);
const stallMs = parsePositiveInteger(process.env.FINISH_STALL_MS, 30 * 60 * 1000);
const maxWaitMs = parsePositiveInteger(process.env.FINISH_MAX_WAIT_MS, 8 * 3600 * 1000);

type FinishDeepState = {
  phase: string | null;
  journeyDone: number | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function deepState(): Promise<FinishDeepState> {
  try {
    const value: unknown = JSON.parse(await readFile(SLICE, "utf8"));
    if (!isObject(value)) return { phase: null, journeyDone: null };

    const phase = typeof value.phase === "string" ? value.phase : null;
    const journeyDemand = Array.isArray(value.journeyDemand) ? value.journeyDemand : [];
    const panels = journeyDemand.flatMap((candidate) =>
      isObject(candidate) && Array.isArray(candidate.panels) ? candidate.panels : [],
    );

    return {
      phase,
      journeyDone: panels.filter((panel) => isObject(panel) && panel.status === "completed").length,
    };
  } catch {
    return { phase: null, journeyDone: null };
  }
}

function runStage(scriptFile: string): void {
  console.log(`[finish] === running ${scriptFile} ===`);
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL(scriptFile, import.meta.url))],
    {
      stdio: "inherit",
      env: process.env,
    },
  );
  if (result.status !== 0) {
    console.error(`[finish] ${scriptFile} failed (exit ${result.status}); stopping pipeline.`);
    process.exit(result.status || 1);
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
    if (lastDone !== -1) {
      console.log(`[finish] deep progress: journeyDone ${lastDone} -> ${journeyDone}`);
    }
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

runStage("./run-availability-significance.ts");
runStage("./run-availability-select.ts");
runStage("./analyze-availability.ts");
console.log("[finish] pipeline complete: significance -> select -> analyze done.");
