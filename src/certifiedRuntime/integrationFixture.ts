import type { CertifiedInput } from "../certified/types.ts";
import { prepareCertifiedForecast } from "../lib/certifiedForecast.ts";

export async function certifiedWorkerFixture(waiting = false): Promise<CertifiedInput> {
  const asOf = "2026-09-30T12:00:00+09:00";
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
