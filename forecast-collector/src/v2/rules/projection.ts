import { predictMedianSoloRaid as predictSharedMedian } from "../../../../shared/soloRaidCadence";
import { addGameDays, calendarRange, gameDayEnd, gameDayStart } from "./game-day";

export function predictMedianSoloRaid(input: Parameters<typeof predictSharedMedian>[0]) {
  return predictSharedMedian(input);
}

export type CalendarEvent = {
  id: string;
  revision: number;
  kind: "solo" | "maintenance" | "collaboration";
  status: "confirmed" | "predicted" | "pending" | "cancelled";
  label: string;
  startAt: string;
  endAt: string;
};
export type CalendarGrant = { id: string; gameDay: string; ii: number; box: number };
/** Supply from the existing shared co-op implementation, never recomputed here. */
export type CoopSupply = { gameDay: string; ii: number };
export type ProjectedDay = {
  /** Volatile admin notes; excluded from snapshot identity and semantic diffs. */
  coverage?: string[];
  pending?: string[];
  gameDay: string;
  events: CalendarEvent[];
  grants: CalendarGrant[];
  ii: number;
  box: number;
  coop?: 0 | 5 | 10;
};
export type SemanticChange = {
  kind: CalendarEvent["kind"] | "grant";
  label: string;
  change: "added" | "removed" | "changed";
  before?: string;
  after?: string;
};

export function projectCalendar(
  now: string,
  events: readonly CalendarEvent[],
  grants: readonly CalendarGrant[],
  coop: readonly CoopSupply[],
): ProjectedDay[] {
  const { start, end } = calendarRange(now);
  const days: ProjectedDay[] = [];
  for (let day = start; day <= end; day = addGameDays(day, 1)) {
    const from = Date.parse(gameDayStart(day));
    const until = Date.parse(gameDayEnd(day));
    const dayGrants = grants
      .filter((grant) => grant.gameDay === day)
      .sort((a, b) => a.id.localeCompare(b.id));
    const coopTotal = coop
      .filter((supply) => supply.gameDay === day)
      .reduce((sum, supply) => sum + supply.ii, 0);
    if (coopTotal !== 0 && coopTotal !== 5 && coopTotal !== 10)
      throw new Error("calendar_coop_invalid");
    days.push({
      gameDay: day,
      events: events
        .filter(
          (event) =>
            event.status !== "cancelled" &&
            Date.parse(event.startAt) <= until &&
            Date.parse(event.endAt) >= from,
        )
        .sort((a, b) => a.id.localeCompare(b.id)),
      grants: dayGrants,
      coop: coopTotal,
      ii: dayGrants.reduce((sum, grant) => sum + grant.ii, 0) + coopTotal,
      box: dayGrants.reduce((sum, grant) => sum + grant.box, 0),
    });
  }
  return days;
}

function semanticItems(events: readonly CalendarEvent[], grants: readonly CalendarGrant[]) {
  const items = new Map<string, { kind: SemanticChange["kind"]; label: string; value: string }>();
  for (const event of events) {
    if (event.status === "cancelled") continue;
    items.set(`event:${event.id}`, {
      kind: event.kind,
      label: event.label,
      value: JSON.stringify({
        status: event.status,
        label: event.label,
        startAt: new Date(event.startAt).toISOString(),
        endAt: new Date(event.endAt).toISOString(),
      }),
    });
  }
  for (const grant of grants)
    items.set(`grant:${grant.id}`, {
      kind: "grant",
      label: grant.gameDay,
      value: JSON.stringify({ gameDay: grant.gameDay, ii: grant.ii, box: grant.box }),
    });
  return items;
}

/**
 * Compare full semantic state, not rolling viewport contents. Revision-only,
 * timestamp-format-only, and day-roll changes are deliberately quiet.
 * A null previous state is bootstrap and must not send an update.
 */
export function semanticDiff(
  before: { events: readonly CalendarEvent[]; grants: readonly CalendarGrant[] } | null,
  after: { events: readonly CalendarEvent[]; grants: readonly CalendarGrant[] },
): SemanticChange[] {
  if (!before) return [];
  const previous = semanticItems(before.events, before.grants);
  const next = semanticItems(after.events, after.grants);
  const changes: SemanticChange[] = [];
  for (const key of [...new Set([...previous.keys(), ...next.keys()])].sort()) {
    const old = previous.get(key);
    const current = next.get(key);
    if (old?.value === current?.value) continue;
    const item = current ?? old;
    if (!item) continue;
    changes.push({
      kind: item.kind,
      label: item.label,
      change: !old ? "added" : !current ? "removed" : "changed",
      ...(old ? { before: old.value } : {}),
      ...(current ? { after: current.value } : {}),
    });
  }
  return changes;
}
