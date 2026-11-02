import { add, toWire, ZERO, type Q, type WireQ } from "./certifiedRational.ts";
import {
  assertCertifiedRuntimeSupplySnapshot,
  certifiedCohortWeights,
  expectedCertifiedRefs,
  isCertifiedEventModeled,
} from "./certifiedSupply.ts";
import type { CertifiedSupplyEvent, CertifiedSupplySnapshot } from "./certifiedSupplyModel.ts";
import type { SupplyForecastCandidate } from "./supplyForecastCandidate.ts";
import { canonicalPublicationJson } from "./canonicalPublicationJson.ts";
import { GAME_DAY_MS, gameDayKey, gameDayStartMs } from "./gameDay.ts";
import {
  HASH, iso, publicInstant, dayStart,
  PUBLIC_SUPPLY_PROJECTION_POLICY, parsePublicSupplyReference, type PublicSupplyReference,
} from "./publicSupplyReference.ts";
export {
  PUBLIC_SUPPLY_PROJECTION_POLICY, parsePublicSupplyReference, type PublicSupplyReference,
} from "./publicSupplyReference.ts";
/** Admission/signature verification belongs to the caller; a hash is not an attestation. */
export type PublishedSupplySource = Readonly<{
  publicationContentHash: string;
  candidate: SupplyForecastCandidate;
}>;
export type PublicSupplyLawCount = {
  lawId: string;
  kind: "dispatch" | "box" | "finite" | "deterministic";
  modelVersion: string | null;
  count: number;
};
export type PublicSupplyRelease = {
  eventId: string;
  kind: CertifiedSupplyEvent["kind"];
  scheduleStatus: CertifiedSupplyEvent["status"];
  availableAt: string;
  expiresAt: string | null;
  ruleId: string;
  sourceIds: string[];
  cancelled: boolean;
  modeled: boolean;
  claimWindowAssumed: boolean | null;
  restatementOf: string[];
  laws: PublicSupplyLawCount[];
};
export type NormalizedPublicSupply = {
  reference: PublicSupplyReference;
  scope: "published_slot_releases";
  candidateId: string;
  forecastId: string;
  rulesVersion: string;
  snapshotVersion: CertifiedSupplySnapshot["version"];
  futureLawSemantics: CertifiedSupplySnapshot["futureLawSemantics"];
  dispatchPolicyId: string;
  sourceStatus: SupplyForecastCandidate["sourceStatus"];
  snapshotSourceStatus: CertifiedSupplySnapshot["sourceStatus"];
  coverage: { status: "complete" | "incomplete"; missing: string[] };
  uncertainty: string[];
  releases: PublicSupplyRelease[];
  projection:
    | {
        status: "available";
        unit: "pieces";
        period: { from: string; until: string };
        populationPolicy: "snapshot_version_default";
        cohortWeights: WireQ[];
        expectedPieces: { blue: WireQ; purple: WireQ; yellow: WireQ };
      }
    | { status: "unavailable"; reason: "coverage_incomplete" | "unmodeled_supply" | "source_conflict" };
};

const sortedUnique = (values: readonly string[]) => [...new Set(values)].sort();
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function sourceSnapshot(source: PublishedSupplySource): CertifiedSupplySnapshot {
  if (!HASH.test(source.publicationContentHash) || !source.candidate.certifiedSnapshot)
    throw new Error("invalid_published_supply_source");
  return assertCertifiedRuntimeSupplySnapshot(source.candidate.certifiedSnapshot);
}

