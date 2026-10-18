import type { resolveSoloSchedule } from "./candidate";
import { runtimeSourceIdentity } from "./runtime-events";
import type { NormalizedSourceItem, ScheduleEvent } from "./types";

export function hasSegmentedEvents(events: readonly ScheduleEvent[]) {
  return events.some((event) => event.segment || event.segments);
}

// Frozen items loaded from immutable revision rows can use the row's complete
// identity. Other items retain their full JSON record. No body truncation or
// content heuristic is used, and every event field remains in the key.
export function candidateCacheEvents(
  events: readonly ScheduleEvent[],
  resolved: NonNullable<ReturnType<typeof resolveSoloSchedule>>,
) {
  const items: (NormalizedSourceItem | { immutableRevision: string })[] = [];
  const indices = new Map<string, number>();
  const encode = (event: ScheduleEvent) => {
    const revision = runtimeSourceIdentity(event.sourceItem);
    const json =
      revision === undefined ? `json:${JSON.stringify(event.sourceItem)}` : `revision:${revision}`;
    let index = indices.get(json);
    if (index === undefined) {
      index = items.length;
      indices.set(json, index);
      items.push(revision === undefined ? event.sourceItem : { immutableRevision: revision });
    }
    return { ...event, sourceItem: index };
  };
  const encodedEvents = events.map(encode);
  const encodedResolved = {
    ...resolved,
    event: encode(resolved.event),
    soloEvents: resolved.soloEvents.map(encode),
    evidenceEvents: resolved.evidenceEvents.map(encode),
  };
  return { events: encodedEvents, resolved: encodedResolved, items };
}
