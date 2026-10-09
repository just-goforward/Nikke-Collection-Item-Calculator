import {
  CAPS,
  EDGES,
  type KitIndex,
  type StateId,
  type StateValues,
  TERMINAL,
  type Units,
} from "./game";
import type { Triple } from "./types";

const dimension = (k: KitIndex): number => Math.max(...CAPS.map((cap) => cap[k])) + 1;
export const GUIDE_DIMENSIONS: [number, number, number] = [
  dimension(0),
  dimension(1),
  dimension(2),
];
const yellowStride = GUIDE_DIMENSIONS[2];
const blueStride = GUIDE_DIMENSIONS[1] * yellowStride;
const stateStride = GUIDE_DIMENSIONS[0] * blueStride;
const greatestKey = TERMINAL * stateStride - 1;
if (!Number.isSafeInteger(greatestKey)) throw new Error("certified_guidance_key_domain");

const MAX_STEPS = Array<number>(TERMINAL + 1).fill(0) as number[] & StateValues<number>;
for (let sid = TERMINAL - 1; sid >= 0; sid--) {
  let longest = 0;
  for (const [p, great, normal] of EDGES[sid as StateId]) {
    if (p > 0) longest = Math.max(longest, 1 + MAX_STEPS[great as StateId]);
    if (p < 1000) longest = Math.max(longest, 1 + MAX_STEPS[normal as StateId]);
  }
  MAX_STEPS[sid] = longest;
}

export type GuidedState = { units: Units; exponent: number; key: number };
export function guidedState(sid: number, raw: Triple): GuidedState {
  const caps = CAPS[sid as StateId];
  const units: Units = [
    Math.min(raw[0], caps[0]),
    Math.min(raw[1], caps[1]),
    Math.min(raw[2], caps[2]),
  ];
  return {
    units,
    exponent: Math.min(units[0] + units[1] + units[2], MAX_STEPS[sid as StateId]),
    key: sid * stateStride + units[0] * blueStride + units[1] * yellowStride + units[2],
  };
}