function slotBoundaries(source: PublishedSupplySource, snapshot: CertifiedSupplySnapshot, day: string): number[] {
  const from = dayStart(day), until = from + GAME_DAY_MS;
  const boundaries = new Set([from, until]);
  const include = (value: string | null | undefined) => {
    if (value === undefined || value === null) return;
    const time = publicInstant(value);
    if (time > from && time < until) boundaries.add(time);
  };
  for (const event of snapshot.events) { include(event.at); include(event.expiresAt); }
  for (const rule of snapshot.rules) { include(rule.effectiveFrom); include(rule.effectiveUntil); }
  for (const period of [...source.candidate.schedule.soloPeriods, ...source.candidate.schedule.collaborationPeriods]) {
    include(period.effectiveFrom); include(period.effectiveUntil);
  }
  for (const round of snapshot.soloRounds)
    for (const segment of round.segments ?? []) { include(segment.effectiveFrom); include(segment.effectiveUntil); }
  include(snapshot.coverage.from); include(snapshot.coverage.until);
  return [...boundaries].sort((a, b) => a - b);
}

/** No noon split is invented. An intra-day split must occur in the published source. */
export function publishedSupplyReferences(source: PublishedSupplySource, gameDay: string): PublicSupplyReference[] {
  const snapshot = sourceSnapshot(source);
  const boundaries = slotBoundaries(source, snapshot, gameDay);
  return boundaries.slice(0, -1).map((from, index) => ({
    publicationContentHash: source.publicationContentHash,
    projectionPolicyVersion: PUBLIC_SUPPLY_PROJECTION_POLICY,
    gameDay,
    slotStart: iso(from),
    slotEnd: iso(boundaries[index + 1]!),
  }));
}

/** `at` is RAM-only selection context. Neither it nor a runtime snapshot hash is returned. */
export function selectPublishedSupplyReference(source: PublishedSupplySource, at: number): PublicSupplyReference {
  if (!Number.isSafeInteger(at)) throw new Error("invalid_public_supply_selection");
  const reference = publishedSupplyReferences(source, gameDayKey(at))
    .find(slot => at >= Date.parse(slot.slotStart) && at < Date.parse(slot.slotEnd));
  if (!reference) throw new Error("invalid_public_supply_selection");
  return reference;
}

function normalizeRelease(snapshot: CertifiedSupplySnapshot, event: CertifiedSupplyEvent): PublicSupplyRelease {
  const counts = new Map<string, number>();
  for (const ref of event.refs) counts.set(ref.lawId, (counts.get(ref.lawId) ?? 0) + ref.count);
  const laws = [...counts].filter(([, count]) => count !== 0).sort(([a], [b]) => compareText(a, b))
    .map(([lawId, count]): PublicSupplyLawCount => {
      const law = snapshot.laws.find(entry => entry.id === lawId);
      const kind = law?.kind ?? (/^deterministic:\d+,\d+,\d+$/.test(lawId) ? "deterministic" : undefined);
      if (!kind) throw new Error("invalid_public_supply_law");
      return { lawId, kind, modelVersion: law?.modelVersion ?? null, count };
    });
  return {
    eventId: event.id, kind: event.kind, scheduleStatus: event.status,
    availableAt: iso(publicInstant(event.at)),
    expiresAt: event.expiresAt == null ? null : iso(publicInstant(event.expiresAt)),
    ruleId: event.ruleId, sourceIds: sortedUnique(event.sourceIds ?? []),
    cancelled: event.cancelled === true,
    modeled: isCertifiedEventModeled(snapshot, event),
    claimWindowAssumed: event.claimWindowAssumed ?? null,
    restatementOf: sortedUnique(event.restatementOf ?? []), laws,
  };
}

