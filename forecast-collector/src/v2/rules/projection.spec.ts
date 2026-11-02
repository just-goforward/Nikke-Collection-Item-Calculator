import { expect, it } from "vitest";
import { type CalendarEvent, projectCalendar, semanticDiff } from "./projection";

const event: CalendarEvent = {
  id: "solo:42",
  revision: 1,
  kind: "solo",
  status: "confirmed",
  label: "S42",
  startAt: "2026-10-15T12:00:00+09:00",
  endAt: "2026-10-22T04:59:59+09:00",
};
it("projects an inclusive rolling month and assigns 04:59:59 to the preceding game day", () => {
  const days = projectCalendar(
    "2026-10-18T12:00:00+09:00",
    [event],
    [{ id: "grant:1", gameDay: "2026-10-20", ii: 5, box: 2 }],
    [{ gameDay: "2026-10-20", ii: 10 }],
  );
  expect(days).toHaveLength(32);
  expect(days.at(-1)?.gameDay).toBe("2026-11-18");
  expect(days.find((day) => day.gameDay === "2026-10-21")?.events).toHaveLength(1);
  expect(days.find((day) => day.gameDay === "2026-10-22")?.events).toHaveLength(0);
  expect(days.find((day) => day.gameDay === "2026-10-20")).toMatchObject({ ii: 15, box: 2 });
});
it("suppresses bootstrap, revision-only, ordering and timestamp-format changes", () => {
  const state = { events: [event], grants: [] };
  expect(semanticDiff(null, state)).toEqual([]);
  expect(
    semanticDiff(state, {
      events: [
        {
          ...event,
          revision: 2,
          startAt: "2026-10-15T03:00:00.000Z",
        },
      ],
      grants: [],
    }),
  ).toEqual([]);
});
it("detects changes and cancellations", () => {
  const before = { events: [event], grants: [] };
  expect(
    semanticDiff(before, { events: [{ ...event, status: "cancelled" }], grants: [] }),
  ).toMatchObject([{ kind: "solo", change: "removed" }]);
  expect(
    semanticDiff(before, {
      events: [{ ...event, endAt: "2026-10-23T04:59:59+09:00" }],
      grants: [],
    }),
  ).toMatchObject([{ kind: "solo", change: "changed" }]);
});
