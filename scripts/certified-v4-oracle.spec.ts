import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import { buildForecastCandidate, resolveSoloSchedule } from "../forecast-collector/src/candidate";
import { parseScheduleEvents } from "../forecast-collector/src/naver";
import { parseNoticeDetail } from "../forecast-collector/src/notice";
import type { NormalizedSourceItem, ScheduleEvent } from "../forecast-collector/src/types";
import type { WireQ } from "../shared/certifiedRational";
import {
  type CertifiedSupplyEvent,
  type CertifiedSupplySnapshot,
  certifiedRecurringRate,
  deriveCertifiedDailySupply,
  isCertifiedEventClaimable,
  viewCertifiedSupplySnapshot,
} from "../shared/certifiedSupply";
import type {
  SupplyForecastCandidate,
  SupplyForecastGrant,
} from "../shared/supplyForecastCandidate";
import type { CertifiedInput, CertifiedOutput } from "../src/certified/types";
import { loadCertifiedWasm } from "../src/certified/wasmBackend";
import { solveCertifiedWasm } from "../src/certified/wasmSolver";

/*
 * Independent end-to-end oracle for the v4 forecast path (certified-daily-v4, payload 5):
 * captured Naver notices -> collector schedule/grant parsing and D1 settlement (local SQLite)
 * -> collector candidate builder -> shared snapshot builder -> Rust/WASM certified solver.
 *
 * Every expected value below is written by hand from the notices and documented rules, never
 * copied from a product output:
 * - 7833931 (published 2026-06-23 00:47 KST): r38 stops at 6/23(화) 4:59:59; compensation
 *   includes 관리 키트 상자 II * 56 and 관리 키트 상자 * 16, 보상 지급일 6/23(화), no 수령 기한.
 * - 7837735 (2026-06-23 20:51 KST): reopen 7/3(금) 12:00 ~ 7/8(수) 4:59 and a "6/23(화) 지급
 *   보상 안내" restating the same kits ("이전 공지에서 약속드린 보상 ... 오늘 중 지급").
 * - 7877359 (2026-07-03 12:00 KST): 시즌 38 재오픈, 진행 기간 7/3(금) 12:00 ~ 7/8(수) 4:59.
 * - The original r38 announcement is the same season-38 input used by
 *   forecast-collector/src/solo-interruptions.spec.ts (6/18 12:00 KST start).
 * - Game days start at 05:00 KST (= 20:00Z of the previous UTC date). 2026-06-18 is a Thursday,
 *   so Tuesdays (normal shop: 관리 키트 상자 II * 5) are 6/16, 6/23, 6/30, 7/7 and Wednesdays
 *   (weekly fixed 10 blue + 10 purple pieces, claimable for six days) are 6/17, 6/24, 7/1, 7/8.
 * - Solo daily rewards (docs/research/kit-expected-gain.ko.md, solo28 = 상자 * 16 + 상자 II * 68
 *   per seven-day round): day 1 상자 * 12, day 2 상자 * 4 + 상자 II * 8, days 3-7 상자 II * 12.
 *   Each r38 segment covers five game days: 6/18-6/22 and 7/3-7/7 (6/23 and 7/8 have no reward).
 * - Box expectations come from the documented box contents in the same research note:
 *   상자 = 3 blue (4/5) | 1 purple (1/5); 상자 II = 5 blue (7/10) | 2 purple (1/5) | 2 yellow (1/10).
 * - Solver values come from the SR level-14 great-success table (blue 100‰, yellow 1000‰, each
 *   use consumes 10 pieces; a great success at SR14 reaches SR15).
 */

const ROOT = new URL("../", import.meta.url);
const GRANT_ID = "grant:naver-board-11:7833931:2026-06-23:1";
const GRANT_SOURCE = "https://game.naver.com/lounge/nikke/board/detail/7833931";
// 2026-06-23 21:00 KST: after both 7833931 and 7837735 were published on game day 6/23.
const JUNE_23 = "2026-06-23T12:00:00.000Z";
// 2026-06-24 09:00 KST: the next game day.
const JUNE_24 = "2026-06-24T00:00:00.000Z";
// 2026-07-03 13:00 KST: one hour after the reopen.
const JULY_3 = "2026-07-03T04:00:00.000Z";

