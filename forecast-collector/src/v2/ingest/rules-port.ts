import type { Stream } from "./schedule";

// Rules dependency injected by the Worker; production must supply every
// function, with no no-op fallback.
export type RulesPort = {
  applyPendingDecisions(db: D1Database, now: number): Promise<unknown>;
  processPostVersion(
    db: D1Database,
    input: { monitorId: Stream; feedId: string; versionId: string },
    now: number,
  ): Promise<{ calendarDirty: boolean; decisionRequests: number; grants: number }>;
  rebuildCalendar(
    db: D1Database,
    now: number,
  ): Promise<{ snapshotId: string | null; changed: boolean }>;
  dueEFollowUps(db: D1Database, now: number): Promise<number>;
};
