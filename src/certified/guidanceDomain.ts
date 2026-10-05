import { CAPS, EDGES, TERMINAL, type Units } from "./game";
import type { Triple } from "./types";

export const GUIDE_DIMENSIONS = [0, 1, 2].map((k) => Math.max(...CAPS.map((cap) => cap[k]!)) + 1);
const yellowStride = GUIDE_DIMENSIONS[2]!;
const blueStride = GUIDE_DIMENSIONS[1]! * yellowStride;
const stateStride = GUIDE_DIMENSIONS[0]! * blueStride;
const greatestKey = TERMINAL * stateStride - 1;
if (!Number.isSafeInteger(greatestKey)) throw new Error("certified_guidance_key_domain");

const MAX_STEPS: number[] = Array(TERMINAL + 1).fill(0);
for (let sid = TERMINAL - 1; sid >= 0; sid--) {
  for (const [p, great, normal] of EDGES[sid]!) {
    if (p > 0) MAX_STEPS[sid] = Math.max(MAX_STEPS[sid]!, 1 + MAX_STEPS[great]!);
    if (p < 1000) MAX_STEPS[sid] = Math.max(MAX_STEPS[sid]!, 1 + MAX_STEPS[normal]!);
  }
}

export type GuidedState = { units: Units; exponent: number; key: number };
export function guidedState(sid: number, raw: Triple): GuidedState {
  const units: Units = [0, 1, 2].map((k) => Math.min(raw[k]!, CAPS[sid]![k]!)) as Units;
  return {
    units,
    exponent: Math.min(units[0] + units[1] + units[2], MAX_STEPS[sid]!),
    key: sid * stateStride + units[0] * blueStride + units[1] * yellowStride + units[2],
  };
}
