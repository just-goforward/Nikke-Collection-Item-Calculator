import { expect, it } from "vitest";
import { collaborationOptions, windowOptions } from "./schedule-options";

it("keeps distinct actionable windows and collapses duplicate evidence", () => {
  const window = { startAt: "2026-06-25T08:00:00+09:00", endAt: "2026-06-25T16:00:00+09:00" };
  expect(windowOptions([window, window])).toEqual([
    { ...window, id: "window_0", label: "2026-06-25 08:00:00 ~ 2026-06-25 16:00:00 (KST)" },
  ]);
});

it("renders UTC instants as KST without changing the schedule", () => {
  const window = { startAt: "2025-07-03T02:00:00Z", endAt: "2025-07-09T19:59:59Z" };
  expect(windowOptions([window])[0]).toEqual({
    ...window,
    id: "window_0",
    label: "2025-07-03 11:00:00 ~ 2025-07-10 04:59:59 (KST)",
  });
});

it("offers each same-day maintenance resolution for an unresolved collaboration", () => {
  const options = collaborationOptions(
    {
      title: "콜라보",
      body: "진행 기간\n6/25 점검 완료 후",
      postedAt: "2026-06-24T08:00:00+09:00",
    },
    [
      { id: "m1", startAt: "2026-06-25T05:00:00+09:00", endAt: "2026-06-25T12:00:00+09:00" },
      { id: "m2", startAt: "2026-06-25T05:00:00+09:00", endAt: "2026-06-25T16:00:00+09:00" },
    ],
  );
  expect(options.map((option) => option.startAt)).toEqual([
    "2026-06-25T12:00:00+09:00",
    "2026-06-25T16:00:00+09:00",
  ]);
  expect(options.map((option) => Date.parse(option.endAt!))).toEqual([
    Date.parse("2026-07-23T04:59:59+09:00"),
    Date.parse("2026-07-23T04:59:59+09:00"),
  ]);
});
