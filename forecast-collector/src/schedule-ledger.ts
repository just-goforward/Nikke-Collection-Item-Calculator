import { loadScheduleEvents, nextForecastRevision } from "./db";

export async function readScheduleLedger(db: D1Database, nowMs: number) {
  const gameDay = new Date(nowMs + 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return {
    gameDay,
    nextRevision: await nextForecastRevision(db, gameDay),
    events: await loadScheduleEvents(db),
  };
}
