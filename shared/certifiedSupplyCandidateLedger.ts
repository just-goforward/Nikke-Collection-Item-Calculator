import { assertSupplyCoherence } from "./certifiedSupplyCoherence.ts";
import type { CertifiedSupplySnapshot } from "./certifiedSupplyModel.ts";
import { dateStart, timestamp } from "./certifiedSupplyModel.ts";
import type {
  SupplyForecastGrant,
  SupplyForecastSoloPeriod,
} from "./supplyForecastCandidateSchemas.ts";

function normalizedRefs(
  refs: SupplyForecastGrant["refs"] | CertifiedSupplySnapshot["events"][number]["refs"],
) {
  const counts = new Map<string, number>();
  for (const ref of refs) counts.set(ref.lawId, (counts.get(ref.lawId) ?? 0) + ref.count);
  return JSON.stringify([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

/** Publication-only cross-check of collector claims against the adopted event ledger. */
export function assertCandidateLedger(
  snapshot: CertifiedSupplySnapshot,
  periods: readonly SupplyForecastSoloPeriod[],
  grants: readonly SupplyForecastGrant[],
): void {
  assertSupplyCoherence(snapshot);
  assertPeriodLedger(snapshot, periods);
  assertGrantLedger(snapshot, grants);
}

function assertPeriodLedger(
  snapshot: CertifiedSupplySnapshot,
  periods: readonly SupplyForecastSoloPeriod[],
) {
  for (const period of periods) {
    const round = snapshot.soloRounds.find((entry) => entry.round === period.round);
    const segment = round?.segments?.find((entry) => entry.segment === period.segment);
    if (
      segment &&
      (timestamp(segment.effectiveFrom) !== timestamp(period.effectiveFrom) ||
        timestamp(segment.effectiveUntil) !== timestamp(period.effectiveUntil))
    )
      throw new Error("forecast_segment_ledger_mismatch");
    if (
      !round ||
      (!segment &&
        (period.segment !== 1 ||
          round.segments !== undefined ||
          timestamp(period.effectiveFrom) !== dateStart(round.startGameDate) ||
          round.endGameDate === null ||
          timestamp(period.effectiveUntil) !== dateStart(round.endGameDate)))
    )
      throw new Error("forecast_segment_ledger_missing");
  }
  assertAllSegmentsClaimed(snapshot, periods);
}

function assertAllSegmentsClaimed(
  snapshot: CertifiedSupplySnapshot,
  periods: readonly SupplyForecastSoloPeriod[],
) {
  for (const round of snapshot.soloRounds)
    for (const segment of round.segments ?? [])
      if (
        !periods.some(
          (period) => period.round === round.round && period.segment === segment.segment,
        )
      )
        throw new Error("forecast_segment_ledger_missing");
}

function assertGrantLedger(
  snapshot: CertifiedSupplySnapshot,
  grants: readonly SupplyForecastGrant[],
) {
  const ids = new Set<string>();
  for (const grant of grants) {
    if (ids.has(grant.id)) throw new Error("forecast_grant_duplicate");
    ids.add(grant.id);
    const at = dateStart(grant.grantGameDate);
    if (at < timestamp(snapshot.coverage.from) || at >= timestamp(snapshot.coverage.until))
      continue;
    const event = snapshot.events.find((entry) => entry.id === grant.id);
    assertGrantMatch(event, grant, at);
  }
  if (snapshot.events.some((event) => event.kind === "grant" && !ids.has(event.id)))
    throw new Error("forecast_grant_ledger_missing");
}

function assertGrantMatch(
  event: CertifiedSupplySnapshot["events"][number] | undefined,
  grant: SupplyForecastGrant,
  at: number,
) {
  if (
    !event ||
    event.kind !== "grant" ||
    event.gameDate !== grant.grantGameDate ||
    timestamp(event.at) !== at ||
    (event.expiresAt === undefined) !== (grant.claimUntil === undefined) ||
    (grant.claimUntil !== undefined &&
      timestamp(event.expiresAt as string) !== timestamp(grant.claimUntil)) ||
    event.claimWindowAssumed !== grant.claimWindowAssumed ||
    normalizedRefs(event.refs) !== normalizedRefs(grant.refs) ||
    JSON.stringify(event.sourceIds) !== JSON.stringify(grant.sourceIds) ||
    JSON.stringify(event.restatementOf) !== JSON.stringify(grant.restatementOf)
  )
    throw new Error("forecast_grant_ledger_mismatch");
}
