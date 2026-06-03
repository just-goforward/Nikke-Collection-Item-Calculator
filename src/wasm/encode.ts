// Pure state/stock encoding shared by the Node loader (wasm.ts) and the browser loader (wasm-browser.ts).
// No I/O, no runtime deps — safe to import in any environment. Mirrors stateIdNormalized (solver.ts:195)
// after normalizeState (124-132): grade R=0/SR=1, level clamp, exp floored to a /100 bucket.
export type State = { grade: string; level: number; exp?: number };
export type Stock = { blue: number; purple: number; yellow: number };

export function encodeState(grade: string, level: number, exp = 0): number {
  const gradeId = grade === "SR" ? 1 : 0;
  let lv = Math.max(0, Math.floor(level));
  let ex = Math.max(0, Math.floor(exp));
  if (lv >= 15) {
    lv = 15;
    ex = 0;
  } else {
    lv = Math.min(14, lv);
  }
  return (gradeId * 16 + lv) * 30 + Math.floor(ex / 100);
}
