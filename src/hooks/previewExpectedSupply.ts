import { certifiedCohortWeights, expectedCertifiedRefs, isCertifiedEventModeled } from "../../shared/certifiedSupply";
import { add, toNumber, ZERO, type Q } from "../../shared/certifiedRational";
import { CERTIFIED_RECOMMENDED_HORIZON_DAYS } from "../../shared/certifiedHorizon";
import { nextReceiptPhase, receiptDay } from "../../shared/receiptClock";
import { futureEvents } from "../certified/events";
import type { ServiceH14Input } from "../serviceH14/types";
import type { PreviewTimedSupply } from "../ui-types";

type SupplyInput = Pick<ServiceH14Input,
  "asOf" | "snapshot" | "forecastPublication" | "previewJoint" | "cohortWeights" | "receivedEventIds">;

/** Display the authenticated request's uncapped physical arrivals, not input stock. */
export function previewTimedSupply(input: SupplyInput): PreviewTimedSupply | null {
  if (!input.forecastPublication?.artifact || (!input.previewJoint && (input.snapshot.sourceStatus !== "healthy" ||
      !input.snapshot.coverage.future.complete))) return null;
  try {
    const grouped = new Map<string, ServiceH14Input["snapshot"]["events"][number]["refs"][number][]>();
    for (const event of futureEvents(input)) {
      const at = new Date(event.at).toISOString();
      const group = grouped.get(at);
      if (group) group.push(...event.refs);
      else grouped.set(at, [...event.refs]);
    }
    const weights = certifiedCohortWeights(input.cohortWeights, input.snapshot.version);
    const total: [Q, Q, Q] = [ZERO, ZERO, ZERO];
    const display = ([blue, purple, yellow]: [Q, Q, Q]): [number, number, number] =>
      [toNumber(blue), toNumber(purple), toNumber(yellow)];
    const arrivals = Array.from(grouped, ([at, refs]) => {
      const pieces = expectedCertifiedRefs(refs, weights, { laws: input.snapshot.laws });
      for (const k of [0, 1, 2] as const) total[k] = add(total[k], pieces[k]);
      return { at, pieces: display(pieces), cumulative: display(total) };
    });
    return { asOf: input.asOf, conditional: !!input.previewJoint, arrivals };
  } catch {
    // Optional presentation must never replace a validated Current or final result.
    return null;
  }
}

/** First entry into or exit from the live table, including receipts not yet visible. */
export function nextSupplyTimelineChange({ asOf, snapshot }: Pick<SupplyInput, "asOf" | "snapshot">): number {
  const now = Date.parse(asOf);
  let next = Infinity;
  for (const event of snapshot.events) {
    const at = Date.parse(event.at);
    if (!(at > now) || !isCertifiedEventModeled(snapshot, event, asOf)) continue;
    next = Math.min(next, receiptDay(now, at) > CERTIFIED_RECOMMENDED_HORIZON_DAYS
      ? nextReceiptPhase(now, at) : at);
  }
  return next;
}
