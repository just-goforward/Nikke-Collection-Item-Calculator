import { expect, it } from "vitest";
import { certifiedCohortWeights, createCertifiedSupplyRule, expectedCertifiedRefs } from "../../shared/certifiedSupply.ts";
import { mul, q } from "../../shared/certifiedRational.ts";
import type { ActiveCalendar, CalendarEvent } from "./calendar.ts";
import { calendarSupply } from "./supply.ts";

it("counts seven raid days once, clips by real raid day, and keeps dispatch exact", () => {
  const days = Array.from({ length: 8 }, (_, i) => `2026-10-${String(10 + i)}`);
  const event: CalendarEvent = {
    eventId: "prediction_S43_primary", revision: 1, kind: "solo", status: "predicted",
    startsAt: "2026-10-10T03:00:00Z", endsAt: "2026-10-17T20:00:00Z",
    startGameDay: days[0]!, endGameDay: days[7]!, afterMaintenance: false, title: null, provenance: null,
  };
  const alternative = { ...event, eventId: "prediction_S43_alternative" };
  const calendar: ActiveCalendar = {
    version: 1, updatedAt: event.startsAt!, createdAt: event.startsAt!, snapshotId: "test",
    rangeStart: days[0]!, rangeEnd: days[7]!,
    events: new Map([[event.eventId, event], [alternative.eventId, alternative]]),
    days: new Map(days.map(day => [day, { gameDay: day, kits: { ii: 5, box: 0 },
      coop: 5, grants: [], pending: [], eventIds: [event.eventId, alternative.eventId] }])),
  };
  const full = calendarSupply(calendar, days);
  expect([full.soloBox, full.soloII]).toEqual([16, 68]);
  const daily = expectedCertifiedRefs(createCertifiedSupplyRule(days[0]!).dispatch, certifiedCohortWeights(), {});
  expect(full.dispatch).toEqual(daily.map(value => mul(value, q(8))));
  expect(calendarSupply(calendar, days.slice(2, 3)).soloII).toBe(12);
  expect(calendarSupply(calendar, days.slice(7)).soloII).toBe(0);
  event.endsAt = "2026-10-12T20:00:00Z";
  expect(calendarSupply(calendar, days.slice(3)).soloII).toBe(0);
  event.status = "pending";
  expect(calendarSupply(calendar, days).soloBox).toBe(0);
  calendar.days.delete(days[0]!);
  expect(calendarSupply(calendar, days).missingDays).toBe(1);
});