/** Only the immutable admitted candidate participates; never pass an aged runtime snapshot. */
export function normalizePublishedSupplyReference(
  source: PublishedSupplySource, value: PublicSupplyReference,
): NormalizedPublicSupply {
  const reference = parsePublicSupplyReference(value);
  const snapshot = sourceSnapshot(source);
  if (reference.publicationContentHash !== source.publicationContentHash)
    throw new Error("public_supply_source_mismatch");
  const boundaries = slotBoundaries(source, snapshot, reference.gameDay);
  const from = Date.parse(reference.slotStart), until = Date.parse(reference.slotEnd);
  const index = boundaries.indexOf(from);
  if (index < 0 || boundaries[index + 1] !== until)
    throw new Error("public_supply_slot_not_published");
  const missing: string[] = [];
  if (from < publicInstant(snapshot.coverage.from) || until > publicInstant(snapshot.coverage.until))
    missing.push("authority_coverage");
  for (const window of [snapshot.coverage.past, snapshot.coverage.future])
    if (from < publicInstant(window.until) && until > publicInstant(window.from) && !window.complete)
      missing.push(...window.missing, "incomplete_coverage");
  // Current-day coverage has no separate complete flag in the published schema.
  if (!snapshot.rules.some(rule => publicInstant(rule.effectiveFrom) <= gameDayStartMs(from) &&
      (rule.effectiveUntil === null || publicInstant(rule.effectiveUntil) > gameDayStartMs(from))))
    missing.push("reward_rules");
  if (snapshot.soloRounds.some(round => round.status === "unverified" &&
      dayStart(round.startGameDate) < until && (round.endGameDate === null || dayStart(round.endGameDate) > from)))
    missing.push("unverified_solo_round");
  const events = snapshot.events.filter(event => publicInstant(event.at) >= from && publicInstant(event.at) < until);
  const releases = events.map(event => normalizeRelease(snapshot, event))
    .sort((a, b) => compareText(a.availableAt, b.availableAt) || compareText(a.eventId, b.eventId));
  const uncertainty = sortedUnique([
    ...(source.candidate.sourceStatus !== "crosschecked" ? [source.candidate.sourceStatus] : []),
    ...(snapshot.sourceStatus !== "healthy" ? ["snapshot_uncertain"] : []),
    ...releases.filter(event => !event.cancelled && event.scheduleStatus === "estimated").map(() => "estimated_schedule"),
    ...releases.filter(event => !event.cancelled && event.claimWindowAssumed === true).map(() => "assumed_claim_window"),
  ]);
  let projection: NormalizedPublicSupply["projection"];
  if (source.candidate.sourceStatus === "conflict") projection = { status: "unavailable", reason: "source_conflict" };
  else if (missing.length) projection = { status: "unavailable", reason: "coverage_incomplete" };
  else if (releases.some(event => !event.cancelled && !event.modeled))
    projection = { status: "unavailable", reason: "unmodeled_supply" };
  else {
    const total: [Q, Q, Q] = [ZERO, ZERO, ZERO];
    const weights = certifiedCohortWeights(undefined, snapshot.version);
    for (const event of events) {
      if (event.cancelled) continue;
      const gain = expectedCertifiedRefs(event.refs, weights, { laws: snapshot.laws });
      for (const color of [0, 1, 2] as const) total[color] = add(total[color], gain[color]);
    }
    projection = {
      status: "available", unit: "pieces",
      period: { from: reference.slotStart, until: reference.slotEnd },
      populationPolicy: "snapshot_version_default", cohortWeights: weights.map(toWire),
      expectedPieces: {
      blue: toWire(total[0]), purple: toWire(total[1]), yellow: toWire(total[2]),
    } };
  }
  return {
    reference, scope: "published_slot_releases", candidateId: source.candidate.candidateId,
    forecastId: source.candidate.forecastId, rulesVersion: source.candidate.rulesVersion,
    snapshotVersion: snapshot.version, futureLawSemantics: snapshot.futureLawSemantics,
    dispatchPolicyId: source.candidate.dispatchPolicyId,
    sourceStatus: source.candidate.sourceStatus, snapshotSourceStatus: snapshot.sourceStatus,
    coverage: { status: missing.length ? "incomplete" : "complete", missing: sortedUnique(missing) },
    uncertainty, releases, projection,
  };
}

export function canonicalPublicSupply(value: NormalizedPublicSupply): string {
  return canonicalPublicationJson(value);
}
