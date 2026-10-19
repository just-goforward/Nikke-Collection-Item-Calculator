import fc from "fast-check";
import { expect, it } from "vitest";
import {
  assertCertifiedSupplySnapshot,
  buildCertifiedSupplySnapshot,
  viewCertifiedSupplySnapshot,
} from "./certifiedSupply";
import type { CertifiedSupplyBuildInput } from "./certifiedSupplyModel";
import { cloneJsonWith, isDeeplyFrozen } from "./certifiedSupplyModel";

const input: CertifiedSupplyBuildInput = {
  cadenceVersion: "observed-median-v2",
  asOf: "2026-10-18T12:00:00+09:00",
  revision: "median-test",
  sourceHash: "a".repeat(64),
  collaborationPeriods: [],
  soloPeriods: [
    {
      round: 41,
      effectiveFrom: "2026-09-24T12:00:00+09:00",
      effectiveUntil: "2026-10-01T04:59:59+09:00",
      scheduleStatus: "confirmed",
    },
    {
      round: 42,
      effectiveFrom: "2026-10-15T12:00:00+09:00",
      effectiveUntil: "2026-10-22T04:59:59+09:00",
      scheduleStatus: "confirmed",
    },
  ],
};

it("builds the calendar S43 prediction as validated certified supply", () => {
  const snapshot = buildCertifiedSupplySnapshot(input);
  expect(() => assertCertifiedSupplySnapshot(snapshot)).not.toThrow();
  expect(snapshot.cadence).toMatchObject({ version: "observed-median-v2", medianDays: 28 });
  expect(snapshot.soloRounds.find((round) => round.round === 43)?.segments?.[0]).toMatchObject({
    effectiveFrom: "2026-11-12T03:00:00.000Z",
    effectiveUntil: "2026-11-18T19:59:59.000Z",
  });
});

it("replaces a legacy weekly offset with a daily waiting shift", () => {
  const snapshot = buildCertifiedSupplySnapshot({
    ...input,
    asOf: "2026-11-13T05:00:00+09:00",
    delayState: { anchorRound: 42, anchorGameDate: "2026-10-15", offsetDays: 7 },
  });
  expect(snapshot.delayState.offsetDays).toBe(2);
  expect(snapshot.soloRounds.find((round) => round.round === 43)?.sourceIds).toContain("공지 대기");
  expect(() => assertCertifiedSupplySnapshot(snapshot)).not.toThrow();
});

it("keeps browser aging aligned with a fresh median prediction", () => {
  const asOf = "2026-11-13T05:00:00+09:00";
  const adopted = buildCertifiedSupplySnapshot(input);
  const before = JSON.stringify(adopted);
  const viewed = viewCertifiedSupplySnapshot(adopted, asOf);
  expect(JSON.stringify(adopted)).toBe(before);
  expect(viewCertifiedSupplySnapshot(viewed, asOf)).toEqual(viewed);
  const fresh = buildCertifiedSupplySnapshot({ ...input, asOf });
  expect(viewed.soloRounds.find((round) => round.round === 43)).toEqual(
    fresh.soloRounds.find((round) => round.round === 43),
  );
});

it("reuses aged predictions only where the result is byte-identical to a fresh view", () => {
  // Oracle: an unfrozen copy never takes the reuse path, so it ages from scratch.
  for (const build of [
    input,
    {
      ...input,
      asOf: "2026-11-13T05:00:00+09:00",
      delayState: { anchorRound: 42, anchorGameDate: "2026-10-15", offsetDays: 7 },
    },
  ]) {
    const adopted = buildCertifiedSupplySnapshot(build);
    expect(isDeeplyFrozen(adopted)).toBe(true);
    const start = Date.parse("2026-10-18T03:00:00Z");
    const views = new Set<string>();
    for (let hour = 0; hour < 24 * 90; hour += 7) {
      for (const asOf of [start + hour * 3_600_000, start + hour * 3_600_000 + 1_999_000]) {
        const at = new Date(asOf).toISOString();
        const reused = JSON.stringify(viewCertifiedSupplySnapshot(adopted, at));
        expect(JSON.stringify(viewCertifiedSupplySnapshot(adopted, at))).toBe(reused);
        expect(JSON.stringify(viewCertifiedSupplySnapshot(structuredClone(adopted), at))).toBe(
          reused,
        );
        views.add(reused);
      }
    }
    expect(views.size).toBeGreaterThan(60);
  }
});

