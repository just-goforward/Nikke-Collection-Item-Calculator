import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SOLO_RAID_ROUND_HISTORY, type SoloRaidRound } from "../../../../../shared/soloRaidCadence";
import { predictMedianSoloRaid } from "../projection";

const repo = new URL("../../../../../", import.meta.url);
const expectedDir = new URL("forecast-collector/fixtures/forecast-v2/expected/", repo);
const readJson = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(name, expectedDir), "utf8")) as T;
const at = (value: string | null | undefined) => (value == null ? null : Date.parse(value));
const DAY = 86_400_000;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY;

/** Independent oracle: interval median, even count = mean of the middle two rounded down (U5). */
function cadence(startDates: readonly string[]) {
  const intervals = startDates
    .slice(1)
    .map((date, index) => dayNumber(date) - dayNumber(startDates[index] ?? date));
  const sorted = [...intervals].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const median =
    sorted.length % 2
      ? (sorted[middle] ?? 0)
      : Math.floor(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
  const counts = new Map<number, number>();
  for (const days of intervals) counts.set(days, (counts.get(days) ?? 0) + 1);
  const ranked = [...counts].sort(([a, x], [b, y]) => y - x || a - b).map(([days]) => days);
  return { intervals: intervals.length, median, second: ranked[1] };
}

type SoloExpected = {
  seasons: { season: number; segments: [string | null, string | null][] }[];
  prediction: {
    asOf: string;
    additionalRounds: SoloRaidRound[];
    intervals: number;
    medianDays: number;
    previousStart: string;
    previousEnd: string;
    primary: { status: string; startAt: string; endAt: string; expectedNotice: string };
    secondary: { intervalDays: number; startAt: string };
    interrupted: {
      rounds: number;
      previousStart: string;
      previousEnd: string;
      interruptionAt: string;
      asOf: string;
      medianDays: number;
      startAt: string;
      endAt: string;
    };
  };
};
const solo = readJson<SoloExpected>("solo.json");
const prediction = solo.prediction;
const allRounds: SoloRaidRound[] = [...SOLO_RAID_ROUND_HISTORY, ...prediction.additionalRounds];

describe("T06 solo prediction", () => {
  it("median 28 over 41 intervals (S1–S40 history + S41/S42), second interval 35", () => {
    const summary = cadence(allRounds.map((round) => round.startGameDate));
    expect(summary).toEqual({
      intervals: prediction.intervals,
      median: prediction.medianDays,
      second: prediction.secondary.intervalDays,
    });
  });

  it("predicts S43 2026-11-12 12:00 ~ 11-19 04:59:59 with the 35-day alternative and the notice day", () => {
    const result = predictMedianSoloRaid({
      confirmedRounds: allRounds,
      previousStart: prediction.previousStart,
      previousEnd: prediction.previousEnd,
      asOf: prediction.asOf,
    });
    expect(result.primary.intervalDays).toBe(prediction.medianDays);
    expect(result.primary.status).toBe(prediction.primary.status);
    expect([
      at(result.primary.start),
      at(result.primary.end),
      at(result.primary.expectedNotice),
    ]).toEqual([
      at(prediction.primary.startAt),
      at(prediction.primary.endAt),
      at(prediction.primary.expectedNotice),
    ]);
    expect(result.secondary?.intervalDays).toBe(prediction.secondary.intervalDays);
    expect(at(result.secondary?.start)).toBe(at(prediction.secondary.startAt));
  });

  it("uses start → suspension as the duration of an interrupted previous season (U5 changed)", () => {
    const item = prediction.interrupted;
    const rounds = SOLO_RAID_ROUND_HISTORY.slice(0, item.rounds);
    expect(cadence(rounds.map((round) => round.startGameDate)).median).toBe(item.medianDays);
    const result = predictMedianSoloRaid({
      confirmedRounds: rounds,
      previousStart: item.previousStart,
      previousEnd: item.previousEnd,
      interruptionAt: item.interruptionAt,
      asOf: item.asOf,
    });
    expect([at(result.primary.start), at(result.primary.end)]).toEqual([
      at(item.startAt),
      at(item.endAt),
    ]);
    expect((at(item.endAt) ?? 0) - (at(item.startAt) ?? 0)).toBe(
      (at(item.interruptionAt) ?? 0) - (at(item.previousStart) ?? 0),
    );
  });

  it("rounds an even-count median down to whole days", () => {
    const rounds: SoloRaidRound[] = ["2026-01-01", "2026-01-29", "2026-03-05"].map(
      (startGameDate, index) => ({
        round: index + 1,
        startGameDate,
        status: "as_announced" as const,
        sourceFeedId: 0,
      }),
    );
    expect(cadence(rounds.map((round) => round.startGameDate)).median).toBe(31);
    const result = predictMedianSoloRaid({
      confirmedRounds: rounds,
      previousStart: "2026-03-05T12:00:00+09:00",
      previousEnd: "2026-03-12T04:59:59+09:00",
      asOf: "2026-03-06T00:00:00+09:00",
    });
    expect(result.primary.intervalDays).toBe(31);
    expect(at(result.primary.start)).toBe(at("2026-04-05T12:00:00+09:00"));
  });
});

// ---------------------------------------------------------------- T10 oracle integrity
type GrantsExpected = {
  posts: {
    feedId: number;
    board: number;
    action: string;
    ii: number;
    box: number;
    gameDay?: string;
  }[];
  scriptedDecisions: { feedId: number; gameDay: string }[];
  occurrences: { gameDay: string; ii: number; box: number; board: number; sources: number[] }[];
  totals: { occurrences: number; board11: number; board48: number; ii: number; box: number };
};
type CollabExpected = {
  collaborations: {
    key: string;
    name: string;
    startAt: string;
    endAt: string;
  }[];
};
type Difference = { area: string; item: string; html: string | null; rules: string | null };
type OracleExpected = {
  html: { path: string; sha256: string };
  nextMonthHtml: { path: string; sha256: string };
  htmlSnapshot: {
    solo: { season: number; segments: [string, string, string][] }[];
    collab: { name: string; start: string }[];
    kits: { date: string; ii: number; i: number; src: number[] }[];
    b11: number[];
    coop: { from: string; to: string };
  };
  coop: {
    windowStart: string;
    windowEnd: string;
    weeks: number;
    doubledBacktest: number;
    overlapTuesday: string;
    overlapSupply: number;
  };
  differences: Difference[];
};
const grants = readJson<GrantsExpected>("grants.json");
const collabs = readJson<CollabExpected>("collaborations.json").collaborations;
const oracle = readJson<OracleExpected>("oracle-2y.json");
const snapshot = oracle.htmlSnapshot;
/** KST wall clock at minute precision, the resolution of the HTML oracle. */
const minute = (instant: string | null) =>
  instant === null
    ? null
    : new Date(Date.parse(instant) + 9 * 3_600_000).toISOString().slice(0, 16);
const htmlInstant = (wall: string) => `${wall}:${wall.endsWith(":59") ? "59" : "00"}+09:00`;

/** Tuesday 05:00 KST co-op supply: ×5, ×10 when inside any collaboration window (once). */
function coop(windows: readonly { startAt: string; endAt: string }[], from: string, to: string) {
  const weeks: { day: string; ii: number; windows: number }[] = [];
  for (let day = dayNumber(from); day <= dayNumber(to); day++) {
    const date = new Date(day * DAY).toISOString().slice(0, 10);
    if (new Date(day * DAY).getUTCDay() !== 2) continue;
    const instant = Date.parse(`${date}T05:00:00+09:00`);
    const inside = windows.filter(
      (window) => Date.parse(window.startAt) <= instant && instant <= Date.parse(window.endAt),
    ).length;
    weeks.push({ day: date, ii: inside ? 10 : 5, windows: inside });
  }
  return weeks;
}

describe("T10 oracle integrity", () => {
  it("recomputes the 11 grant occurrences, II 338 / box 35, board 6 + 5", () => {
    const occurrences = grants.occurrences;
    expect(occurrences.length).toBe(grants.totals.occurrences);
    expect(occurrences.reduce((sum, item) => sum + item.ii, 0)).toBe(grants.totals.ii);
    expect(occurrences.reduce((sum, item) => sum + item.box, 0)).toBe(grants.totals.box);
    expect([
      occurrences.filter((item) => item.board === 11).length,
      occurrences.filter((item) => item.board === 48).length,
    ]).toEqual([grants.totals.board11, grants.totals.board48]);
    // Every post belongs to exactly one occurrence with its own game day and quantities.
    const scripted = new Map(grants.scriptedDecisions.map((item) => [item.feedId, item.gameDay]));
    const sources = occurrences.flatMap((item) => item.sources);
    expect([...sources].sort()).toEqual(grants.posts.map((item) => item.feedId).sort());
    for (const post of grants.posts) {
      const occurrence = occurrences.find((item) => item.sources.includes(post.feedId));
      expect([occurrence?.gameDay, occurrence?.ii, occurrence?.box]).toEqual([
        post.gameDay ?? scripted.get(post.feedId),
        post.ii,
        post.box,
      ]);
    }
    expect(grants.totals).toEqual({ occurrences: 11, board11: 6, board48: 5, ii: 338, box: 35 });
  });

  it("recomputes 104 co-op weeks with 23 doubled; Stellar/Nier 7/8 counts once", () => {
    expect(collabs.length).toBe(6);
    const weeks = coop(collabs, oracle.coop.windowStart, oracle.coop.windowEnd);
    expect(weeks.length).toBe(oracle.coop.weeks);
    expect(weeks.filter((week) => week.ii === 10).length).toBe(oracle.coop.doubledBacktest);
    expect(weeks.find((week) => week.day === oracle.coop.overlapTuesday)).toEqual({
      day: oracle.coop.overlapTuesday,
      ii: oracle.coop.overlapSupply,
      windows: 2,
    });
    expect([oracle.coop.weeks, oracle.coop.doubledBacktest]).toEqual([104, 23]);
  });

  it("the HTML snapshot reproduces its own totals (11 kits, 338/35, 104 weeks, 23 doubled, 15 B reports)", () => {
    expect(snapshot.kits.length).toBe(11);
    expect([
      snapshot.kits.reduce((sum, item) => sum + item.ii, 0),
      snapshot.kits.reduce((sum, item) => sum + item.i, 0),
    ]).toEqual([338, 35]);
    const windows = snapshot.collab.map((item) => {
      const end = new Date((dayNumber(item.start.slice(0, 10)) + 28) * DAY)
        .toISOString()
        .slice(0, 10);
      return { startAt: htmlInstant(item.start), endAt: `${end}T04:59:59+09:00` };
    });
    const weeks = coop(windows, snapshot.coop.from.slice(0, 10), snapshot.coop.to.slice(0, 10));
    expect([weeks.length, weeks.filter((week) => week.ii === 10).length]).toEqual([104, 23]);
    expect(snapshot.b11.length).toBe(15);
  });

  it("lists every rules-vs-HTML difference exactly (kits equal by game day and quantity)", () => {
    const found: Difference[] = [];
    for (const html of snapshot.solo) {
      const rules = solo.seasons.find((item) => item.season === html.season)?.segments ?? [];
      html.segments.forEach(([start, end], index) => {
        const segment = rules[index] ?? [null, null];
        const bounds: [string, string, string | null][] = [
          ["start", start, segment[0]],
          ["end", end, segment[1]],
        ];
        for (const [label, wall, instant] of bounds)
          if (minute(instant) !== wall)
            found.push({
              area: "solo",
              item: `S${html.season} segment ${index + 1} ${label}`,
              html: wall,
              rules: minute(instant),
            });
      });
      expect(rules.length, `S${html.season} segment count`).toBe(html.segments.length);
    }
    for (const rules of collabs) {
      const html = snapshot.collab.find((item) => item.name === rules.name);
      if (!html)
        found.push({ area: "collab", item: rules.name, html: null, rules: minute(rules.startAt) });
      else {
        if (html.start !== minute(rules.startAt))
          found.push({
            area: "collab",
            item: `${rules.name} start`,
            html: html.start,
            rules: minute(rules.startAt),
          });
        const htmlEnd = new Date((dayNumber(html.start.slice(0, 10)) + 28) * DAY)
          .toISOString()
          .slice(0, 10);
        expect(`${htmlEnd}T04:59`, `${rules.name} end`).toBe(minute(rules.endAt));
      }
    }
    expect(snapshot.collab.every((html) => collabs.some((rules) => rules.name === html.name))).toBe(
      true,
    );
    expect(found).toEqual(
      oracle.differences.map(({ area, item, html, rules }) => ({ area, item, html, rules })),
    );
    const kits = (rows: { day: string; ii: number; box: number; src: number[] }[]) =>
      rows.map((row) => `${row.day} ${row.ii}/${row.box} ${[...row.src].sort().join(",")}`).sort();
    expect(
      kits(
        grants.occurrences.map((item) => ({
          day: item.gameDay,
          ii: item.ii,
          box: item.box,
          src: item.sources,
        })),
      ),
    ).toEqual(
      kits(
        snapshot.kits.map((item) => ({ day: item.date, ii: item.ii, box: item.i, src: item.src })),
      ),
    );
  });
});

// The .artifacts HTML files are untracked working-copy artifacts; when present they must be
// the exact files the snapshot was copied from.
const htmlUrl = new URL(oracle.html.path, repo);
describe.runIf(existsSync(htmlUrl))("T10 pinned 2y HTML matches the snapshot", () => {
  it("sha256 is pinned", () => {
    expect(createHash("sha256").update(readFileSync(htmlUrl)).digest("hex")).toBe(
      oracle.html.sha256,
    );
  });
  it("SOLO / COLLAB / KITS / B11 / co-op loop equal the snapshot", () => {
    const html = readFileSync(htmlUrl, "utf8");
    const solo = [...html.matchAll(/\{s:(\d+), segs:\[(.*?)\], src:/g)].map((match) => ({
      season: Number(match[1]),
      segments: [...(match[2] ?? "").matchAll(/\["([^"]+)","([^"]+)","(ok|unk)"/g)].map((seg) => [
        seg[1],
        seg[2],
        seg[3],
      ]),
    }));
    expect(solo).toEqual(snapshot.solo);
    expect(
      [...html.matchAll(/\{name:"([^"]+)", start:"([^"]+)"/g)].map((match) => ({
        name: match[1],
        start: match[2],
      })),
    ).toEqual(snapshot.collab);
    expect(
      [...html.matchAll(/\{date:"([^"]+)", ii:(\d+), i:(\d+),.*?src:\[([\d,]+)\]/g)].map(
        (match) => ({
          date: match[1],
          ii: Number(match[2]),
          i: Number(match[3]),
          src: (match[4] ?? "").split(",").map(Number),
        }),
      ),
    ).toEqual(snapshot.kits);
    expect(
      [...html.matchAll(/\["\d{4}-\d{2}-\d{2} \d{2}:\d{2}",(\d+),/g)].map((match) =>
        Number(match[1]),
      ),
    ).toEqual(snapshot.b11);
    expect(/for \(let t = kst\("([^"]+)"\); t <= kst\("([^"]+)"\)/.exec(html)?.slice(1)).toEqual([
      snapshot.coop.from,
      snapshot.coop.to,
    ]);
  });
});

const nextMonthUrl = new URL(oracle.nextMonthHtml.path, repo);
describe.runIf(existsSync(nextMonthUrl))(
  "T06 pinned next-month HTML agrees with the prediction",
  () => {
    it("S43, 35-day alternative and the expected notice day", () => {
      const bytes = readFileSync(nextMonthUrl);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(oracle.nextMonthHtml.sha256);
      const html = bytes.toString("utf8");
      const s43 = /label:"S43 예측", a:"([^"]+)", b:"([^"]+)"/.exec(html);
      expect([htmlInstant(s43?.[1] ?? ""), htmlInstant(s43?.[2] ?? "")].map(at)).toEqual([
        at(prediction.primary.startAt),
        at(prediction.primary.endAt),
      ]);
      expect(/ALT = \{label:"[^"]*", start:"([^"]+)"\}/.exec(html)?.[1]).toBe(
        prediction.secondary.startAt.slice(0, 10),
      );
      expect(/NOTICES = \[\{date:"([^"]+)", text:"S43 오픈 공지 예상 17:00"/.exec(html)?.[1]).toBe(
        prediction.primary.expectedNotice.slice(0, 10),
      );
    });
  },
);
