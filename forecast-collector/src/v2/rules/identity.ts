import { collaborationEnd, gameDay } from "./game-day";

export type ExistingWindow = { id: string; startAt: string; endAt: string };
export type IdentityJudgment =
  | { action: "ignore" }
  | { action: "evidence" }
  | { action: "decision"; reason: string; candidates: string[] }
  | { action: "create"; startAt: string; endAt: string; maintenanceEventId?: string }
  | { action: "link"; eventId: string };

/** U8 operates only on the D post title, never on the collaboration body. */
export function excludedCollaborationTitle(title: string): boolean {
  return /pick\s*up|픽업/i.test(title);
}

/** U21: names/bosses/franchises never substitute for the approved start-day identity. */
export function collaborationIdentity(
  title: string,
  startAt: string | null,
  existing: readonly ExistingWindow[],
): IdentityJudgment {
  if (excludedCollaborationTitle(title)) return { action: "ignore" };
  if (!startAt) return { action: "evidence" };
  const endAt = collaborationEnd(startAt);
  const overlaps = existing.filter(
    (event) =>
      Date.parse(event.startAt) <= Date.parse(endAt) &&
      Date.parse(event.endAt) >= Date.parse(startAt),
  );
  if (!overlaps.length) return { action: "create", startAt, endAt };
  if (overlaps.length === 1 && gameDay(overlaps[0]!.startAt) === gameDay(startAt))
    return { action: "link", eventId: overlaps[0]!.id };
  return {
    action: "decision",
    reason: "collaboration_overlap",
    candidates: overlaps.map((event) => event.id),
  };
}

/** Call with current G heads only: obsolete revisions must not compete with corrections. */
export function resolveMaintenance(
  calendarDate: string,
  maintenance: readonly ExistingWindow[],
): { endAt: string; eventId: string } | { reason: "maintenance_missing" | "maintenance_multiple" } {
  const matches = maintenance.filter(
    (event) =>
      new Date(Date.parse(event.startAt) + 9 * 3_600_000).toISOString().slice(0, 10) ===
      calendarDate,
  );
  const event = matches[0];
  if (!event) return { reason: "maintenance_missing" };
  if (matches.length !== 1) return { reason: "maintenance_multiple" };
  return { endAt: event.endAt, eventId: event.id };
}

export type GrantIdentity = { id: string; gameDay: string; ii: number; box: number };
export function grantIdentity(
  grant: Omit<GrantIdentity, "id">,
  existing: readonly GrantIdentity[],
):
  | { action: "create" }
  | { action: "link"; grantId: string }
  | { action: "decision"; reason: "grant_quantity"; candidates: string[] } {
  const sameDay = existing.filter((item) => item.gameDay === grant.gameDay);
  const exact = sameDay.find((item) => item.ii === grant.ii && item.box === grant.box);
  if (exact) return { action: "link", grantId: exact.id };
  if (sameDay.length)
    return {
      action: "decision",
      reason: "grant_quantity",
      candidates: sameDay.map((item) => item.id),
    };
  return { action: "create" };
}
