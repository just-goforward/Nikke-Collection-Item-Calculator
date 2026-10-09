import { DISPATCH_EXPECTED_PIECES } from "./certifiedDispatchExpectations.ts";
import { add, eq, fromWire, mul, ONE, type Q, q, type WireQ, ZERO } from "./certifiedRational.ts";

export type Triple = readonly [number, number, number];
export type DispatchCohort = 0 | 1 | 2;
export type CertifiedLawRef = { lawId: string; count: number };
export type ExactSupplyOutcome = { pieces: Triple; mass: Q };
export type CertifiedSupplyLaw = {
  id: string;
  kind: "dispatch" | "box" | "finite";
  modelVersion: string;
  outcomes?: readonly { pieces: Triple; mass: WireQ }[];
  outcomesByCohort?: readonly [
    readonly { pieces: Triple; mass: WireQ }[],
    readonly { pieces: Triple; mass: WireQ }[],
    readonly { pieces: Triple; mass: WireQ }[],
  ];
};
export type CertifiedLawOptions = {
  checkBudget?: () => void;
  laws?: readonly CertifiedSupplyLaw[];
};

export const CERTIFIED_PHYSICAL_LAW_VERSION = "documented-physical-supply-v1";
export const CERTIFIED_SUPPLY_LAWS: readonly CertifiedSupplyLaw[] = [
  { id: "dispatch-board-v1", kind: "dispatch", modelVersion: CERTIFIED_PHYSICAL_LAW_VERSION },
  { id: "regular-box-v1", kind: "box", modelVersion: CERTIFIED_PHYSICAL_LAW_VERSION },
  { id: "box-ii-v1", kind: "box", modelVersion: CERTIFIED_PHYSICAL_LAW_VERSION },
];

// Documented product probabilities; these are a model, not verified official odds.
export const BOX_LAWS = {
  regular: [
    { pieces: [3, 0, 0], mass: q(4, 5) },
    { pieces: [0, 1, 0], mass: q(1, 5) },
  ],
  boxII: [
    { pieces: [5, 0, 0], mass: q(7, 10) },
    { pieces: [0, 2, 0], mass: q(1, 5) },
    { pieces: [0, 0, 2], mass: q(1, 10) },
  ],
} as const satisfies Record<string, readonly ExactSupplyOutcome[]>;

type DispatchClass = {
  weight: number;
  keep: boolean;
  raw: readonly [number, number, number, number, number];
};
const dispatchClasses = [
  { weight: 15, keep: false, raw: [2, 0, 0, 0, 0] },
  { weight: 15, keep: false, raw: [3, 0, 0, 0, 0] },
  { weight: 6, keep: true, raw: [0, 2, 0, 0, 0] },
  { weight: 3, keep: true, raw: [0, 3, 0, 0, 0] },
  { weight: 4, keep: true, raw: [0, 0, 1, 0, 0] },
  { weight: 2, keep: true, raw: [0, 0, 2, 0, 0] },
  { weight: 15, keep: false, raw: [0, 0, 0, 1, 0] },
  { weight: 8, keep: true, raw: [0, 0, 0, 2, 0] },
  { weight: 8, keep: true, raw: [0, 0, 0, 0, 1] },
  { weight: 4, keep: true, raw: [0, 0, 0, 0, 2] },
  { weight: 3, keep: false, raw: [0, 0, 0, 0, 0] },
  { weight: 7, keep: false, raw: [0, 0, 0, 0, 0] },
  { weight: 7, keep: false, raw: [0, 0, 0, 0, 0] },
  { weight: 3, keep: false, raw: [0, 0, 0, 0, 0] },
] as const satisfies readonly DispatchClass[];
export const DISPATCH_CLASSES: readonly DispatchClass[] = dispatchClasses;
const dispatchIndices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] as const;
type DispatchCounts = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];
type BoardSize = 0 | 1 | 2 | 3 | 4;
type RawPieces = [number, number, number, number, number];
export type DispatchRaw = { raw: readonly [number, number, number, number, number]; mass: Q };
type Board<Counts extends number[] = DispatchCounts> = { counts: Counts; mass: Q };
const rawCache = new Map<DispatchCohort, readonly DispatchRaw[]>();
const distributionCache = new Map<string, readonly ExactSupplyOutcome[]>();
const expectedCache = new Map<DispatchCohort, readonly [Q, Q, Q]>(
  DISPATCH_EXPECTED_PIECES.map((gain, cohort) => [cohort as DispatchCohort, gain]),
);

