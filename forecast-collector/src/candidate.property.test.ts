import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  assertProperty,
  expectDefectProperty,
  type PropertyIdentity,
} from "../../shared/propertyHarness.ts";
import { buildForecastCandidate, type ResolvedSchedule, resolveSoloSchedule } from "./candidate";
import generatorSource from "./candidate.property.test.ts?raw";
import candidateSource from "./candidate.ts?raw";
import type { NormalizedSourceItem, ScheduleEvent, XProbeResult } from "./types";

/* S1/P8. Expectations are metamorphic (input order and repeated identical evidence
 * must not change candidateId) or plain characterization of observed behavior;
 * none is recomputed with the candidate code. Time is frozen by the injected
 * nowMs, from which buildForecastCandidate derives gameDayStart. */

const IDENTITY: PropertyIdentity = {
  file: "forecast-collector/src/candidate.property.test.ts",
  generatorSource,
  sources: { "forecast-collector/src/candidate.ts": candidateSource },
};
const NUM_RUNS = 100;
const TIME_LIMIT_MS = 15_000;
const HARD_DEADLINE_MS = 25_000;
const NOW_MS = Date.parse("2026-08-24T00:00:00Z");

const soloItem: NormalizedSourceItem = {
  source: "naver-board-56",
  itemId: "8060044",
  url: "https://game.naver.com/lounge/nikke/board/detail/8060044",
  title: "8월 솔로 레이드",
  excerpt: "솔로 레이드 8월 20일 12:00 ~ 8월 27일 4:59",
  normalizedText: "솔로 레이드 8월 20일 12:00 ~ 8월 27일 4:59",
  publishedAt: "2026-08-18T03:00:00.000Z",
  contentHash: "a".repeat(64),
  structured: true,
  official: true,
};
const soloEvent: ScheduleEvent = {
  eventId: "naver-board-56:8060044:solo",
  eventType: "solo",
  sourceItem: soloItem,
  startsAt: "2026-08-20T03:00:00.000Z",
  endsAt: "2026-08-26T19:59:00.000Z",
  scheduleStatus: "confirmed",
  manualReview: false,
  reason: null,
};
function resolved(): ResolvedSchedule {
  const value = resolveSoloSchedule([soloEvent], NOW_MS);
  if (!value) throw new Error("expected a resolved schedule");
  return value;
}

const HEX = "0123456789abcdef";
const hash = (seed: number) => HEX.charAt((seed % 15) + 1).repeat(64);
type ItemSpec = { board: 48 | 56; id: number; hashSeed: number };
function item(spec: ItemSpec): NormalizedSourceItem {
  const itemId = String(9_000_000 + spec.id);
  return {
    source: spec.board === 48 ? "naver-board-48" : "naver-board-56",
    itemId,
    url: `https://game.naver.com/lounge/nikke/board/detail/${itemId}`,
    title: `콜라보 이벤트 ${itemId}`,
    excerpt: `콜라보 이벤트 ${itemId} variant ${spec.hashSeed}`,
    normalizedText: `콜라보 이벤트 ${itemId}`,
    publishedAt: "2026-08-19T03:00:00.000Z",
    contentHash: hash(spec.hashSeed),
    structured: true,
    official: true,
  };
}
type Period = { startDay: number; days: number };
function collaboration(source: NormalizedSourceItem, period: Period, index: number): ScheduleEvent {
  const start = Date.parse("2026-08-21T03:00:00.000Z") + period.startDay * 86_400_000;
  return {
    eventId: `${source.source}:${source.itemId}:collaboration:${index}`,
    eventType: "collaboration",
    sourceItem: source,
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + period.days * 86_400_000 - 60_000).toISOString(),
    scheduleStatus: "confirmed",
    manualReview: false,
    reason: null,
  };
}
const unavailable: XProbeResult = { status: "x_unavailable", sourceItem: null, reason: "test" };
async function build(events: readonly ScheduleEvent[], xProbe: XProbeResult = unavailable) {
  return await buildForecastCandidate(resolved(), events, xProbe, NOW_MS, 1);
}
/** Stable permutation of `values` by generated sort keys (ties keep index order). */
function permute<T>(values: readonly T[], keys: readonly number[]): T[] {
  return values
    .map((value, index) => ({ value, key: keys[index % keys.length] ?? 0, index }))
    .sort((left, right) => left.key - right.key || left.index - right.index)
    .map(({ value }) => value);
}