it("clones JSON graphs exactly like a stringify/parse round trip", () => {
  const replacer = (key: string, value: unknown) => {
    if (key === "sourceIds") return ["replaced", key];
    if (typeof value === "string" && /^(at|gameDate)$/.test(key)) return `${value}!`;
    if (key === "drop") return undefined;
    return value;
  };
  const roundTrip = (value: unknown) => {
    const text = JSON.stringify(value, replacer);
    return text === undefined ? undefined : JSON.parse(text);
  };
  fc.assert(
    fc.property(
      fc.jsonValue().chain((json) =>
        fc
          .array(fc.constantFrom("at", "gameDate", "sourceIds", "drop", "__proto__", "x", "0"), {
            maxLength: 4,
          })
          .map((keys) =>
            keys.reduce<unknown>(
              (value, key, index) =>
                JSON.parse(
                  `{${JSON.stringify(key)}:${JSON.stringify(value) ?? "null"},"i":${index}}`,
                ),
              json,
            ),
          ),
      ),
      (value) => {
        const copy = cloneJsonWith(value, replacer);
        expect(JSON.stringify(copy)).toBe(JSON.stringify(roundTrip(value)));
        expect(copy).toStrictEqual(roundTrip(value));
      },
    ),
    { numRuns: 500 },
  );
  for (const odd of [
    -0,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    { a: undefined, b: () => 1, c: Symbol("s"), d: [undefined, () => 1, -0, 1e21] },
    { at: new Date(0), nested: { toJSON: () => "x" } },
    Object.assign(Object.create(null), { at: "2026-10-18" }),
    Object.assign(new Array<number>(3), { 0: 1, 2: 3 }),
    undefined,
  ])
    expect(JSON.stringify(cloneJsonWith(odd, replacer))).toBe(JSON.stringify(roundTrip(odd)));
  // Review counterexamples: `toJSON` (also on arrays) applies before a value-mapping replacer.
  const mapping = (key: string, value: unknown) =>
    key === "x" || key === "d" || key === "at"
      ? typeof value === "string"
        ? `${value}!`
        : { mapped: true }
      : value;
  for (const odd of [
    Object.assign([1, 2], { toJSON: () => ["different"] }),
    { x: { toJSON: () => "date" } },
    { d: new Date(0) },
    { at: { toJSON: () => "s" } },
    [new String("boxed"), new Number(1)],
    { x: Object.assign(() => 1, { toJSON: () => "serialized" }) },
  ])
    expect(JSON.stringify(cloneJsonWith(odd, mapping))).toBe(JSON.stringify(odd, mapping));
});

it("shares aged predictions between equal waiting states and survives eviction", () => {
  const adopted = buildCertifiedSupplySnapshot(input);
  const round43 = (asOf: string, snapshot = adopted) =>
    viewCertifiedSupplySnapshot(snapshot, asOf).soloRounds.find((round) => round.round === 43);
  // Same waiting state (before the predicted start): one shared aged copy.
  expect(round43("2026-10-19T12:00:00+09:00")).toBe(round43("2026-10-20T12:00:00+09:00"));
  // Without the frozen identity proof nothing is shared.
  expect(round43("2026-10-19T12:00:00+09:00", structuredClone(adopted))).not.toBe(
    round43("2026-10-19T12:00:00+09:00", structuredClone(adopted)),
  );
  // More than 128 distinct waiting states, then the first one again.
  const first = "2026-11-13T12:00:00+09:00";
  const expected = JSON.stringify(viewCertifiedSupplySnapshot(structuredClone(adopted), first));
  expect(JSON.stringify(viewCertifiedSupplySnapshot(adopted, first))).toBe(expected);
  for (let day = 1; day <= 140; day++)
    viewCertifiedSupplySnapshot(
      adopted,
      new Date(Date.parse(first) + day * 86_400_000).toISOString(),
    );
  expect(JSON.stringify(viewCertifiedSupplySnapshot(adopted, first))).toBe(expected);
});

it("uses the confirmed interrupted initial segment duration", () => {
  const snapshot = buildCertifiedSupplySnapshot({
    ...input,
    soloPeriods: input.soloPeriods.slice(0, 1),
    soloRounds: [
      {
        round: 42,
        segments: [
          {
            segment: 1,
            kind: "initial",
            effectiveFrom: "2026-10-15T12:00:00+09:00",
            effectiveUntil: "2026-10-15T17:00:00+09:00",
            rewardFromGameDate: "2026-10-15",
            rewardUntilGameDate: "2026-10-16",
            sourceIds: ["confirmed-interruption"],
          },
        ],
      },
    ],
  });
  expect(
    snapshot.soloRounds.find((round) => round.round === 43)?.segments?.[0]?.effectiveUntil,
  ).toBe("2026-11-12T08:00:00.000Z");
});