function mergeBoard<Counts extends number[]>(
  map: Map<string, Board<Counts>>,
  counts: Counts,
  mass: Q,
) {
  const key = counts.join(",");
  const old = map.get(key);
  if (old) old.mass = add(old.mass, mass);
  else map.set(key, { counts, mass });
}

function drawPartialBoard(row: Board, nextBucket: Map<string, Board>) {
  let total = 0;
  for (const i of dispatchIndices) total += (4 - row.counts[i]) * dispatchClasses[i].weight;
  for (const i of dispatchIndices) {
    const klass = dispatchClasses[i];
    const available = 4 - row.counts[i];
    if (available === 0) continue;
    const counts: DispatchCounts = [...row.counts];
    counts[i] = counts[i] + 1;
    mergeBoard(nextBucket, counts, mul(row.mass, q(available * klass.weight, total)));
  }
}

function fillDispatchBoard(
  kept: Map<string, Board>,
  progress: { work: number; checkBudget: (() => void) | undefined },
) {
  const buckets = [
    new Map<string, Board>(),
    new Map<string, Board>(),
    new Map<string, Board>(),
    new Map<string, Board>(),
    new Map<string, Board>(),
  ] as const;
  const nextBuckets = [buckets[1], buckets[2], buckets[3], buckets[4]] as const;
  for (const row of kept.values()) {
    // Keeping can only reduce a four-slot board; filling adds one slot at a time.
    const size = row.counts.reduce((a, b) => a + b, 0) as BoardSize;
    mergeBoard(buckets[size], row.counts, row.mass);
  }
  for (const size of [0, 1, 2, 3] as const) {
    for (const row of buckets[size].values()) {
      if ((progress.work++ & 127) === 0) progress.checkBudget?.();
      drawPartialBoard(row, nextBuckets[size]);
    }
  }
  return buckets[4];
}

function keptBoards(boards: Map<string, Board>) {
  const kept = new Map<string, Board>();
  for (const row of boards.values())
    mergeBoard(
      kept,
      // Mapping the fixed class indices preserves the fourteen-class count tuple.
      dispatchIndices.map((i) => (dispatchClasses[i].keep ? row.counts[i] : 0)) as DispatchCounts,
      row.mass,
    );
  return kept;
}

function boardRawPieces(row: Board): RawPieces {
  const gain: RawPieces = [0, 0, 0, 0, 0];
  for (const i of dispatchIndices) {
    const klass = dispatchClasses[i];
    for (const j of [0, 1, 2, 3, 4] as const) gain[j] = gain[j] + row.counts[i] * klass.raw[j];
  }
  return gain;
}

function finalDispatchRows(boards: Map<string, Board>): DispatchRaw[] {
  const raw = new Map<string, Board<RawPieces>>();
  for (const row of boards.values()) mergeBoard(raw, [...boardRawPieces(row)], row.mass);
  const rows = [...raw.values()].map(
    (row): DispatchRaw => ({
      raw: [row.counts[0], row.counts[1], row.counts[2], row.counts[3], row.counts[4]],
      mass: row.mass,
    }),
  );
  let total = ZERO;
  for (const row of rows) total = add(total, row.mass);
  if (!eq(total, ONE)) throw new Error("certified_dispatch_mass_not_one");
  return rows;
}

export function dispatchLaw(
  cohort: DispatchCohort,
  checkBudget?: () => void,
): readonly DispatchRaw[] {
  checkBudget?.();
  const cached = rawCache.get(cohort);
  if (cached) return cached;
  if (![0, 1, 2].includes(cohort)) throw new Error("certified_dispatch_cohort_invalid");
  let kept = new Map<string, Board>();
  mergeBoard(kept, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], ONE);
  const progress = { work: 0, checkBudget };
  for (let reroll = 0; reroll <= cohort; reroll += 1) {
    const boards = fillDispatchBoard(kept, progress);
    if (reroll < cohort) {
      kept = keptBoards(boards);
      continue;
    }
    const rows = finalDispatchRows(boards);
    rawCache.set(cohort, rows);
    return rows;
  }
  throw new Error("certified_dispatch_not_terminated");
}

