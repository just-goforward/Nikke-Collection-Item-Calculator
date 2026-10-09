// Selectively re-derived from Claude certified-boundary-v1 rules/game.ts and the
// product shared/game.ts. The whole graph is forward; R15 freely becomes SR5.
export const TERMINAL = 600;
export type Units = [number, number, number];
export const KIT_INDICES = [0, 1, 2] as const;
export type KitIndex = (typeof KIT_INDICES)[number];
type Indices<N extends number, Seen extends number[] = []> = Seen["length"] extends N
  ? Seen[number]
  : Indices<N, [...Seen, Seen["length"]]>;
export type StateId = Indices<601>;
export type StateValues<T> = Record<StateId, T>;
type Level = Indices<15>;
type Edge = readonly [perMille: number, great: number, normal: number];
const EXP = [200, 500, 1000] as const;
const GREAT = [
  [
    [176, 208, 240, 272, 400, 160, 192, 224, 272, 400, 144, 176, 224, 272, 400],
    [550, 650, 750, 850, 1000, 500, 600, 700, 850, 1000, 450, 550, 700, 850, 1000],
    [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000],
  ],
  [
    [36, 59, 78, 113, 150, 22, 33, 49, 76, 125, 12, 22, 31, 47, 100],
    [110, 198, 287, 413, 550, 80, 120, 180, 280, 500, 54, 99, 144, 216, 450],
    [250, 400, 550, 750, 1000, 200, 300, 450, 700, 1000, 150, 275, 400, 600, 1000],
  ],
] as const;

export function encode(grade: "R" | "SR", level: number, exp: number): number {
  if (level === 15) return grade === "SR" ? TERMINAL : 300;
  return grade === "R" ? level * 10 + exp / 100 : 150 + level * 30 + exp / 100;
}
export function decode(sid: number): { grade: 0 | 1; level: number; exp: number } {
  if (sid === TERMINAL) return { grade: 1, level: 15, exp: 0 };
  return sid < 150
    ? { grade: 0, level: Math.floor(sid / 10), exp: (sid % 10) * 100 }
    : { grade: 1, level: Math.floor((sid - 150) / 30), exp: ((sid - 150) % 30) * 100 };
}
const graph: (readonly [Edge, Edge, Edge])[] = [];
export const CAPS = Array.from<unknown, Units>({ length: TERMINAL + 1 }, () => [
  0, 0, 0,
]) as Units[] & StateValues<Units>;
for (let s = 0; s < TERMINAL; s++) {
  const { grade, level, exp } = decode(s);
  const g = grade === 1 ? "SR" : "R";
  const great = encode(g, (Math.floor(level / 5) + 1) * 5, 0);
  const transition = (k: KitIndex): Edge => {
    let e = exp + EXP[k];
    let l = level;
    const required = grade === 1 ? 3000 : 1000;
    while (e >= required && l < 15) {
      e -= required;
      l++;
      if (l % 5 === 0) {
        e = 0;
        break;
      }
    }
    const probability = GREAT[grade][k][level as Level];
    return [probability, great, encode(g, l, e)];
  };
  graph.push([transition(0), transition(1), transition(2)]);
}
graph.push([
  [0, TERMINAL, TERMINAL],
  [0, TERMINAL, TERMINAL],
  [0, TERMINAL, TERMINAL],
]);
// Construction initializes every sid 0..600. StateId casts below express the
// validated/decoded model domain without adding a new invalid-index error path.
export const EDGES = graph as (readonly [Edge, Edge, Edge])[] &
  StateValues<readonly [Edge, Edge, Edge]>;
/** Every feasible first kit has a positive all-great continuation whenever
 * remaining uses reach minPositiveUses. The singleton primary-mask shortcut
 * relies on this fixed-model precondition to exclude the zero-P STOP tie. */
export function assertPositiveGreatProbabilities(): void {
  for (let sid = 0; sid < TERMINAL; sid++) {
    for (const [p] of EDGES[sid as StateId]) {
      if (!Number.isInteger(p) || p <= 0 || p > 1000)
        throw new Error("certified_game_great_probability_invariant");
    }
  }
}
assertPositiveGreatProbabilities();
for (let s = TERMINAL - 1; s >= 0; s--) {
  const caps = CAPS[s as StateId];
  for (const k of KIT_INDICES) {
    const [p, g, n] = EDGES[s as StateId][k];
    for (const [mass, t] of [
      [p, g],
      [1000 - p, n],
    ] as const) {
      if (mass === 0) continue;
      if (t <= s) throw new Error("certified_game_not_acyclic");
      const childCaps = CAPS[t as StateId];
      for (const j of KIT_INDICES) caps[j] = Math.max(caps[j], childCaps[j] + (k === j ? 1 : 0));
    }
  }
}
export function capUnits(sid: number, raw: readonly number[]): Units {
  const caps = CAPS[sid as StateId];
  return [
    Math.min(caps[0], Math.floor(raw[0]! / 10)),
    Math.min(caps[1], Math.floor(raw[1]! / 10)),
    Math.min(caps[2], Math.floor(raw[2]! / 10)),
  ];
}
export function minPositiveUses(sid: number): number {
  if (sid === TERMINAL) return 0;
  const { grade, level } = decode(sid);
  return Math.ceil((15 - level) / 5) + (grade === 0 ? 2 : 0);
}
