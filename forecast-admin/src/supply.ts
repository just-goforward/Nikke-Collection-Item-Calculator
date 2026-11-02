import { certifiedCohortWeights, createCertifiedSupplyRule, expectedCertifiedRefs } from "../../shared/certifiedSupply.ts";
import { add, type Q, ZERO } from "../../shared/certifiedRational.ts";
import { gameDay } from "../../forecast-collector/src/v2/rules/game-day.ts";
import type { ActiveCalendar } from "./calendar.ts";

/** Adds only missing sources; co-op and notice grants already belong to snapshot kits. */
export function calendarSupply(calendar: ActiveCalendar, days: readonly string[]) {
  const rule = createCertifiedSupplyRule(days[0] ?? calendar.rangeStart);
  const daily = expectedCertifiedRefs(rule.dispatch, certifiedCohortWeights(), {});
  const dispatch: [Q, Q, Q] = [ZERO, ZERO, ZERO];
  let soloII = 0;
  let soloBox = 0;
  let coveredDays = 0;
  for (const day of days) {
    const data = calendar.days.get(day);
    if (!data) continue;
    coveredDays++;
    for (const k of [0, 1, 2] as const) dispatch[k] = add(dispatch[k], daily[k]);
    for (const id of new Set(data.eventIds)) {
      const event = calendar.events.get(id);
      if (!event || event.kind !== "solo" || !event.startsAt ||
        (event.status !== "confirmed" && event.status !== "predicted") ||
        /_alternative$/.test(event.eventId)) continue;
      const start = gameDay(event.startsAt);
      const index = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000);
      if (index < 0 || (event.endsAt && Date.parse(`${day}T05:00:00+09:00`) >= Date.parse(event.endsAt))) continue;
      for (const ref of rule.soloDays[index] ?? []) {
        if (ref.lawId === "box-ii-v1") soloII += ref.count;
        if (ref.lawId === "regular-box-v1") soloBox += ref.count;
      }
    }
  }
  return { dispatch, soloII, soloBox, coveredDays, missingDays: days.length - coveredDays };
}