function mergeOutcome(map: Map<string, ExactSupplyOutcome>, pieces: Triple, mass: Q) {
  const key = pieces.join(",");
  const old = map.get(key);
  if (old) old.mass = add(old.mass, mass);
  else {
    if (map.size >= 25000) throw new Error("certified_supply_support_limit");
    map.set(key, { pieces, mass });
  }
}

export function convolveCertifiedDistributions(
  a: readonly ExactSupplyOutcome[],
  b: readonly ExactSupplyOutcome[],
  checkBudget?: () => void,
): ExactSupplyOutcome[] {
  const map = new Map<string, ExactSupplyOutcome>();
  let work = 0;
  for (const x of a) {
    for (const y of b) {
      if ((work++ & 127) === 0) checkBudget?.();
      mergeOutcome(
        map,
        [x.pieces[0] + y.pieces[0], x.pieces[1] + y.pieces[1], x.pieces[2] + y.pieces[2]],
        mul(x.mass, y.mass),
      );
    }
  }
  return [...map.values()];
}

function boxDistribution(
  regular: number,
  boxII: number,
  checkBudget?: () => void,
): readonly ExactSupplyOutcome[] {
  const key = `boxes:${regular}:${boxII}`;
  const cached = distributionCache.get(key);
  if (cached) return cached;
  let rows: readonly ExactSupplyOutcome[] = [{ pieces: [0, 0, 0], mass: ONE }];
  for (let i = 0; i < regular; i += 1)
    rows = convolveCertifiedDistributions(rows, BOX_LAWS.regular, checkBudget);
  for (let i = 0; i < boxII; i += 1)
    rows = convolveCertifiedDistributions(rows, BOX_LAWS.boxII, checkBudget);
  distributionCache.set(key, rows);
  return rows;
}

function singleLaw(
  lawId: string,
  cohort: DispatchCohort,
  options: CertifiedLawOptions,
): readonly ExactSupplyOutcome[] {
  if (lawId === "regular-box-v1") return BOX_LAWS.regular;
  if (lawId === "box-ii-v1") return BOX_LAWS.boxII;
  const deterministic = /^deterministic:(\d+),(\d+),(\d+)$/.exec(lawId);
  if (deterministic) {
    const pieces: Triple = [
      Number(deterministic[1]),
      Number(deterministic[2]),
      Number(deterministic[3]),
    ];
    assertPieces(pieces);
    return [{ pieces, mass: ONE }];
  }
  if (lawId === "dispatch-board-v1") {
    const key = `dispatch:${cohort}`;
    const cached = distributionCache.get(key);
    if (cached) return cached;
    const map = new Map<string, ExactSupplyOutcome>();
    for (const board of dispatchLaw(cohort, options.checkBudget)) {
      options.checkBudget?.();
      for (const boxes of boxDistribution(board.raw[3], board.raw[4], options.checkBudget)) {
        mergeOutcome(
          map,
          [
            board.raw[0] + boxes.pieces[0],
            board.raw[1] + boxes.pieces[1],
            board.raw[2] + boxes.pieces[2],
          ],
          mul(board.mass, boxes.mass),
        );
      }
    }
    const rows = [...map.values()];
    distributionCache.set(key, rows);
    return rows;
  }
  const finite = options.laws?.find((law) => law.id === lawId);
  const outcomes = finite?.outcomesByCohort?.[cohort] ?? finite?.outcomes;
  if (finite?.kind !== "finite" || !outcomes?.length)
    throw new Error(`certified_law_unknown:${lawId}`);
  let total = ZERO;
  if (outcomes.length > 25000) throw new Error("certified_supply_support_limit");
  const rows = outcomes.map((row, index) => {
    if ((index & 127) === 0) options.checkBudget?.();
    assertPieces(row.pieces);
    const mass = fromWire(row.mass);
    if (mass.n < 0n) throw new Error("certified_law_negative_mass");
    total = add(total, mass);
    return { pieces: row.pieces, mass };
  });
  if (!eq(total, ONE)) throw new Error("certified_law_mass_not_one");
  return rows.filter((row) => row.mass.n !== 0n);
}

