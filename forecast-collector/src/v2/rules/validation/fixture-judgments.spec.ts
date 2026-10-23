import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SOLO_RAID_ROUND_HISTORY } from "../../../../../shared/soloRaidCadence";
import { judgeCollaboration } from "../collaboration";
import { collaborationEnd, gameDay } from "../game-day";
import { judgeGrant } from "../grant-judgment";
import {
  type ExistingWindow,
  excludedCollaborationTitle,
  type GrantIdentity,
  grantIdentity,
  resolveMaintenance,
} from "../identity";
import {
  type InterruptionSegment,
  interruptionEvidence,
  judgeMaintenance,
  judgeSolo,
  type Notice,
} from "../schedules";

// Expected values live in fixtures/forecast-v2/expected/*.json and are derived from
// docs/forecast-v2/forecast-rules-v2.md + plan §7A/§7B, never from these functions' output.
const fixtures = new URL("../../../../fixtures/", import.meta.url);
const read = (relative: string) => readFileSync(new URL(relative, fixtures));
const readJson = <T>(relative: string): T => JSON.parse(read(relative).toString("utf8")) as T;

type Manifest = {
  requestedIds: string[];
  referenced: { feedId: string; path: string; sha256: string }[];
  records: { path: string; sanitizedSha256: string; feedId?: string }[];
  searches: { monitor: string; feedIds: number[] }[];
};
type Detail = {
  content: {
    feed: {
      feedId: number;
      title: string;
      contents: string;
      createdDate: string;
      boardId?: number;
    };
    board?: { boardId: number };
  };
};
type Post = Notice & { feedId: number; board: number };

