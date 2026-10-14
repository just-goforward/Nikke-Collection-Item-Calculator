import { CERTIFIED_STAGING_ENGINE_PROFILE } from "../../shared/certifiedEngineProfile";
import type { CertifiedInput, CertifiedOutput, Triple } from "../certified/types";
import { prepareCertifiedForecast } from "../lib/certifiedForecast";
import type { createBrowserCertifiedClient } from "./browserClient";

export const MINIMUM_WAIT_TIMING_REPEATS = 5;

/** Input coordinates from the M14 research experiment; no expected/oracle values. */
export const MINIMUM_WAIT_TIMING_CASES: readonly {
  id: string;
  grade: "R" | "SR";
  level: number;
  stock: Triple;
}[] = [
  { id: "R0", grade: "R", level: 0, stock: [30, 20, 10] },
  { id: "R10", grade: "R", level: 10, stock: [20, 20, 10] },
  { id: "R14", grade: "R", level: 14, stock: [10, 10, 20] },
  { id: "SR5", grade: "SR", level: 5, stock: [20, 20, 10] },
  { id: "SR10", grade: "SR", level: 10, stock: [20, 10, 10] },
  { id: "SR13", grade: "SR", level: 13, stock: [10, 10, 0] },
];

export function summarizeMinimumWaitTimings(
  results: readonly { id: string; elapsedMs: number; targetMet: boolean; status: string }[],
) {
  return MINIMUM_WAIT_TIMING_CASES.map(({ id }) => {
    const samples = results.filter((row) => row.id === id);
    const times = samples.map((row) => row.elapsedMs).sort((a, b) => a - b);
    const medianMs = times[2];
    const maxMs = times[4];
    if (
      times.length !== MINIMUM_WAIT_TIMING_REPEATS ||
      medianMs === undefined ||
      maxMs === undefined
    )
      throw new Error("minimum_wait_timing_requires_five_samples");
    return {
      id,
      samples: samples.length,
      medianMs,
      maxMs,
      targetMs: 15_000,
      withinBudget: samples.filter((row) => row.targetMet).length,
      completed: samples.filter((row) => row.status === "completed").length,
    };
  });
}

export async function minimumWaitTimingInput(id: string): Promise<CertifiedInput> {
  const fixture = MINIMUM_WAIT_TIMING_CASES.find((entry) => entry.id === id);
  if (!fixture) throw new Error("unknown_minimum_wait_fixture");
  const asOf = "2026-10-13T04:38:49.399Z";
  const snapshot = await prepareCertifiedForecast(asOf);
  return {
    grade: fixture.grade,
    level: fixture.level,
    exp: 0,
    stock: fixture.stock,
    asOf,
    snapshot,
    batchLimit: 10,
    computeMinimumWait: true,
    computeWaiting: true,
    receivedEventIds: snapshot.events
      .filter((event) => event.gameDate === snapshot.coverage.currentDay)
      .map((event) => event.id),
  };
}

/** A fresh worker per case. Includes preparation, trust binding, current
 * recommendation, minimum-wait/tie stage and H56 (within the remaining budget).
 * Module imports are outside timing; WASM loading/compilation is inside it.
 */
export async function measureMinimumWaitRequest(
  id: string,
  createClient: () => ReturnType<typeof createBrowserCertifiedClient>,
) {
  const started = performance.now();
  const client = createClient();
  const stages: { elapsedMs: number; minimumWait: CertifiedOutput["minimumWait"] }[] = [];
  try {
    const input = await minimumWaitTimingInput(id);
    const remaining = 15_000 - (performance.now() - started);
    if (remaining <= 0) throw new Error("preparation_exceeded_15000ms_target");
    const result = await client.request(input, {
      sessionId: `minimum-wait-timing:${id}`,
      engineProfile: CERTIFIED_STAGING_ENGINE_PROFILE,
      totalDeadlineMs: remaining,
      onCurrent: (output) =>
        stages.push({
          elapsedMs: performance.now() - started,
          minimumWait: output.minimumWait,
        }),
    });
    const elapsedMs = performance.now() - started;
    return {
      id,
      elapsedMs,
      targetMs: 15_000,
      targetMet: elapsedMs <= 15_000,
      status: result.output.status,
      recommendation: result.output.current,
      minimumWait: result.output.minimumWait,
      waiting: result.output.waiting.status,
      refusal: result.output.refusal,
      timing: result.timing,
      memory: result.memory,
      stages,
    };
  } catch (error) {
    return {
      id,
      elapsedMs: performance.now() - started,
      targetMs: 15_000,
      targetMet: false,
      status: "error",
      reason: error instanceof Error ? error.message : String(error),
      stages,
    };
  } finally {
    await client.dispose();
  }
}