function assertPieces(pieces: Triple) {
  if (pieces.length !== 3 || pieces.some((n) => !Number.isSafeInteger(n) || n < 0))
    throw new Error("certified_law_raw_pieces_invalid");
}

export function getCertifiedLawDistribution(
  ref: CertifiedLawRef,
  cohort: DispatchCohort,
  options: CertifiedLawOptions = {},
): readonly ExactSupplyOutcome[] {
  options.checkBudget?.();
  if (!Number.isSafeInteger(ref.count) || ref.count < 0)
    throw new Error("certified_law_count_invalid");
  if (ref.lawId === "regular-box-v1") return boxDistribution(ref.count, 0, options.checkBudget);
  if (ref.lawId === "box-ii-v1") return boxDistribution(0, ref.count, options.checkBudget);
  let rows: readonly ExactSupplyOutcome[] = [{ pieces: [0, 0, 0], mass: ONE }];
  if (ref.count === 0) return rows;
  const one = singleLaw(ref.lawId, cohort, options);
  if (ref.count === 1) return one;
  for (let i = 0; i < ref.count; i += 1)
    rows = convolveCertifiedDistributions(rows, one, options.checkBudget);
  return rows;
}

function dispatchExpectedPieces(
  cohort: DispatchCohort,
  options: CertifiedLawOptions,
): readonly [Q, Q, Q] {
  options.checkBudget?.();
  const gain = expectedCache.get(cohort);
  if (!gain) throw new Error("certified_dispatch_cohort_invalid");
  return gain;
}

function finiteExpectedPieces(
  lawId: string,
  cohort: DispatchCohort,
  options: CertifiedLawOptions,
): readonly [Q, Q, Q] {
  const gain: [Q, Q, Q] = [ZERO, ZERO, ZERO];
  for (const row of singleLaw(lawId, cohort, options)) {
    for (const k of [0, 1, 2] as const) gain[k] = add(gain[k], mul(row.mass, q(row.pieces[k])));
  }
  return gain;
}

function singleExpectedPieces(
  lawId: string,
  cohort: DispatchCohort,
  options: CertifiedLawOptions,
): readonly [Q, Q, Q] {
  if (lawId === "regular-box-v1") return [q(12, 5), q(1, 5), ZERO];
  if (lawId === "box-ii-v1") return [q(7, 2), q(2, 5), q(1, 5)];
  if (lawId === "dispatch-board-v1") return dispatchExpectedPieces(cohort, options);
  return finiteExpectedPieces(lawId, cohort, options);
}

export function getCertifiedLawExpectedGain(
  ref: CertifiedLawRef,
  cohort: DispatchCohort,
  options: CertifiedLawOptions = {},
): readonly [Q, Q, Q] {
  options.checkBudget?.();
  if (!Number.isSafeInteger(ref.count) || ref.count < 0)
    throw new Error("certified_law_count_invalid");
  if (ref.count === 0) return [ZERO, ZERO, ZERO];
  const expected = singleExpectedPieces(ref.lawId, cohort, options);
  return [
    mul(expected[0], q(ref.count)),
    mul(expected[1], q(ref.count)),
    mul(expected[2], q(ref.count)),
  ];
}

/** Owned logical data bytes, excluding JS engine object/map overhead and discarded work tables. */
export function certifiedSupplyLawPayloadBytes(): number {
  const massBytes = (mass: Q) =>
    Math.ceil(mass.n.toString(2).replace("-", "").length / 8) +
    Math.ceil(mass.d.toString(2).length / 8);
  let bytes = 0;
  for (const rows of rawCache.values())
    for (const row of rows) bytes += 5 * 8 + massBytes(row.mass);
  for (const [key, rows] of distributionCache) {
    bytes += key.length * 2;
    for (const row of rows) bytes += 3 * 8 + massBytes(row.mass);
  }
  for (const gain of expectedCache.values()) for (const mass of gain) bytes += massBytes(mass);
  return bytes;
}
