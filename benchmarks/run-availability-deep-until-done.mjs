// Durable driver for the multi-hour deep evaluation: re-invokes the checkpointed slice runner
// until phase === "completed". Each child slice does as much as fits in AVAILABILITY_DEEP_SLICE_MS
// and persists a checkpoint, so the whole run survives restarts and can be resumed by simply
// running this script again (without AVAILABILITY_DEEP_LOOP_RESET).
//
// Env:
//   AVAILABILITY_DEEP_LOOP_RESET=1   reset the checkpoint before the FIRST slice (fresh run)
//   AVAILABILITY_DEEP_MAX_SLICES=N   safety cap on slice invocations (default 100000)
//   (all AVAILABILITY_DEEP_* env vars are passed through to the slice runner)

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./run-availability-deep-slice.mjs", import.meta.url));
const OUTPUT = fileURLToPath(new URL("./results/availability-deep-slice.json", import.meta.url));
const maxSlices = Number(process.env.AVAILABILITY_DEEP_MAX_SLICES || 100000);

async function readState() {
  try {
    const json = JSON.parse(await readFile(OUTPUT, "utf8"));
    return {
      phase: json.phase,
      signature: `${json.phase}|${json.exactJobIndex}|${json.finiteTailJobIndex}|${json.journeyTailJobIndex}`,
    };
  } catch {
    return { phase: null, signature: null };
  }
}

let previousSignature = null;
let stalledCount = 0;

for (let slice = 1; slice <= maxSlices; slice += 1) {
  const env = { ...process.env };
  // Only the first slice may reset; later slices must resume.
  if (slice === 1 && process.env.AVAILABILITY_DEEP_LOOP_RESET === "1") {
    env.AVAILABILITY_DEEP_SLICE_RESET = "1";
  } else {
    delete env.AVAILABILITY_DEEP_SLICE_RESET;
  }

  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [SCRIPT], { stdio: "inherit", env });
  const elapsedS = Math.round((Date.now() - startedAt) / 1000);
  if (result.status !== 0) {
    console.error(`[loop] slice ${slice} failed (exit ${result.status}); stopping.`);
    process.exit(result.status || 1);
  }

  const { phase, signature } = await readState();
  console.log(`[loop] slice ${slice} done in ${elapsedS}s; phase=${phase}; sig=${signature}`);

  if (phase === "completed") {
    console.log(`[loop] deep evaluation completed after ${slice} slice(s).`);
    break;
  }

  // Stall guard: if a slice makes no measurable progress twice in a row, something is stuck
  // (e.g., a trajectory job that cannot fit the budget). Bail rather than spin forever.
  if (signature !== null && signature === previousSignature) {
    stalledCount += 1;
    if (stalledCount >= 2) {
      console.error(
        `[loop] no progress over ${stalledCount + 1} slices (sig=${signature}); stopping.`,
      );
      process.exit(2);
    }
  } else {
    stalledCount = 0;
  }
  previousSignature = signature;
}