// Collector grant settlement is typed against Cloudflare D1 globals, which the root TypeScript
// program stubs (scripts/forecast-action-globals.d.ts). Load those two collector modules through a
// runtime specifier; forecast-collector/tsconfig.json typechecks them against the real D1 types.
type GrantPlan = {
  grants: SupplyForecastGrant[];
  statements: object[];
  judgments: { verdict: string; reason: string | null }[];
};
type CollectorDb = object & { batch(statements: object[]): Promise<unknown> };
type GrantModule = {
  planGrants(db: CollectorDb, item: NormalizedSourceItem, firstIndex: number): Promise<GrantPlan>;
  loadGrants(db: CollectorDb): Promise<SupplyForecastGrant[]>;
};
type RuntimeDbModule = { runtimeTestDb(database: DatabaseSync): CollectorDb };
const collectorModule = (name: string) => `../forecast-collector/src/${name}.ts`;

// ---- Minimal independent exact rationals (BigInt) ----
type Fraction = { n: bigint; d: bigint };
function gcd(a: bigint, b: bigint): bigint {
  let [x, y] = [a < 0n ? -a : a, b];
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}
function frac(n: bigint, d = 1n): Fraction {
  if (d === 0n) throw new Error("zero_denominator");
  if (d < 0n) [n, d] = [-n, -d];
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}
const plus = (a: Fraction, b: Fraction) => frac(a.n * b.d + b.n * a.d, a.d * b.d);
const minus = (a: Fraction, b: Fraction) => frac(a.n * b.d - b.n * a.d, a.d * b.d);
const times = (a: Fraction, b: Fraction) => frac(a.n * b.n, a.d * b.d);
const text = (a: Fraction) => `${a.n}/${a.d}`;
const fromWireQ = (value: WireQ) => frac(BigInt(value.numerator), BigInt(value.denominator));
const wire = (n: number, d = 1) => ({ numerator: String(n), denominator: String(d) });
type Box = readonly { pieces: readonly [number, number, number]; mass: Fraction }[];
const REGULAR_BOX: Box = [
  { pieces: [3, 0, 0], mass: frac(4n, 5n) },
  { pieces: [0, 1, 0], mass: frac(1n, 5n) },
];
const BOX_II: Box = [
  { pieces: [5, 0, 0], mass: frac(7n, 10n) },
  { pieces: [0, 2, 0], mass: frac(1n, 5n) },
  { pieces: [0, 0, 2], mass: frac(1n, 10n) },
];
function boxesExpectation(boxes: readonly [Box, number][]): Fraction[] {
  const total = [frac(0n), frac(0n), frac(0n)];
  for (const [box, count] of boxes)
    for (const { pieces, mass } of box)
      for (const k of [0, 1, 2] as const)
        total[k] = plus(total[k] as Fraction, times(frac(BigInt(pieces[k] * count)), mass));
  return total;
}

// ---- Collector inputs from captured notices ----
async function notice(id: number): Promise<NormalizedSourceItem> {
  const payload = JSON.parse(
    readFileSync(new URL(`forecast-collector/fixtures/naver-detail-${id}.json`, ROOT), "utf8"),
  );
  const item = await parseNoticeDetail(payload, payload.content.board.boardId, String(id));
  if (!item) throw new Error(`fixture_${id}_missing`);
  return item;
}
function originalRound38(source: NormalizedSourceItem): ScheduleEvent {
  return {
    eventId: "initial-r38",
    eventType: "solo",
    sourceItem: { ...source, itemId: "initial", title: "솔로 레이드 - 애니힐리오" },
    startsAt: "2026-06-18T03:00:00.000Z",
    endsAt: "2026-06-24T19:59:00.000Z",
    scheduleStatus: "confirmed",
    manualReview: false,
    reason: null,
  };
}
async function candidateAt(
  events: readonly ScheduleEvent[],
  now: string,
  grants: readonly SupplyForecastGrant[],
): Promise<SupplyForecastCandidate> {
  const nowMs = Date.parse(now);
  const resolved = resolveSoloSchedule(events, nowMs);
  if (!resolved) throw new Error("round_38_unresolved");
  const built = await buildForecastCandidate(
    resolved,
    events,
    { status: "x_unavailable", sourceItem: null, reason: null },
    nowMs,
    1,
    grants,
  );
  return built.candidate;
}
function snapshotOf(candidate: SupplyForecastCandidate): CertifiedSupplySnapshot {
  if (!candidate.certifiedSnapshot) throw new Error("snapshot_missing");
  return candidate.certifiedSnapshot;
}

