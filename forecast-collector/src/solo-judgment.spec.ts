import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseKoreanDateRange, parseScheduleEvents } from "./naver";
import { parseNoticeDetail } from "./notice";
import { judgeSolo } from "./solo-judgment";
import { extractNoticeText, noticeTexts, soloSections } from "./solo-sections";
import type { ScheduleEvent } from "./types";

async function captured(id: string) {
  const payload = JSON.parse(
    readFileSync(new URL(`../fixtures/naver-detail-${id}.json`, import.meta.url), "utf8"),
  );
  const item = await parseNoticeDetail(payload, payload.content.board.boardId, id);
  if (!item) throw new Error("fixture missing item");
  return item;
}

it("keeps 종료 changes and legacy reopen notices held", async () => {
  const item = await captured("7877359");
  noticeTexts.delete(item);
  expect((await parseScheduleEvents([item]))[0]?.manualReview).toBe(true);
  const cooperation = { ...item, normalizedText: "협동작전 재오픈 안내. 7/3 12:00 ~ 7/8 4:59" };
  expect((await parseScheduleEvents([cooperation]))[0]).toMatchObject({
    eventType: "cooperation",
    manualReview: false,
  });
  const ended = { ...item, normalizedText: "솔로 레이드 종료 안내. 7/3 12:00 ~ 7/8 4:59" };
  expect(judgeSolo(ended, parseKoreanDateRange)?.[0]?.reason).toBe("schedule_change_in_section");
});

it("does not invent a start instant or use maintenance from another year", async () => {
  const item = await captured("7699562");
  const previousYear = await captured("7709605");
  const result = judgeSolo(item, parseKoreanDateRange, {
    maintenance: [{ text: previousYear.normalizedText, publishedAt: "2025-05-28T00:00:00Z" }],
  })?.[0];
  expect(result?.reason).toBe("maintenance_missing");
  expect(result?.comparison).toMatchObject({
    known: null,
    extracted: { startsAt: null, startKst: "2026-05-28 점검 완료 후(시각 미확정)" },
    equal: false,
  });
});

it.each(["······", "──────", "10. 협동작전"])(
  "keeps nested numbering but ends a solo section at %s",
  (boundary) => {
    const text = extractNoticeText(
      `<p>9. 솔로 레이드 -</p><p>(1) 도전 난이도</p><p>1) 보상 안내</p>
       <p>▶ 이벤트 진행 기간 : 9/24 12:00 ~ 10/1 4:59</p>
       <p>${boundary}</p><p>다른 이벤트 중단 및 연장 안내</p>`,
    );
    const sections = soloSections(text);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.effective).toContain("(1) 도전 난이도");
    expect(sections[0]?.effective).toContain("1) 보상 안내");
    expect(sections[0]?.effective).not.toMatch(/중단|연장/);
  },
);

it("does not classify unrelated extension, suspension or ending sentences in 8189601", async () => {
  const item = await captured("8189601");
  expect(item.normalizedText).toMatch(/연장/);
  expect(item.normalizedText).toMatch(/중단/);
  expect(item.normalizedText).toMatch(/종료/);
  const result = judgeSolo(item, parseKoreanDateRange);
  expect(result).toHaveLength(1);
  expect(result?.[0]?.event?.eventType).toBe("solo");
  expect(result?.[0]?.reason).toBeNull();
});

it.each([
  ["8189601", "2026-09-24T03:00:00Z", "2026-09-30T19:59:00Z"],
  ["8289927", "2026-10-15T03:00:00Z", "2026-10-21T19:59:00Z"],
])(
  "recognizes %s as unchanged despite unrelated extension and suspension wording",
  async (id, start, end) => {
    const item = await captured(id);
    const known: ScheduleEvent = {
      eventId: "known",
      eventType: "solo",
      sourceItem: { ...item, itemId: "known-other-notice" },
      startsAt: start,
      endsAt: end,
      scheduleStatus: "confirmed",
      manualReview: false,
      reason: null,
    };
    const result = judgeSolo(item, parseKoreanDateRange, { known: [known] });
    expect(result?.[0]?.verdict).toBe("no_change");
    expect(result?.[0]?.comparison.equal).toBe(true);
    expect(result?.[0]?.event).toBeUndefined();
  },
);

it("uses stored maintenance and compares the start game date rather than exact start instant", async () => {
  const maintenance = await captured("7709605");
  const item = await captured("7699562");
  const resolved = judgeSolo(maintenance, parseKoreanDateRange)?.[0]?.event;
  if (!resolved) throw new Error("maintenance fixture unresolved");
  const result = judgeSolo(item, parseKoreanDateRange, {
    known: [resolved],
    maintenance: [{ text: maintenance.normalizedText, publishedAt: maintenance.publishedAt }],
  });
  expect(result?.[0]?.verdict).toBe("no_change");
  expect(result?.[0]?.comparison.extracted?.startsAt).toBe("2026-05-28T06:00:00.000Z");
  expect(result?.[0]?.blockExcerpt).toContain("~~12:00~~");
});

it.each([
  ["8189601", ["solo"]],
  ["8289927", ["solo"]],
  ["7709605", ["solo"]],
  ["7699562", ["maintenance_missing"]],
  ["7860406", ["reopen_unsupported", "solo"]],
  ["7877359", ["reopen_unsupported"]],
])("extracts solo judgments from captured notice %s", async (id, expected) => {
  const payload = JSON.parse(
    readFileSync(new URL(`../fixtures/naver-detail-${id}.json`, import.meta.url), "utf8"),
  );
  const item = await parseNoticeDetail(payload, payload.content.board.boardId, id as string);
  if (!item) throw new Error("fixture missing item");
  noticeTexts.set(item, extractNoticeText(payload.content.feed.contents));
  const result = judgeSolo(item, parseKoreanDateRange);
  expect(result?.map((judgment) => judgment.reason ?? judgment.verdict)).toEqual(expected);
  if (id === "7709605") expect(result?.[0]?.event?.startsAt).toBe("2026-05-28T06:00:00.000Z");
});
