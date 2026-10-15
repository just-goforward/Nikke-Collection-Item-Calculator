import type { CertifiedInput } from "../certified/types.ts";
import { prepareCertifiedForecast } from "../lib/certifiedForecast.ts";

export async function certifiedWorkerFixture(waiting = false): Promise<CertifiedInput> {
  // The bundled approved forecast is certified-daily-v3 from 2026-10-07T20:00Z; earlier
  // days have no current supply rule and are refused. Wednesday 12:00 KST: today's
  // dispatch and the 05:00 KST weekly grant are both received.
  const asOf = "2026-10-14T12:00:00+09:00";
  const snapshot = await prepareCertifiedForecast(asOf);
  return {
    grade: "SR",
    level: 14,
    exp: 2900,
    stock: [10, 0, 0],
    asOf,
    snapshot,
    receivedEventIds: snapshot.events
      .filter((event) => event.gameDate === snapshot.coverage.currentDay)
      .map((event) => event.id),
    computeWaiting: waiting,
  };
}