const manifest = readJson<Manifest>("forecast-v2/manifest.json");
const referenced = new Map(
  manifest.referenced.map((item) => [
    Number(item.feedId),
    item.path.replace(/^forecast-collector\/fixtures\//, ""),
  ]),
);
const allIds = [...new Set([...manifest.requestedIds.map(Number), ...referenced.keys()])];
const kst = (compact: string) =>
  `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T` +
  `${compact.slice(8, 10)}:${compact.slice(10, 12)}:${compact.slice(12, 14)}+09:00`;
const cache = new Map<number, Post>();
function load(feedId: number): Post {
  const hit = cache.get(feedId);
  if (hit) return hit;
  const detail = readJson<Detail>(referenced.get(feedId) ?? `forecast-v2/details/${feedId}.json`);
  const feed = detail.content.feed;
  if (feed.feedId !== feedId) throw new Error(`fixture ${feedId} contains feed ${feed.feedId}`);
  const post = {
    feedId,
    title: feed.title,
    body: feed.contents,
    postedAt: kst(feed.createdDate),
    board: feed.boardId ?? detail.content.board?.boardId ?? -1,
  };
  cache.set(feedId, post);
  return post;
}
const at = (value: string | null | undefined) => (value == null ? null : Date.parse(value));
const byPostTime = (a: number, b: number) =>
  Date.parse(load(a).postedAt) - Date.parse(load(b).postedAt);
const searchIds = (monitor: string) =>
  manifest.searches.find((item) => item.monitor === monitor)?.feedIds ?? [];

describe("captured fixture integrity", () => {
  it("every detail fixture matches its manifest hash", () => {
    const actual = [
      ...manifest.records
        .filter((item) => item.feedId !== undefined)
        .map((item) => [
          item.path,
          createHash("sha256")
            .update(read(`forecast-v2/${item.path}`))
            .digest("hex"),
          item.sanitizedSha256,
        ]),
      ...manifest.referenced.map((item) => [
        item.path,
        createHash("sha256")
          .update(read(item.path.replace(/^forecast-collector\/fixtures\//, "")))
          .digest("hex"),
        item.sha256,
      ]),
    ].filter(([, hash, pinned]) => hash !== pinned);
    expect(actual).toEqual([]);
  });
});

// ---------------------------------------------------------------- G (U7)
type MaintenanceExpected = {
  confirmed: { feedId: number; startAt: string; endAt: string; reason: string }[];
  ignored: ({ feedId: number; reason: string } | { feedIds: number[]; reason: string })[];
};
const maintenance = readJson<MaintenanceExpected>("forecast-v2/expected/maintenance.json");
const ignoredMaintenance = maintenance.ignored.flatMap((item) =>
  "feedIds" in item ? item.feedIds : [item.feedId],
);
/** Final G heads from the expected oracle, so downstream checks do not inherit G defects. */
const heads: ExistingWindow[] = maintenance.confirmed.map((item) => ({
  id: String(item.feedId),
  startAt: item.startAt,
  endAt: item.endAt,
}));

describe("G maintenance title/body rule (U7)", () => {
  it.each(maintenance.confirmed)("$feedId → maintenance window", (item) => {
    const result = judgeMaintenance(load(item.feedId));
    expect(result.action, item.reason).toBe("confirmed");
    if (result.action !== "confirmed") return;
    expect([at(result.startAt), at(result.endAt)]).toEqual([at(item.startAt), at(item.endAt)]);
  });

  it.each(ignoredMaintenance)("%i is not a maintenance notice", (feedId) => {
    expect(judgeMaintenance(load(feedId))).toEqual({ action: "ignore" });
  });

  it("classifies every captured board-48 post exactly once", () => {
    const board48 = allIds.filter((id) => load(id).board === 48).sort();
    const classified = [
      ...maintenance.confirmed.map((item) => item.feedId),
      ...ignoredMaintenance,
    ].sort();
    expect(classified).toEqual(board48);
    expect(new Set(classified).size).toBe(classified.length);
  });

  it("needs 점검 in the title and a 점검 일시 or 일시 body label (U7 widened)", () => {
    const postedAt = "2025-06-30T18:47:17+09:00";
    const window = {
      action: "confirmed",
      startAt: "2025-07-03T11:00:00+09:00",
      endAt: "2025-07-03T16:00:00+09:00",
    };
    expect(
      judgeMaintenance({
        title: "7월 3일(목) 업데이트 소식",
        body: "✔️ 점검 일시\n- 7월 3일(목) 11:00:00 ~ 16:00:00",
        postedAt,
      }),
    ).toEqual({ action: "ignore" });
    const labelled = judgeMaintenance({
      title: "[점검&업데이트] 7월 3일",
      body: "✔️ 일시\n- 7/3(목) 11:00 ~ 16:00",
      postedAt,
    });
    expect(labelled.action).toBe("confirmed");
    if (labelled.action === "confirmed")
      expect([at(labelled.startAt), at(labelled.endAt)]).toEqual([
        at(window.startAt),
        at(window.endAt),
      ]);
    expect(
      judgeMaintenance({
        title: "[점검&업데이트] 7월 3일",
        body: "✔️ 내용\n- 7/3(목) 11:00 ~ 16:00",
        postedAt,
      }),
    ).toEqual({ action: "ignore" });
  });

  it("never guesses between missing or multiple same-date maintenance windows", () => {
    expect(resolveMaintenance("2025-06-25", heads)).toEqual({ reason: "maintenance_missing" });
    expect(resolveMaintenance("2025-06-24", heads)).toEqual({
      endAt: "2025-06-24T16:00:00+09:00",
      eventId: "6241570",
    });
    expect(
      resolveMaintenance("2025-07-03", [
        ...heads,
        { id: "x", startAt: "2025-07-03T20:00:00+09:00", endAt: "2025-07-03T21:00:00+09:00" },
      ]),
    ).toEqual({ reason: "maintenance_multiple" });
    expect(resolveMaintenance("2025-07-03", heads)).toEqual({
      endAt: "2025-07-03T16:00:00+09:00",
      eventId: "6276795",
    });
  });
});

// ---------------------------------------------------------------- T04 grants
type GrantPost = {
  feedId: number;
  board: number;
  action: "grant" | "decision";
  ii: number;
  box: number;
  gameDay?: string;
  instant?: string;
  basis?: string;
  acceptBasis?: string[];
  candidateInstants?: string[];
  reason: string;
};
type GrantsExpected = {
  posts: GrantPost[];
  scriptedDecisions: { feedId: number; selected: string; gameDay: string }[];
  occurrences: { gameDay: string; ii: number; box: number; board: number; sources: number[] }[];
  totals: { occurrences: number; board11: number; board48: number; ii: number; box: number };
};
const grants = readJson<GrantsExpected>("forecast-v2/expected/grants.json");
const scripted = new Map(grants.scriptedDecisions.map((item) => [item.feedId, item]));

type Observation = { feedId: number; gameDay: string; ii: number; box: number };
function occurrencesOf(observations: readonly Observation[]) {
  const existing: GrantIdentity[] = [];
  const sources = new Map<string, number[]>();
  const conflicts: number[] = [];
  for (const observation of [...observations].sort((a, b) => byPostTime(a.feedId, b.feedId))) {
    const result = grantIdentity(observation, existing);
    if (result.action === "create") {
      const id = String(observation.feedId);
      existing.push({ id, gameDay: observation.gameDay, ii: observation.ii, box: observation.box });
      sources.set(id, [observation.feedId]);
    } else if (result.action === "link") sources.get(result.grantId)?.push(observation.feedId);
    else conflicts.push(observation.feedId);
  }
  return {
    conflicts,
    occurrences: existing
      .map((item) => ({
        gameDay: item.gameDay,
        ii: item.ii,
        box: item.box,
        sources: [...(sources.get(item.id) ?? [])].sort(),
      }))
      .sort((a, b) => a.gameDay.localeCompare(b.gameDay)),
  };
}
const expectedOccurrences = grants.occurrences.map((item) => ({
  gameDay: item.gameDay,
  ii: item.ii,
  box: item.box,
  sources: [...item.sources].sort(),
}));

describe("T04 kit grants", () => {
  it.each(grants.posts)("$feedId → $action", (item) => {
    const result = judgeGrant(load(item.feedId), heads);
    expect(result.action, item.reason).toBe(item.action);
    if (result.action === "ignore") return;
    expect({ ii: result.ii, box: result.box }).toEqual({ ii: item.ii, box: item.box });
    if (result.action === "grant") {
      expect(result.gameDay).toBe(item.gameDay);
      if (item.instant) expect(at(result.instant)).toBe(at(item.instant));
      expect(item.acceptBasis ?? [item.basis]).toContain(result.basis);
    } else {
      const candidates = result.candidates.map((candidate) => at(candidate.instant));
      for (const instant of item.candidateInstants ?? []) expect(candidates).toContain(at(instant));
    }
  });

  it("finds no kit grant in any other captured post (non-kit rewards ignored)", () => {
    const grantIds = new Set(grants.posts.map((item) => item.feedId));
    expect(
      allIds.filter((id) => !grantIds.has(id) && judgeGrant(load(id), heads).action !== "ignore"),
    ).toEqual([]);
  });

  it("dedups the expected observations into 11 occurrences (II 338 / box 35)", () => {
    const observations = grants.posts.map((item) => ({
      feedId: item.feedId,
      ii: item.ii,
      box: item.box,
      gameDay: item.gameDay ?? scripted.get(item.feedId)?.gameDay ?? "unresolved",
    }));
    const { occurrences, conflicts } = occurrencesOf(observations);
    expect(conflicts).toEqual([]);
    expect(occurrences).toEqual(expectedOccurrences);
    expect(occurrences.length).toBe(grants.totals.occurrences);
    expect(occurrences.reduce((sum, item) => sum + item.ii, 0)).toBe(grants.totals.ii);
    expect(occurrences.reduce((sum, item) => sum + item.box, 0)).toBe(grants.totals.box);
  });

  it("end to end: judgeGrant + scripted decisions + grantIdentity give the 11 occurrences", () => {
    const observations: Observation[] = [];
    for (const item of grants.posts) {
      const result = judgeGrant(load(item.feedId), heads);
      if (result.action === "grant")
        observations.push({
          feedId: item.feedId,
          gameDay: result.gameDay,
          ii: result.ii,
          box: result.box,
        });
      if (result.action === "decision") {
        const answer = scripted.get(item.feedId);
        if (answer)
          observations.push({
            feedId: item.feedId,
            gameDay: answer.gameDay,
            ii: result.ii,
            box: result.box,
          });
      }
    }
    expect(occurrencesOf(observations).occurrences).toEqual(expectedOccurrences);
  });

  it("counts box II and plain boxes separately and ignores other rewards", () => {
    const base = { title: "보상 안내", postedAt: "2026-08-22T20:06:08+09:00" };
    expect(
      judgeGrant(
        {
          ...base,
          body: "전체 지휘관 우편 보상 지급\n- 관리 키트 상자 II ×24\n- 큐브 배터리 무작위 보상 * 18\n- 소장품 관리 키트 * 3",
        },
        [],
      ),
    ).toMatchObject({ action: "grant", ii: 24, box: 0 });
    expect(
      judgeGrant(
        {
          ...base,
          body: "전체 지휘관 우편 보상 지급\n- 관리 키트 상자 Ⅱ * 3\n- 관리 키트 상자 * 2",
        },
        [],
      ),
    ).toMatchObject({ action: "grant", ii: 3, box: 2 });
  });

  it("asks for a decision on same-day different quantities and keeps other days separate (U6)", () => {
    const existing = [{ id: "8091116", gameDay: "2026-08-22", ii: 24, box: 0 }];
    expect(grantIdentity({ gameDay: "2026-08-22", ii: 20, box: 0 }, existing)).toEqual({
      action: "decision",
      reason: "grant_quantity",
      candidates: ["8091116"],
    });
    expect(grantIdentity({ gameDay: "2026-08-23", ii: 24, box: 0 }, existing)).toEqual({
      action: "create",
    });
    expect(grantIdentity({ gameDay: "2026-08-22", ii: 24, box: 0 }, existing)).toEqual({
      action: "link",
      grantId: "8091116",
    });
  });
});

// ---------------------------------------------------------------- T05 solo
type SoloExpected = {
  judgeSolo: {
    feedId: number;
    monitor: string;
    season: number;
    action: "confirmed" | "decision";
    startAt?: string;
    endAt?: string;
    maintenanceEventId?: string;
    reason: string;
  }[];
  bEvidence: {
    feedId: number;
    requires: { kinds: string[]; at: string }[];
    noResume?: boolean;
    reason: string;
  }[];
  seasons: { season: number; segments: [string | null, string | null][]; sources: number[] }[];
};
const solo = readJson<SoloExpected>("forecast-v2/expected/solo.json");
const carries = (
  segments: readonly InterruptionSegment[],
  kinds: readonly string[],
  instant: string | null,
) =>
  segments.some(
    (segment) =>
      kinds.includes(segment.kind) &&
      [segment.startAt, segment.endAt].some(
        (value) => value !== undefined && at(value) === at(instant),
      ),
  );
const segmentsOf = (season: number) =>
  solo.seasons.find((item) => item.season === season)?.segments ?? [];
const confirmedSolo = (feedId: number) => {
  const result = judgeSolo(load(feedId), heads);
  return result.action === "confirmed" ? result : null;
};

describe("T05 solo raid", () => {
  it("covers every C-open, C-reopen and E search hit", () => {
    const judged = new Set(solo.judgeSolo.map((item) => item.feedId));
    expect(
      [...searchIds("C-open"), ...searchIds("C-reopen"), ...searchIds("E")].filter(
        (id) => !judged.has(id),
      ),
    ).toEqual([]);
    expect(solo.bEvidence.map((item) => item.feedId).sort()).toEqual([...searchIds("B")].sort());
  });

  it.each(solo.judgeSolo)("$feedId ($monitor S$season) → $action", (item) => {
    const result = judgeSolo(load(item.feedId), heads);
    expect(result.action, item.reason).toBe(item.action);
    if (result.action !== "confirmed") return;
    expect([at(result.startAt), at(result.endAt)]).toEqual([at(item.startAt), at(item.endAt)]);
    expect(result.maintenanceEventId).toBe(item.maintenanceEventId);
  });

  it.each(solo.bEvidence)("B $feedId evidence", (item) => {
    const segments = interruptionEvidence(load(item.feedId));
    for (const requirement of item.requires)
      expect
        .soft(
          carries(segments, requirement.kinds, requirement.at),
          `${item.reason}: ${requirement.kinds.join("|")} @ ${requirement.at}`,
        )
        .toBe(true);
    if (!item.requires.length)
      expect(
        segments.filter((segment) => segment.startAt !== undefined || segment.endAt !== undefined),
      ).toEqual([]);
    if (item.noResume)
      expect(
        segments.filter(
          (segment) =>
            segment.kind !== "suspend" && (segment.startAt ?? segment.endAt) !== undefined,
        ),
      ).toEqual([]);
  });

  it("S19: three segments from C 4989013/5058745 and B 5013873/5089411", () => {
    const [first, second, third] = segmentsOf(19);
    expect.soft(at(confirmedSolo(4989013)?.startAt)).toBe(at(first?.[0]));
    expect
      .soft(
        carries(interruptionEvidence(load(5013873)), ["suspend"], first?.[1] ?? null),
        "11/1 22:00 suspension",
      )
      .toBe(true);
    expect.soft(at(confirmedSolo(5058745)?.startAt)).toBe(at(second?.[0]));
    const s19 = interruptionEvidence(load(5089411));
    expect
      .soft(carries(s19, ["suspend"], second?.[1] ?? null), "11/12 18:00 suspension")
      .toBe(true);
    expect
      .soft(carries(s19, ["suspend", "resume"], third?.[0] ?? null), "11/13 12:00 resume")
      .toBe(true);
    expect
      .soft(carries(s19, ["extend"], third?.[1] ?? null), "11/17 05:00 extended end")
      .toBe(true);
  });

  it("S26: 6252194 stays unresolved until E 6280133 supplies 7/3 ~ 7/10 04:59:59", () => {
    const [first, second, third] = segmentsOf(26);
    expect.soft(at(confirmedSolo(6193554)?.startAt)).toBe(at(first?.[0]));
    const reopen = confirmedSolo(6225681);
    expect
      .soft([at(reopen?.startAt), reopen?.maintenanceEventId], "6/24 점검 완료 후 = 6241570 end")
      .toEqual([at(second?.[0]), "6241570"]);
    expect.soft(at(first?.[1]), "segment 1 ends at the reopen instant").toBe(at(second?.[0]));
    const suspension = interruptionEvidence(load(6252194));
    expect
      .soft(carries(suspension, ["suspend"], second?.[1] ?? null), "6/26 00:00 suspension")
      .toBe(true);
    expect
      .soft(
        suspension.some((segment) => segment.kind !== "suspend" && segment.startAt !== undefined),
        "no resume → E needed",
      )
      .toBe(false);
    const supplement = confirmedSolo(6280133);
    expect
      .soft([at(supplement?.startAt), at(supplement?.endAt)])
      .toEqual([at(third?.[0]), at(third?.[1])]);
  });

  it("S38: 7817596 → 7833931 → 7837735 → 7877359", () => {
    const [first, second] = segmentsOf(38);
    expect.soft(at(confirmedSolo(7817596)?.startAt), "open = post time").toBe(at(first?.[0]));
    expect
      .soft(
        carries(interruptionEvidence(load(7833931)), ["suspend"], first?.[1] ?? null),
        "6/23 4:59:59 suspension",
      )
      .toBe(true);
    const reopen = interruptionEvidence(load(7837735));
    expect
      .soft(carries(reopen, ["reopen"], second?.[0] ?? null), "7/3 12:00 reopen start")
      .toBe(true);
    expect
      .soft(carries(reopen, ["reopen"], second?.[1] ?? null), "7/8 04:59:59 reopen end")
      .toBe(true);
    const confirmed = confirmedSolo(7877359);
    expect
      .soft([at(confirmed?.startAt), at(confirmed?.endAt)])
      .toEqual([at(second?.[0]), at(second?.[1])]);
  });

  it("'점검 완료 후' resolves to the G maintenance end or asks, never guesses", () => {
    const post = {
      title: "솔로 레이드 오픈 예정",
      body: "✅ 진행 기간\n- 7/3(목) 점검 완료 후 ~ 7/10(목) 4:59",
      postedAt: "2025-06-27T17:00:00+09:00",
    };
    expect(judgeSolo(post, heads)).toEqual({
      action: "confirmed",
      startAt: "2025-07-03T16:00:00+09:00",
      endAt: "2025-07-10T04:59:59+09:00",
      maintenanceEventId: "6276795",
    });
    expect(judgeSolo(post, [])).toMatchObject({
      action: "decision",
      reason: "maintenance_missing",
    });
    expect(
      judgeSolo(post, [
        ...heads,
        { id: "x", startAt: "2025-07-03T20:00:00+09:00", endAt: "2025-07-03T21:00:00+09:00" },
      ]),
    ).toMatchObject({ action: "decision", reason: "maintenance_multiple" });
  });

  it("assumes no weekday (Tuesday S29, Friday S35 and the Friday S38 reopen)", () => {
    const weekday = (instant: string | undefined) =>
      new Date((at(instant) ?? Number.NaN) + 9 * 3_600_000).getUTCDay();
    expect([6674249, 7409051, 7877359].map((id) => weekday(confirmedSolo(id)?.startAt))).toEqual([
      2, 5, 5,
    ]);
  });

  it("expected season starts S19–S40 agree with the official history", () => {
    const mismatches = solo.seasons
      .filter((item) => item.season <= 40)
      .filter(
        (item) =>
          gameDay(item.segments[0]?.[0] ?? "invalid") !==
          SOLO_RAID_ROUND_HISTORY[item.season - 1]?.startGameDate,
      );
    expect(mismatches).toEqual([]);
  });
});

// ---------------------------------------------------------------- T07 collaborations
type CollabPost = {
  feedId: number;
  action: "ignore" | "evidence" | "create" | "link" | "decision";
  alsoAccept?: string;
  collaboration?: string;
  overlaps?: string[];
  scripted?: string;
  reason: string;
};
type CollabExpected = {
  posts: CollabPost[];
  collaborations: {
    key: string;
    name: string;
    startAt: string;
    endAt: string;
  }[];
  backtestCount: number;
};
const collabs = readJson<CollabExpected>("forecast-v2/expected/collaborations.json");
const collabByKey = new Map(collabs.collaborations.map((item) => [item.key, item]));
const chronological = [...collabs.posts]
  .sort((a, b) => byPostTime(a.feedId, b.feedId))
  .map((item, index) => ({ ...item, index }));
/** Windows that exist before post `index`, taken from the expected trace (scripted decisions = new). */
function existingBefore(index: number): ExistingWindow[] {
  const keys = new Set(
    chronological
      .slice(0, index)
      .filter((item) => item.action === "create" || item.action === "decision")
      .flatMap((item) => (item.collaboration ? [item.collaboration] : [])),
  );
  return [...keys].flatMap((key) => {
    const window = collabByKey.get(key);
    return window ? [{ id: key, startAt: window.startAt, endAt: window.endAt }] : [];
  });
}

describe("T07 collaborations", () => {
  it("covers every D search hit", () => {
    expect(collabs.posts.map((item) => item.feedId).sort()).toEqual([...searchIds("D")].sort());
  });

  it.each(chronological)("$feedId → $action", (item) => {
    const result = judgeCollaboration(load(item.feedId), heads, existingBefore(item.index));
    expect([item.action, item.alsoAccept], item.reason).toContain(result.action);
    const window = item.collaboration ? collabByKey.get(item.collaboration) : undefined;
    if (result.action === "create") {
      expect([at(result.startAt), at(result.endAt)]).toEqual([
        at(window?.startAt),
        at(window?.endAt),
      ]);
    }
    if (result.action === "link") expect(result.eventId).toBe(item.collaboration);
    if (result.action === "decision" && item.overlaps) {
      expect(result.reason).toBe("collaboration_overlap");
      expect(result.candidates).toEqual(item.overlaps);
    }
  });

  it("creates exactly the 6 collaborations (7660727 archive stays an uncounted decision, U22)", () => {
    const created: string[] = [];
    for (const item of chronological) {
      const result = judgeCollaboration(load(item.feedId), heads, existingBefore(item.index));
      if (result.action === "create")
        created.push(
          `${gameDay(result.startAt)} ${new Date(Date.parse(result.startAt)).toISOString()}`,
        );
      if (result.action === "decision" && item.scripted === "new" && item.collaboration) {
        const window = collabByKey.get(item.collaboration);
        if (window)
          created.push(
            `${gameDay(window.startAt)} ${new Date(Date.parse(window.startAt)).toISOString()}`,
          );
      }
    }
    const expected = collabs.collaborations.map(
      (item) => `${gameDay(item.startAt)} ${new Date(Date.parse(item.startAt)).toISOString()}`,
    );
    expect(created.sort()).toEqual(expected.sort());
    expect(created.length).toBe(collabs.backtestCount);
    expect(collabs.backtestCount).toBe(6);
  });

  it.each(collabs.collaborations)("$key ends 04:59:59 after 28 included game days", (item) => {
    expect(at(collaborationEnd(item.startAt))).toBe(at(item.endAt));
  });

  it("excludes Pick Up / PickUp / 픽업 titles only (U8 changed)", () => {
    for (const title of [
      "콜라보 기간 한정 Pick Up 모집 예고",
      "PickUp 안내",
      "pick  up",
      "PICK UP",
      "콜라보 픽업 모집 예고",
    ])
      expect(excludedCollaborationTitle(title), title).toBe(true);
    expect(excludedCollaborationTitle("콜라보 이벤트 진행 중!")).toBe(false);
    const bodyOnly = judgeCollaboration(
      {
        title: "콜라보 안내",
        body: "기간 한정 Pick Up 모집\n7/3(목) 니어 콜라보 재등장 예정",
        postedAt: "2025-06-24T12:00:39+09:00",
      },
      heads,
      [],
    );
    expect(bodyOnly.action).toBe("create");
  });
});
