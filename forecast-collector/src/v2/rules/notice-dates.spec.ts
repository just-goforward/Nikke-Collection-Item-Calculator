import { expect, it } from "vitest";
import { grantDateCandidates, noticeDates } from "./notice-dates";

const posted = "2026-06-25T17:00:00+09:00";
it("preserves maintenance and date-only precision and inclusive ends", () => {
  expect(noticeDates("6/25(목) 점검 완료 후", posted)[0]).toMatchObject({
    date: "2026-06-25",
    instant: null,
    maintenance: true,
  });
  expect(noticeDates("6/25(목) 4:59", posted, true)[0]?.instant).toBe("2026-06-25T04:59:59+09:00");
});
it("prefers explicit payment over other schedules", () => {
  expect(
    grantDateCandidates("중단 일시: 6/25 17:00\n보상 지급일: 6/26 00:00", posted),
  ).toMatchObject([{ basis: "explicit_payment", instant: "2026-06-26T00:00:00+09:00" }]);
});
it("retains competing suspension and extension schedules for a decision", () => {
  expect(
    grantDateCandidates("중단 일시: 8/26 17:00 ~ 21:00\n연장 일시: 8/26 21:00 ~ 9/1 4:59", posted),
  ).toHaveLength(2);
});
it("excludes claim deadlines and title-edit notes", () => {
  expect(grantDateCandidates("수령 기한: 6/30 23:59\n(6/25 내용 수정)", posted)).toMatchObject([
    { basis: "post_created", instant: posted },
  ]);
});