const PERIOD: Period = { startDay: 0, days: 7 };
const periodArbitrary = fc.record({
  startDay: fc.integer({ min: 0, max: 10 }),
  days: fc.integer({ min: 1, max: 14 }),
});
const keysArbitrary = fc.array(fc.nat({ max: 1000 }), { minLength: 12, maxLength: 12 });
/** Distinct (source,itemId) pool; IDs are unique by construction, not by filtering. */
const poolArbitrary = fc
  .uniqueArray(fc.integer({ min: 1, max: 50 }), { minLength: 1, maxLength: 4 })
  .chain((ids) =>
    fc.tuple(
      ...ids.map((id) =>
        fc.record({
          board: fc.constantFrom<48 | 56>(48, 56),
          id: fc.constant(id),
          hashSeed: fc.nat({ max: 14 }),
        }),
      ),
    ),
  );

describe("P8 candidateId duplicate-evidence behavior", () => {
  it("CURRENT BEHAVIOR (policy pending): a conflicting duplicate keeps the first key position and the last payload", async () => {
    const first = item({ board: 48, id: 7, hashSeed: 1 });
    const second = item({ board: 48, id: 7, hashSeed: 2 });
    const forward = await build([
      collaboration(first, PERIOD, 0),
      collaboration(second, PERIOD, 1),
    ]);
    const backward = await build([
      collaboration(second, PERIOD, 1),
      collaboration(first, PERIOD, 0),
    ]);
    const key = (evidence: { source: string; itemId: string }) =>
      `${evidence.source}:${evidence.itemId}`;
    const forwardDuplicate = forward.candidate.sourceEvidence.filter(
      (evidence) => key(evidence) === "naver-board-48:9000007",
    );
    const backwardDuplicate = backward.candidate.sourceEvidence.filter(
      (evidence) => key(evidence) === "naver-board-48:9000007",
    );
    expect(forwardDuplicate.map((evidence) => evidence.contentHash)).toEqual([second.contentHash]);
    expect(backwardDuplicate.map((evidence) => evidence.contentHash)).toEqual([first.contentHash]);
    // Observed: the identity therefore depends on input order for conflicting duplicates.
    expect(forward.candidate.candidateId).not.toBe(backward.candidate.candidateId);
  });

  it(
    "identical duplicates collapse to one evidence item and candidateId ignores order",
    async () => {
      await assertProperty(
        fc.asyncProperty(
          poolArbitrary,
          fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 4, maxLength: 4 }),
          keysArbitrary,
          fc.option(fc.nat({ max: 3 }), { nil: undefined }),
          async (pool, multiplicity, keys, xIndex) => {
            const items = pool.map(item);
            const once = items.map((source, index) => collaboration(source, PERIOD, index));
            const repeated = items.flatMap((source, index) =>
              Array.from({ length: multiplicity[index] ?? 1 }, (_, copy) =>
                collaboration(source, PERIOD, index * 10 + copy),
              ),
            );
            const xItem = xIndex === undefined ? undefined : items[xIndex % items.length];
            const xProbe: XProbeResult = xItem
              ? { status: "crosschecked", sourceItem: xItem, reason: null }
              : unavailable;
            const base = await build(once);
            const shuffled = await build(permute(repeated, keys), xProbe);
            const keysSeen = shuffled.candidate.sourceEvidence.map(
              (evidence) => `${evidence.source}:${evidence.itemId}`,
            );
            const xSame = await build(once, xProbe);
            return (
              new Set(keysSeen).size === keysSeen.length &&
              items.every((source) => keysSeen.includes(`${source.source}:${source.itemId}`)) &&
              shuffled.candidate.candidateId === xSame.candidate.candidateId &&
              (xItem !== undefined || shuffled.candidate.candidateId === base.candidate.candidateId)
            );
          },
        ),
        { name: "P8.identical", numRuns: NUM_RUNS, timeLimitMs: TIME_LIMIT_MS, identity: IDENTITY },
      );
    },
    HARD_DEADLINE_MS,
  );

  // collaborationPeriods enter the identity in input order (uniquePeriod keeps the
  // first occurrence, nothing sorts them); loadScheduleEvents orders only by start,
  // so equal-start rows have no defined order. Reported, not fixed here.
  it.fails(
    "DEFECT-P8-02 candidateId ignores the order of collaboration events with distinct periods",
    async () => {
      await expectDefectProperty(
        fc.asyncProperty(
          poolArbitrary,
          fc.array(periodArbitrary, { minLength: 4, maxLength: 4 }),
          keysArbitrary,
          async (pool, periods, keys) => {
            const events = pool.map((spec, index) =>
              collaboration(item(spec), periods[index] ?? PERIOD, index),
            );
            const forward = await build(events);
            const shuffled = await build(permute(events, keys));
            return forward.candidate.candidateId === shuffled.candidate.candidateId;
          },
        ),
        { name: "P8.periods", numRuns: NUM_RUNS, timeLimitMs: TIME_LIMIT_MS, identity: IDENTITY },
      );
    },
    HARD_DEADLINE_MS,
  );

  // Shrunk witness of P8.periods (seed 20260720): equal start, 1-day vs 2-day period.
  it.fails("DEFECT-P8-02 witness: two equal-start periods in either order", async () => {
    const one = collaboration(item({ board: 48, id: 1, hashSeed: 0 }), { startDay: 0, days: 1 }, 0);
    const two = collaboration(item({ board: 48, id: 2, hashSeed: 0 }), { startDay: 0, days: 2 }, 1);
    const forward = await build([one, two]);
    const backward = await build([two, one]);
    expect(backward.candidate.candidateId).toBe(forward.candidate.candidateId);
  });

  // Shrunk witness of P8.conflicting (seed 20260720): one key, hashes "1…" and "2…".
  it.fails("PENDING-P8-CONFLICT witness: one key with two content hashes in either order", async () => {
    const first = collaboration(item({ board: 48, id: 1, hashSeed: 0 }), PERIOD, 0);
    const second = collaboration(item({ board: 48, id: 1, hashSeed: 1 }), PERIOD, 1);
    const forward = await build([first, second]);
    const backward = await build([second, first]);
    expect(backward.candidate.candidateId).toBe(forward.candidate.candidateId);
  });

  it.fails(
    "PENDING-P8-CONFLICT candidateId ignores order of conflicting duplicates (policy undecided)",
    async () => {
      await expectDefectProperty(
        fc.asyncProperty(
          poolArbitrary,
          fc.nat({ max: 3 }),
          fc.integer({ min: 1, max: 14 }),
          keysArbitrary,
          async (pool, which, delta, keys) => {
            const items = pool.map(item);
            const target = pool[which % pool.length];
            if (!target) throw new Error("pool_index_out_of_range");
            // Same (source,itemId), different contentHash: constructive, never equal.
            const variant = item({ ...target, hashSeed: (target.hashSeed + delta) % 15 });
            const events = [...items, variant].map((source, index) =>
              collaboration(source, PERIOD, index),
            );
            const forward = await build(events);
            const shuffled = await build(permute(events, keys));
            return forward.candidate.candidateId === shuffled.candidate.candidateId;
          },
        ),
        {
          name: "P8.conflicting",
          numRuns: NUM_RUNS,
          timeLimitMs: TIME_LIMIT_MS,
          identity: IDENTITY,
        },
      );
    },
    HARD_DEADLINE_MS,
  );
});
