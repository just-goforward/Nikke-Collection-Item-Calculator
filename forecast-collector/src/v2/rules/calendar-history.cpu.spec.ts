import { expect, it } from "vitest";
import { type CalendarEvent, projectCalendar } from "./projection";

it("projects populated calendar context within 50 ms CPU", () => {
  const events: CalendarEvent[] = Array.from({ length: 1000 }, (_, index) => ({
    id: `event_${index}`,
    revision: 1,
    kind: "solo",
    status: "confirmed",
    label: "History",
    startAt: index < 900 ? "2026-10-01T00:00:00.000Z" : "2026-11-13T00:00:00.000Z",
    endAt: index < 900 ? "2026-10-08T00:00:00.000Z" : "2026-11-14T00:00:00.000Z",
  }));
  const start = process.cpuUsage();
  const days = projectCalendar("2026-11-13T04:00:00.000Z", events, [], []);
  const cpu = process.cpuUsage(start);
  expect(days).toHaveLength(31);
  expect(days[0]?.events).toHaveLength(100);
  expect(days.slice(2).every((day) => day.events.length === 0)).toBe(true);
  expect((cpu.user + cpu.system) / 1000).toBeLessThanOrEqual(50);
});
