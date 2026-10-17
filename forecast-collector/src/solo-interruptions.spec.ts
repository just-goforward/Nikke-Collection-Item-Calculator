import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { buildForecastCandidate, resolveSoloSchedule } from "./candidate";
import { parseKoreanDateRange, parseScheduleEvents } from "./naver";
import { parseNoticeDetail } from "./notice";
import { collapseSoloSegments } from "./solo-interruptions";
import { noticeTexts } from "./solo-sections";
import type { ScheduleEvent } from "./types";

async function item(id: number) {
  const payload = JSON.parse(
    readFileSync(new URL(`../fixtures/naver-detail-${id}.json`, import.meta.url), "utf8"),
  );
  const parsed = await parseNoticeDetail(payload, payload.content.board.boardId, String(id));
  if (!parsed) throw new Error("fixture_missing");
  return parsed;
}
async function initial(): Promise<ScheduleEvent> {
  const source = await item(7833931);
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
it("links the suspension and reopen to r38 without inventing a new cadence start", async () => {
  const original = await initial();
  const suspension = await parseScheduleEvents([await item(7833931)], { known: [original] });
  expect(suspension[0]?.segment).toEqual({
    round: 38,
    segment: 1,
    kind: "suspend",
    effectiveFrom: "2026-06-18T03:00:00.000Z",
    effectiveUntil: "2026-06-22T19:59:59.000Z",
  });
  const reopen = await parseScheduleEvents([await item(7837735)], {
    known: [original, ...suspension],
  });
  const text = noticeTexts.get(await item(7837735))?.effective ?? "";
  expect(parseKoreanDateRange(text, "2026-06-23T00:00:00Z")).toEqual({
    start: "2026-07-03T03:00:00.000Z",
    end: "2026-07-07T19:59:00.000Z",
  });
  expect(suspension[0]?.sourceItem.normalizedText).toContain("애니힐리오");
  expect(reopen[0]?.manualReview).toBe(false);
  expect(reopen[0]?.segment).toEqual({
    round: 38,
    segment: 2,
    kind: "reopen",
    effectiveFrom: "2026-07-03T03:00:00.000Z",
    effectiveUntil: "2026-07-07T19:59:00.000Z",
  });
  const events = [original, ...suspension, ...reopen];
  expect(collapseSoloSegments(events)).toHaveLength(1);
  const now = Date.parse("2026-06-28T03:00:00Z");
  const resolved = resolveSoloSchedule(events, now);
  expect(resolved?.event.segments).toHaveLength(2);
  if (!resolved) throw new Error("round_missing");
  const built = await buildForecastCandidate(
    resolved,
    events,
    { status: "x_unavailable", sourceItem: null, reason: null },
    now,
    1,
  );
  expect(built.candidate.schedule.soloStart).toBe("2026-07-03T03:00:00.000Z");
  expect(built.candidate.schedule.soloPeriods.filter((period) => period.round === 38)).toHaveLength(
    2,
  );
  expect(built.candidate.sourceEvidence.map((source) => source.itemId)).toEqual(
    expect.arrayContaining(["7833931", "7837735"]),
  );
});
it.each([7860406, 7877359])(
  "links reopen evidence %s only to a persisted suspension",
  async (id) => {
    const original = await initial();
    const suspension = await parseScheduleEvents([await item(7833931)], { known: [original] });
    const events = await parseScheduleEvents([await item(id)], { known: suspension });
    expect(events.find((event) => event.segment?.round === 38)?.segment?.segment).toBe(2);
    expect((await parseScheduleEvents([await item(id)]))[0]?.reason).toBe(
      "reopen_without_suspension",
    );
  },
);
it("does not infer a suspension season without active evidence", async () => {
  expect((await parseScheduleEvents([await item(7833931)]))[0]?.reason).toBe(
    "suspension_without_known_season",
  );
});