// ---- Projections used only to compare against literal expectations ----
function kitCounts(refs: CertifiedSupplyEvent["refs"]) {
  const counts = { regular: 0, boxII: 0, dispatch: 0, weekly: 0, other: 0 };
  for (const ref of refs) {
    if (ref.lawId === "regular-box-v1") counts.regular += ref.count;
    else if (ref.lawId === "box-ii-v1") counts.boxII += ref.count;
    else if (ref.lawId === "dispatch-board-v1") counts.dispatch += ref.count;
    else if (ref.lawId === "deterministic:10,10,0") counts.weekly += ref.count;
    else counts.other += ref.count;
  }
  return counts;
}
function day(offset: number, from = "2026-06-16"): string {
  return new Date(Date.parse(`${from}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
}

// Hand-written ledger for game dates 6/16..7/8: [상자, 상자 II, dispatch boards, weekly fixed].
const EXPECTED_KITS_BY_DATE: Record<string, readonly [number, number, number, number]> = {
  "2026-06-16": [0, 5, 1, 0], // Tue shop
  "2026-06-17": [0, 0, 1, 1], // Wed weekly
  "2026-06-18": [12, 0, 1, 0], // r38 day 1
  "2026-06-19": [4, 8, 1, 0], // r38 day 2
  "2026-06-20": [0, 12, 1, 0], // r38 day 3
  "2026-06-21": [0, 12, 1, 0], // r38 day 4
  "2026-06-22": [0, 12, 1, 0], // r38 day 5
  "2026-06-23": [16, 61, 1, 0], // Tue shop II*5 + grant II*56 + 상자*16; no solo reward
  "2026-06-24": [0, 0, 1, 1], // Wed weekly
  "2026-06-25": [0, 0, 1, 0],
  "2026-06-26": [0, 0, 1, 0],
  "2026-06-27": [0, 0, 1, 0],
  "2026-06-28": [0, 0, 1, 0],
  "2026-06-29": [0, 0, 1, 0],
  "2026-06-30": [0, 5, 1, 0], // Tue shop
  "2026-07-01": [0, 0, 1, 1], // Wed weekly
  "2026-07-02": [0, 0, 1, 0],
  "2026-07-03": [12, 0, 1, 0], // reopen day 1
  "2026-07-04": [4, 8, 1, 0], // reopen day 2
  "2026-07-05": [0, 12, 1, 0], // reopen day 3
  "2026-07-06": [0, 12, 1, 0], // reopen day 4
  "2026-07-07": [0, 17, 1, 0], // reopen day 5 + Tue shop
  "2026-07-08": [0, 0, 1, 1], // Wed weekly; no solo reward
};
const SEGMENT_1_END = "2026-06-22T19:59:59.000Z"; // 6/23(화) 4:59:59 KST
const SEGMENT_2_END = "2026-07-07T19:59:00.000Z"; // 7/8(수) 4:59 KST
const solo = (
  id: string,
  gameDate: string,
  at: string,
  segment: number,
  dayNumber: number,
  regular: number,
  boxII: number,
  expiresAt: string,
) => ({ id, gameDate, at, segment, dayNumber, regular, boxII, expiresAt });
const EXPECTED_R38_EVENTS = [
  solo("solo:r38:day1", "2026-06-18", "2026-06-18T03:00:00.000Z", 1, 1, 12, 0, SEGMENT_1_END),
  solo("solo:r38:day2", "2026-06-19", "2026-06-18T20:00:00.000Z", 1, 2, 4, 8, SEGMENT_1_END),
  solo("solo:r38:day3", "2026-06-20", "2026-06-19T20:00:00.000Z", 1, 3, 0, 12, SEGMENT_1_END),
  solo("solo:r38:day4", "2026-06-21", "2026-06-20T20:00:00.000Z", 1, 4, 0, 12, SEGMENT_1_END),
  solo("solo:r38:day5", "2026-06-22", "2026-06-21T20:00:00.000Z", 1, 5, 0, 12, SEGMENT_1_END),
  solo(
    "solo:r38:segment2:day1",
    "2026-07-03",
    "2026-07-03T03:00:00.000Z",
    2,
    1,
    12,
    0,
    SEGMENT_2_END,
  ),
  solo(
    "solo:r38:segment2:day2",
    "2026-07-04",
    "2026-07-03T20:00:00.000Z",
    2,
    2,
    4,
    8,
    SEGMENT_2_END,
  ),
  solo(
    "solo:r38:segment2:day3",
    "2026-07-05",
    "2026-07-04T20:00:00.000Z",
    2,
    3,
    0,
    12,
    SEGMENT_2_END,
  ),
  solo(
    "solo:r38:segment2:day4",
    "2026-07-06",
    "2026-07-05T20:00:00.000Z",
    2,
    4,
    0,
    12,
    SEGMENT_2_END,
  ),
  solo(
    "solo:r38:segment2:day5",
    "2026-07-07",
    "2026-07-06T20:00:00.000Z",
    2,
    5,
    0,
    12,
    SEGMENT_2_END,
  ),
];

let module: WebAssembly.Module;
let grants: SupplyForecastGrant[];
let restatement: GrantPlan;
let events: ScheduleEvent[];
let reopenFrom7877359: ScheduleEvent["segment"];
let withGrant: SupplyForecastCandidate;
let withoutGrant: SupplyForecastCandidate;
let afterReopen: SupplyForecastCandidate;

beforeAll(async () => {
  module = await loadCertifiedWasm(() => readFile(new URL("public/certified_solver.wasm", ROOT)));
  const suspension = await notice(7833931);
  const followUp = await notice(7837735);
  const reopenNotice = await notice(7877359);
  const original = originalRound38(suspension);
  const suspended = await parseScheduleEvents([suspension], { known: [original] });
  const reopened = await parseScheduleEvents([followUp], { known: [original, ...suspended] });
  events = [original, ...suspended, ...reopened];
  reopenFrom7877359 = (await parseScheduleEvents([reopenNotice], { known: suspended })).find(
    (event) => event.segment?.round === 38,
  )?.segment;

  const { planGrants, loadGrants } = (await import(
    /* @vite-ignore */ collectorModule("grants")
  )) as GrantModule;
  const { runtimeTestDb } = (await import(
    /* @vite-ignore */ collectorModule("test-runtime-db")
  )) as RuntimeDbModule;
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(
      readFileSync(new URL("forecast-collector/fixtures/schema-v27-test.sql", ROOT), "utf8"),
    );
    const db = runtimeTestDb(sqlite);
    const settle = async (item: NormalizedSourceItem) => {
      const plan = await planGrants(db, item, 0);
      if (plan.statements.length) await db.batch(plan.statements);
      return plan;
    };
    await settle(suspension);
    restatement = await settle(followUp);
    // A retry of both notices is idempotent.
    await settle(suspension);
    await settle(followUp);
    grants = await loadGrants(db);
  } finally {
    sqlite.close();
  }
  withGrant = await candidateAt(events, JUNE_23, grants);
  withoutGrant = await candidateAt(events, JUNE_23, []);
  afterReopen = await candidateAt(events, JULY_3, grants);
});

function solve(
  candidate: SupplyForecastCandidate,
  asOf: string,
  input: Pick<CertifiedInput, "stock" | "receivedEventIds">,
): CertifiedOutput {
  // Production views the published snapshot at the user's instant (src/lib/runtimeForecast.ts).
  return solveCertifiedWasm(module, {
    grade: "SR",
    level: 14,
    exp: 0,
    asOf,
    snapshot: viewCertifiedSupplySnapshot(snapshotOf(candidate), asOf),
    computeWaiting: false,
    computeMinimumWait: false,
    ...input,
  });
}
function exactCurrent(output: CertifiedOutput) {
  const value = output.current?.value;
  return {
    kit: output.current?.kit ?? null,
    uses: output.current?.uses,
    pieces: output.current?.pieces,
    successP: value?.successP,
    expectedConsumed: value?.expectedConsumed,
    expectedTotalConsumptionC: value?.expectedTotalConsumptionC,
  };
}

describe("certified-daily-v4 season 38 reopen and one-off grant ledger", () => {
  it("settles the 7833931 grant once and links the 7837735 restatement to it", () => {
    const expected = {
      id: GRANT_ID,
      grantGameDate: "2026-06-23",
      claimWindowAssumed: true,
      sourceIds: [GRANT_SOURCE],
      restatementOf: [],
      kits: { regular: 16, boxII: 56, dispatch: 0, weekly: 0, other: 0 },
      claimUntil: undefined,
    };
    const project = (grant: SupplyForecastGrant) => ({
      id: grant.id,
      grantGameDate: grant.grantGameDate,
      claimWindowAssumed: grant.claimWindowAssumed,
      sourceIds: grant.sourceIds,
      restatementOf: grant.restatementOf,
      kits: kitCounts(grant.refs),
      claimUntil: grant.claimUntil,
    });
    expect(grants.map(project)).toEqual([expected]);
    expect(restatement.judgments.map(({ verdict, reason }) => ({ verdict, reason }))).toEqual([
      { verdict: "schedule_change", reason: null },
    ]);
    expect(restatement.grants.map((grant) => grant.id)).toEqual([GRANT_ID]);
  });

  it("publishes payload 5 with a v4 snapshot and two r38 segments from both reopen notices", () => {
    expect(withGrant.payloadVersion).toBe(5);
    expect(snapshotOf(withGrant).version).toBe("certified-daily-v4");
    expect(withGrant.grants).toEqual(grants);
    const round38 = withGrant.schedule.soloPeriods
      .filter((period) => "round" in period && period.round === 38)
      .map((period) => ({ ...period }));
    expect(round38).toEqual([
      {
        round: 38,
        segment: 1,
        effectiveFrom: "2026-06-18T03:00:00.000Z",
        effectiveUntil: SEGMENT_1_END,
        scheduleStatus: "confirmed",
      },
      {
        round: 38,
        segment: 2,
        effectiveFrom: "2026-07-03T03:00:00.000Z",
        effectiveUntil: SEGMENT_2_END,
        scheduleStatus: "confirmed",
      },
    ]);
    // 7877359 (the in-game reopen notice) independently states the same reopen window.
    expect(reopenFrom7877359).toEqual({
      round: 38,
      segment: 2,
      kind: "reopen",
      effectiveFrom: "2026-07-03T03:00:00.000Z",
      effectiveUntil: SEGMENT_2_END,
    });
  });

  it("matches the literal r38 reward and grant event ledger", () => {
    const snapshot = snapshotOf(withGrant);
    expect(
      snapshot.events
        .filter((event) => event.kind === "solo" && event.round === 38)
        .map((event) => ({
          id: event.id,
          gameDate: event.gameDate,
          at: event.at,
          segment: event.segment,
          dayNumber: event.dayNumber,
          regular: kitCounts(event.refs).regular,
          boxII: kitCounts(event.refs).boxII,
          expiresAt: event.expiresAt,
        })),
    ).toEqual(EXPECTED_R38_EVENTS);
    expect(
      snapshot.events
        .filter((event) => event.kind === "grant")
        .map((event) => ({
          id: event.id,
          gameDate: event.gameDate,
          at: event.at,
          kits: kitCounts(event.refs),
          expiresAt: event.expiresAt,
          claimWindowAssumed: event.claimWindowAssumed,
        })),
    ).toEqual([
      {
        id: GRANT_ID,
        gameDate: "2026-06-23",
        at: "2026-06-22T20:00:00.000Z",
        kits: { regular: 16, boxII: 56, dispatch: 0, weekly: 0, other: 0 },
        expiresAt: undefined,
        claimWindowAssumed: true,
      },
    ]);
  });

  it("matches hand-derived kit totals per game date", () => {
    const snapshot = snapshotOf(withGrant);
    const dates = Object.keys(EXPECTED_KITS_BY_DATE);
    expect(dates).toEqual(Array.from({ length: 23 }, (_, offset) => day(offset)));
    const actual = Object.fromEntries(
      dates.map((date) => {
        const counts = kitCounts(
          snapshot.events
            .filter((event) => event.gameDate === date && !event.cancelled)
            .flatMap((event) => event.refs),
        );
        expect(counts.other, date).toBe(0);
        return [date, [counts.regular, counts.boxII, counts.dispatch, counts.weekly]];
      }),
    );
    expect(actual).toEqual(EXPECTED_KITS_BY_DATE);
  });

  it("adds exactly the documented grant expectation on 6/23 and leaves recurring rates unchanged", () => {
    const grantGain = boxesExpectation([
      [BOX_II, 56],
      [REGULAR_BOX, 16],
    ]);
    // 56*(7/2, 2/5, 1/5) + 16*(12/5, 1/5, 0) = (196 + 192/5, 112/5 + 16/5, 56/5).
    expect(grantGain.map(text)).toEqual(["1172/5", "128/5", "56/5"]);
    const granted = deriveCertifiedDailySupply(snapshotOf(withGrant));
    const plain = deriveCertifiedDailySupply(snapshotOf(withoutGrant));
    expect(granted.map((entry) => entry.gameDate)).toEqual(plain.map((entry) => entry.gameDate));
    const deltas = granted.flatMap((entry, index) => {
      const base = plain[index];
      if (!base) throw new Error("day_missing");
      const delta = entry.expectedGain.map((value, k) =>
        text(minus(fromWireQ(value), fromWireQ(base.expectedGain[k] as WireQ))),
      );
      return delta.every((value) => value === "0/1") ? [] : [[entry.gameDate, delta]];
    });
    expect(deltas).toEqual([["2026-06-23", grantGain.map(text)]]);
    expect(certifiedRecurringRate(snapshotOf(withGrant))).toEqual(
      certifiedRecurringRate(snapshotOf(withoutGrant)),
    );
  });

  it("makes the no-deadline grant claimable only during game day 6/23", () => {
    const snapshot = snapshotOf(withGrant);
    const grant = snapshot.events.find((event) => event.id === GRANT_ID);
    if (!grant) throw new Error("grant_missing");
    const claimable = (at: string) => isCertifiedEventClaimable(snapshot, grant, at);
    expect(claimable("2026-06-22T19:59:59.999Z")).toBe(false); // 6/23 04:59:59.999 KST
    expect(claimable("2026-06-22T20:00:00.000Z")).toBe(true); // 6/23 05:00 KST
    expect(claimable("2026-06-23T19:59:59.999Z")).toBe(true); // 6/24 04:59:59.999 KST
    expect(claimable("2026-06-23T20:00:00.000Z")).toBe(false); // 6/24 05:00 KST
  });

  it("closes original r38 days at the suspension and never revives them after the reopen", () => {
    const snapshot = snapshotOf(withGrant);
    const byId = (id: string) => {
      const event = snapshot.events.find((entry) => entry.id === id);
      if (!event) throw new Error(`${id}_missing`);
      return event;
    };
    const original = EXPECTED_R38_EVENTS.slice(0, 5).map(({ id }) => byId(id));
    expect(
      isCertifiedEventClaimable(snapshot, byId("solo:r38:day5"), "2026-06-22T19:59:58.999Z"),
    ).toBe(true);
    for (const at of ["2026-06-22T19:59:59.000Z", JUNE_23, JULY_3, "2026-07-07T19:58:59.999Z"])
      for (const event of original)
        expect(isCertifiedEventClaimable(snapshot, event, at), `${event.id}@${at}`).toBe(false);
    expect(isCertifiedEventClaimable(snapshot, byId("solo:r38:segment2:day1"), JULY_3)).toBe(true);
    expect(isCertifiedEventClaimable(snapshot, byId("solo:r38:segment2:day2"), JULY_3)).toBe(false);
    // A candidate published after the reopen carries no original day and no expired grant.
    const later = snapshotOf(afterReopen);
    expect(later.events.filter((event) => event.kind === "grant")).toEqual([]);
    expect(
      later.events
        .filter((event) => event.kind === "solo" && event.round === 38)
        .map((event) => event.id),
    ).toEqual(EXPECTED_R38_EVENTS.slice(5).map(({ id }) => id));
  });
});

describe("certified-daily-v4 claim boundary through the Rust/WASM solver", () => {
  it("requires exactly the unreceived 6/23 rewards, including the grant, before solving", () => {
    const nothingReceived = solve(withGrant, JUNE_23, { stock: [0, 0, 0] });
    expect(nothingReceived.status).toBe("completed");
    expect(nothingReceived.waiting.status).toBe("claim_required");
    expect([...(nothingReceived.claimNotice?.eventIds ?? [])].sort()).toEqual([
      "dispatch:2026-06-23",
      GRANT_ID,
      "shop:2026-06-23",
    ]);
    // Stock 0 at SR14 exp0: no use is possible, P = 0 and nothing is consumed.
    expect(exactCurrent(nothingReceived)).toMatchObject({
      successP: wire(0),
      expectedConsumed: [wire(0), wire(0), wire(0)],
      expectedTotalConsumptionC: wire(0),
    });
    const grantMissing = solve(withGrant, JUNE_23, {
      stock: [0, 0, 0],
      receivedEventIds: ["dispatch:2026-06-23", "shop:2026-06-23"],
    });
    expect(grantMissing.claimNotice?.eventIds).toEqual([GRANT_ID]);
    expect(grantMissing.waiting.status).toBe("claim_required");
  });

  it("solves the recorded-receipt case exactly with grant-independent prices", () => {
    const received = ["dispatch:2026-06-23", "shop:2026-06-23", GRANT_ID];
    const output = solve(withGrant, JUNE_23, { stock: [10, 0, 0], receivedEventIds: received });
    expect(output.claimNotice).toBeNull();
    expect(output.refusal).toBeNull();
    expect(output.waiting.status).toBe("not_requested");
    // One blue use at SR14: great 100‰ -> SR15, otherwise SR14 exp200 with no stock left.
    expect(exactCurrent(output)).toEqual({
      kit: "blue",
      uses: 1,
      pieces: 10,
      successP: wire(1, 10),
      expectedConsumed: [wire(10), wire(0), wire(0)],
      expectedTotalConsumptionC: wire(10),
    });
    const plain = solve(withoutGrant, JUNE_23, {
      stock: [10, 0, 0],
      receivedEventIds: ["dispatch:2026-06-23", "shop:2026-06-23"],
    });
    expect(plain.claimNotice).toBeNull();
    expect(output.pricing).not.toBeNull();
    expect(output.pricing).toEqual(plain.pricing);
    expect(output.pricing?.recurringRate.map(fromWireQ).map(text)).toEqual(
      certifiedRecurringRate(snapshotOf(withoutGrant)).map(({ n, d }) => text(frac(n, d))),
    );
    expect(output.current).toEqual(plain.current);
  });

  it("drops an unclaimed grant on the next game day", () => {
    const output = solve(withGrant, JUNE_24, {
      stock: [0, 0, 10],
      receivedEventIds: ["dispatch:2026-06-24", "weekly-kits:2026-06-24"],
    });
    expect(output.claimNotice).toBeNull();
    expect(output.refusal).toBeNull();
    // One yellow use at SR14 is a certain great success.
    expect(exactCurrent(output)).toEqual({
      kit: "yellow",
      uses: 1,
      pieces: 10,
      successP: wire(1),
      expectedConsumed: [wire(0), wire(0), wire(10)],
      expectedTotalConsumptionC: wire(10),
    });
    const unreceived = solve(withGrant, JUNE_24, { stock: [0, 0, 0] });
    expect([...(unreceived.claimNotice?.eventIds ?? [])].sort()).toEqual([
      "dispatch:2026-06-24",
      "weekly-kits:2026-06-24",
    ]);
  });

  it("requires the reopened day-1 reward, not original days, after the reopen", () => {
    const output = solve(afterReopen, JULY_3, { stock: [0, 0, 0] });
    expect(output.waiting.status).toBe("claim_required");
    expect([...(output.claimNotice?.eventIds ?? [])].sort()).toEqual([
      "dispatch:2026-07-03",
      "solo:r38:segment2:day1",
      "weekly-kits:2026-07-01",
    ]);
  });
});
