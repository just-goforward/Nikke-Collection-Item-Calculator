import { createHash } from "node:crypto";
import type { CertifiedSupplySnapshot } from "../shared/certifiedSupply.ts";
import type { CertifiedInput } from "../src/certified/types.ts";
import {
  add,
  type ExactQ,
  type GainOutcome,
  makeTriple,
  mapTriple,
  mul,
  type OracleEvent,
  type OracleInput,
  type QTriple,
  q,
  type Triple,
  wire,
} from "./certified-staging-oracle.ts";

export const VALIDATION_SEED = 0x9a_30_20_26;
export const MANDATORY_CASES = 2000;
export const FIXTURE_AS_OF = "2026-09-30T08:00:00.000Z";
const DAY_MS = 86_400_000;
export type ValidationCase = {
  id: string;
  semanticKey: string;
  input: CertifiedInput;
  oracle: OracleInput;
  future: readonly OracleEvent[];
  cohortWeights: QTriple;
  tags: readonly string[];
};
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}
export function fixtureDate(day: number): string {
  return new Date(Date.parse("2026-09-30T00:00:00.000Z") + day * DAY_MS).toISOString().slice(0, 10);
}
export function fixtureTimestamp(day: number): string {
  return new Date(
    Date.parse("2026-09-30T00:00:00.000Z") + day * DAY_MS - 4 * 60 * 60 * 1000,
  ).toISOString();
}
export function fixtureSnapshot(
  id: string,
  recurring: Triple,
  weekly: Triple,
  events: CertifiedSupplySnapshot["events"],
  laws: CertifiedSupplySnapshot["laws"],
): CertifiedSupplySnapshot {
  return {
    version: "certified-daily-v1",
    futureLawSemantics: "independent_given_cohort-v1",
    revision: `validation-${id}`,
    sourceHash: createHash("sha256").update(`independent-${id}`).digest("hex"),
    asOf: FIXTURE_AS_OF,
    sourceStatus: "healthy",
    rules: [
      {
        id: "validation-rule",
        effectiveFrom: "2023-01-01T00:00:00Z",
        effectiveUntil: null,
        dispatch: [{ lawId: `deterministic:${recurring.join(",")}`, count: 1 }],
        normalShop: [{ lawId: `deterministic:${weekly.join(",")}`, count: 1 }],
        collaborationShop: [],
        soloDays: [],
        provenance: ["independent bounded fixture; physical dispatch deliberately finite"],
      },
    ],
    laws,
    events,
    soloRounds: [],
    cadence: {
      version: "observed-mean-thursday-v1",
      numerator: 1197,
      denominator: 39,
      rounds: 40,
      intervals: 39,
      fromGameDate: "2023-05-11",
      untilGameDate: "2026-08-20",
      minimumDays: 21,
      maximumDays: 42,
      sourceStatuses: { as_announced: 35, rescheduled: 1, schedule_changed: 3, reconstructed: 1 },
      sourceUrls: [],
    },
    delayState: { anchorRound: 40, anchorGameDate: "2026-08-20", offsetDays: 0 },
    coverage: {
      from: fixtureTimestamp(-56),
      until: fixtureTimestamp(57),
      currentDay: fixtureDate(0),
      past: {
        from: fixtureTimestamp(-56),
        until: fixtureTimestamp(0),
        days: 56,
        complete: true,
        missing: [],
      },
      future: {
        from: fixtureTimestamp(1),
        until: fixtureTimestamp(57),
        days: 56,
        complete: true,
        missing: [],
      },
    },
    warnings: [],
    provenance: ["independent-validation-seeded-finite-v1"],
  };
}

const cohortChoices: QTriple[] = [
  [q(1), q(0), q(0)],
  [q(0), q(1), q(0)],
  [q(0), q(0), q(1)],
  [q(1, 3), q(1, 3), q(1, 3)],
  [q(1, 2), q(1, 3), q(1, 6)],
];
function fixtureState(index: number, next: () => number) {
  const stage = index % 31;
  const grade = stage < 16 ? ("R" as const) : ("SR" as const);
  const level = stage < 16 ? stage : stage - 16;
  const required = grade === "R" ? 1000 : 3000;
  const exp =
    level === 15
      ? 0
      : index % 4 === 0
        ? required - 100
        : index % 4 === 1
          ? 0
          : (next() % (required / 100)) * 100;
  const totalUses = index % 9;
  const blue = next() % (totalUses + 1);
  const purple = next() % (totalUses - blue + 1);
  const stock: Triple = [
    blue * 10 + (next() % 10),
    purple * 10 + (next() % 10),
    (totalUses - blue - purple) * 10 + (next() % 10),
  ];
  const recurring: Triple = [1 + (next() % 5), 1 + (next() % 5), 1 + (next() % 5)];
  const weekly: Triple = [next() % 7, next() % 7, next() % 7];
  const prices = mapTriple(stock, (pieces, color) =>
    q(7, pieces * 7 + recurring[color]! * 7 + weekly[color]!),
  );
  return { grade, level, exp, totalUses, stock, recurring, weekly, prices };
}
function cohortOutcomes(gain: Triple, probability: ExactQ, cohort: number): GainOutcome[] {
  const moved = mapTriple(gain, (_, candidate) => gain[(candidate + cohort) % 3]!);
  const chance = q(probability.n, probability.d * BigInt(cohort + 1));
  return [
    { stock: [0, 0, 0], probability: q(chance.d - chance.n, chance.d) },
    { stock: moved, probability: chance },
  ];
}
function fixtureFuture(index: number, next: () => number) {
  const eventCount = index % 3 === 0 ? 2 : 1;
  const future: OracleEvent[] = [];
  const events: CertifiedSupplySnapshot["events"][number][] = [];
  const laws: CertifiedSupplySnapshot["laws"][number][] = [];
  const randomFuture = index % 2 === 1;
  for (let eventIndex = 0; eventIndex < eventCount; eventIndex += 1) {
    const day = eventIndex === 1 ? 56 : [1, 2, 7, 55, 56][index % 5]!;
    const color = (index + eventIndex) % 3;
    const gain = makeTriple((candidate) =>
      candidate === color ? 10 : candidate === (color + 1) % 3 ? next() % 3 : 0,
    );
    const probability = [q(1, 2), q(1, 3), q(2, 5), q(4, 5)][index % 4]!;
    const outcomes: GainOutcome[] = randomFuture
      ? [
          { stock: [0, 0, 0], probability: q(probability.d - probability.n, probability.d) },
          { stock: gain, probability },
        ]
      : [{ stock: gain, probability: q(1) }];
    const cohortDependent = index % 4 === 3;
    const byCohort = cohortDependent
      ? makeTriple((cohort) => cohortOutcomes(gain, probability, cohort))
      : ([outcomes, outcomes, outcomes] as const);
    future.push({ day, byCohort });
    const id = `finite-${index}-${eventIndex}`;
    const toWire = (rows: readonly GainOutcome[]) =>
      rows.map((outcome) => ({ pieces: outcome.stock, mass: wire(outcome.probability) }));
    laws.push({
      id,
      kind: "finite",
      modelVersion: "independent-validation-v1",
      outcomes: toWire(outcomes),
      ...(cohortDependent ? { outcomesByCohort: mapTriple(byCohort, toWire) } : {}),
    });
    const kind = eventIndex ? "shop" : "dispatch";
    events.push({
      id: `${kind}:${fixtureDate(day)}`,
      gameDate: fixtureDate(day),
      at: fixtureTimestamp(day),
      kind,
      status: index % 7 === 0 ? "estimated" : "confirmed",
      refs: [{ lawId: id, count: 1 }],
      ruleId: "validation-rule",
    });
  }
  return { eventCount, future, events, laws, randomFuture };
}
function buildValidationCase(index: number, seed: number, next: () => number): ValidationCase {
  const { grade, level, exp, totalUses, stock, recurring, weekly, prices } = fixtureState(
    index,
    next,
  );
  const { eventCount, future, events, laws, randomFuture } = fixtureFuture(index, next);
  const cohortWeights = cohortChoices[index % cohortChoices.length]!;
  const semanticKey = JSON.stringify({
    grade,
    level,
    exp,
    stock,
    recurring,
    weekly,
    weights: cohortWeights.map(wire),
    future: future.map((event) => ({
      day: event.day,
      byCohort: event.byCohort.map((outcomes) =>
        outcomes.map((outcome) => ({
          stock: outcome.stock,
          probability: wire(outcome.probability),
        })),
      ),
    })),
  });
  const id = `seed-${seed.toString(16)}-${String(index).padStart(4, "0")}`;
  const snapshot = fixtureSnapshot(id, recurring, weekly, events, laws);
  const input: CertifiedInput = {
    grade,
    level,
    exp,
    stock,
    asOf: FIXTURE_AS_OF,
    snapshot,
    cohortWeights: mapTriple(cohortWeights, wire),
    computeWaiting: true,
    priceBasisStock: stock,
  };
  return {
    id,
    semanticKey,
    input,
    oracle: { grade, level, exp, stock, prices },
    future,
    cohortWeights,
    tags: [
      grade,
      `stage-${Math.min(2, Math.floor(level / 5))}`,
      `level-${level}`,
      `raw-remainders-${stock.map((pieces) => pieces % 10).join("-")}`,
      randomFuture ? "random-future" : "deterministic-future",
      index % 5 === 4 || eventCount === 2 ? "h56-event" : "interior-event",
      `cohort-${index % 5}`,
      totalUses === 0 ? "no-current-use" : "current-stock",
    ],
  };
}
export function generateValidationCases(
  count = MANDATORY_CASES,
  seed = VALIDATION_SEED,
): ValidationCase[] {
  const next = random(seed);
  const cases: ValidationCase[] = [];
  const keys = new Set<string>();
  while (cases.length < count) {
    const validationCase = buildValidationCase(cases.length, seed, next);
    if (keys.has(validationCase.semanticKey)) continue;
    keys.add(validationCase.semanticKey);
    cases.push(validationCase);
  }
  return cases;
}

export function expectedFixtureRate(validationCase: ValidationCase): QTriple {
  return mapTriple(
    validationCase.oracle.prices,
    (price, color): ExactQ => add(q(price.d, price.n), q(-validationCase.input.stock[color]!)),
  );
}
export function expectedFixtureConsumptionCost(pieces: Triple, prices: QTriple): ExactQ {
  return pieces.reduce((value, count, color) => add(value, mul(q(count), prices[color]!)), q(0));
}
