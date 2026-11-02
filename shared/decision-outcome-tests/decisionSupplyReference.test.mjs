import test from "node:test";
import assert from "node:assert/strict";
import registry from "../supplyForecasts.json" with { type: "json" };
import { assertCertifiedRuntimeSupplySnapshot, buildCertifiedSupplySnapshot } from "../certifiedSupply.ts";
import { buildV3SupplyForecastCandidate, buildSupplyForecastCandidate } from "../supplyForecastCandidate.ts";
import { publicationHash } from "../forecastPublication.ts";
import {
  canonicalPublicSupply, normalizePublishedSupplyReference, parsePublicSupplyReference,
  publishedSupplyReferences, selectPublishedSupplyReference,
} from "../decisionSupplyReference.ts";

// Synthetic publication metadata only. These fixtures confer no producer/key approval.
const sourceEvidence = [{
  source: "naver-board-56", itemId: "test-only",
  url: "https://game.naver.com/lounge/nikke/board/detail/100",
  publishedAt: "2026-10-07T05:00:00+09:00",
  excerpt: "Test-only public supply source", contentHash: "a".repeat(64),
}];

async function segmentedSource() {
  const periods = [
    { round: 42, start: "2026-10-15", end: "2026-10-22" },
    { round: 43, start: "2026-11-12", end: "2026-11-19" },
    { round: 44, start: "2026-12-10", end: "2026-12-17" },
  ].map(({ round, start, end }) => ({
    round, segment: 1, scheduleStatus: "confirmed",
    effectiveFrom: `${start}T12:00:00+09:00`, effectiveUntil: `${end}T05:00:00+09:00`,
    segments: [{
      segment: 1, kind: "initial", effectiveFrom: `${start}T12:00:00+09:00`,
      effectiveUntil: `${end}T05:00:00+09:00`,
      rewardFromGameDate: start, rewardUntilGameDate: end, sourceIds: ["test-only-source"],
    }],
  }));
  const grants = [{
    id: "grant:test-only:public:2026-10-15:1", grantGameDate: "2026-10-15",
    refs: [{ lawId: "regular-box-v1", count: 2 }, { lawId: "box-ii-v1", count: 1 }],
    claimUntil: "2026-10-15T18:00:00+09:00",
    claimWindowAssumed: false, sourceIds: ["test-only-source"], restatementOf: [],
  }];
  const snapshot = buildCertifiedSupplySnapshot({
    version: "certified-daily-v5", asOf: "2026-10-07T05:00:00+09:00",
    revision: "test-only-public-reference", sourceHash: "b".repeat(64),
    soloPeriods: periods, collaborationPeriods: [], grants, sourceStatus: "healthy",
  });
  const candidate = buildSupplyForecastCandidate({
    candidateId: "forecast-test-only-reference", forecastId: "supply-2026-10-07-v1",
    dispatchPolicyId: "dispatch-policy-v1", generatedAt: snapshot.asOf, sourceStatus: "crosschecked",
    schedule: {
      status: "confirmed", cadenceDays: null,
      soloStart: periods[0].effectiveFrom, soloEnd: periods[0].effectiveUntil,
      soloPeriods: periods.map(({ segments: _segments, ...period }) => period), collaborationPeriods: [],
    },
    grants, sourceEvidence, warnings: [], certifiedSnapshot: snapshot,
  });
  return { candidate, publicationContentHash: await publicationHash(candidate) };
}

test("real operational published snapshot normalizes without float profile totals or private runtime context", async () => {
  const entry = registry.forecasts.find(item => item.id === registry.approvedForecastId);
  assert.ok(entry);
  const snapshot = assertCertifiedRuntimeSupplySnapshot(entry.certifiedSnapshot);
  const periods = snapshot.soloRounds.filter(round =>
    round.startGameDate > snapshot.coverage.currentDay && round.endGameDate).slice(0, 3).map(round => ({
    effectiveFrom: `${round.startGameDate}T05:00:00+09:00`,
    effectiveUntil: `${round.endGameDate}T05:00:00+09:00`, scheduleStatus: "estimated",
  }));
  const candidate = buildV3SupplyForecastCandidate({
    candidateId: "forecast-test-only-real-source", forecastId: entry.id,
    generatedAt: snapshot.asOf, sourceStatus: "x_unavailable", dispatchPolicyId: "dispatch-policy-v1",
    schedule: {
      status: "estimated", cadenceDays: null, soloStart: periods[0].effectiveFrom,
      soloEnd: periods[0].effectiveUntil, soloPeriods: periods, collaborationPeriods: [],
    },
    sourceEvidence: entry.sourceEvidence, warnings: [], certifiedSnapshot: snapshot,
  });
  const source = { candidate, publicationContentHash: await publicationHash(candidate) };
  const reference = selectPublishedSupplyReference(source, Date.parse(snapshot.asOf));
  const normalized = normalizePublishedSupplyReference(source, reference);
  assert.equal(normalized.reference.publicationContentHash, source.publicationContentHash);
  assert.equal(normalized.snapshotVersion, snapshot.version);
  assert.equal(normalized.sourceStatus, "x_unavailable");
  assert.ok(normalized.uncertainty.includes("x_unavailable"));
  assert.deepEqual(normalized.releases.map(event => event.eventId).sort(),
    snapshot.events.filter(event => Date.parse(event.at) >= Date.parse(reference.slotStart) &&
      Date.parse(event.at) < Date.parse(reference.slotEnd)).map(event => event.id).sort());
  assert.equal(Object.hasOwn(normalized, "asOf"), false);
  assert.equal(Object.hasOwn(normalized, "runtimeSnapshotHash"), false);
});

test("05 KST and sourced noon/expiry boundaries define slots; no generic noon is invented", async () => {
  const source = await segmentedSource();
  assert.deepEqual(publishedSupplyReferences(source, "2026-10-15").map(slot => [slot.slotStart, slot.slotEnd]), [
    ["2026-10-14T20:00:00.000Z", "2026-10-15T03:00:00.000Z"],
    ["2026-10-15T03:00:00.000Z", "2026-10-15T09:00:00.000Z"],
    ["2026-10-15T09:00:00.000Z", "2026-10-15T20:00:00.000Z"],
  ]);
  assert.equal(publishedSupplyReferences(source, "2026-10-16").length, 1);
  const before = selectPublishedSupplyReference(source, Date.parse("2026-10-15T11:59:59+09:00"));
  const after = selectPublishedSupplyReference(source, Date.parse("2026-10-15T12:00:00+09:00"));
  assert.equal(before.slotEnd, after.slotStart);
  const reset = selectPublishedSupplyReference(source, Date.parse("2026-10-15T05:00:00+09:00"));
  const prior = selectPublishedSupplyReference(source, Date.parse("2026-10-15T04:59:59+09:00"));
  assert.equal(reset.gameDay, "2026-10-15"); assert.equal(prior.gameDay, "2026-10-14");
});

test("same published reference is invariant across client selection instants, not across runtime views", async () => {
  const source = await segmentedSource();
  const first = selectPublishedSupplyReference(source, Date.parse("2026-10-15T12:01:00+09:00"));
  const later = selectPublishedSupplyReference(source, Date.parse("2026-10-15T17:59:59+09:00"));
  assert.deepEqual(first, later);
  assert.equal(canonicalPublicSupply(normalizePublishedSupplyReference(source, first)),
    canonicalPublicSupply(normalizePublishedSupplyReference(source, later)));
});

test("slot expectation is exact pieces from releases in that interval, excluding earlier grants and dispatch", async () => {
  const source = await segmentedSource();
  const reference = selectPublishedSupplyReference(source, Date.parse("2026-10-15T12:00:00+09:00"));
  const value = normalizePublishedSupplyReference(source, reference);
  assert.deepEqual(value.releases.map(event => event.kind), ["solo"]);
  assert.equal(value.projection.status, "available");
  // The published first solo day has twelve regular boxes: 12*(3*4/5, 1*1/5, 0).
  assert.deepEqual(value.projection.expectedPieces, {
    blue: { numerator: "144", denominator: "5" },
    purple: { numerator: "12", denominator: "5" },
    yellow: { numerator: "0", denominator: "1" },
  });
  assert.equal(value.projection.unit, "pieces");
  assert.deepEqual(value.projection.period, { from: reference.slotStart, until: reference.slotEnd });
  assert.deepEqual(value.projection.cohortWeights, [
    { numerator: "1", denominator: "6" }, { numerator: "1", denominator: "3" }, { numerator: "1", denominator: "2" },
  ]);
});

test("actual grants preserve law kinds/counts, unknown claim state and cancellation rather than substituting generic rewards", async () => {
  const source = await segmentedSource();
  const first = normalizePublishedSupplyReference(source,
    selectPublishedSupplyReference(source, Date.parse("2026-10-15T05:00:00+09:00")));
  const grant = first.releases.find(event => event.kind === "grant");
  assert.deepEqual(grant.laws.map(({ lawId, kind, count }) => ({ lawId, kind, count })), [
    { lawId: "box-ii-v1", kind: "box", count: 1 },
    { lawId: "regular-box-v1", kind: "box", count: 2 },
  ]);
  assert.equal(grant.claimWindowAssumed, false);
  assert.equal(grant.expiresAt, "2026-10-15T09:00:00.000Z");
  const changed = structuredClone(source);
  const solo = changed.candidate.certifiedSnapshot.events.find(event => event.id === "solo:r42:day1");
  solo.cancelled = true;
  changed.publicationContentHash = await publicationHash(changed.candidate);
  const value = normalizePublishedSupplyReference(changed,
    selectPublishedSupplyReference(changed, Date.parse("2026-10-15T12:00:00+09:00")));
  assert.equal(value.releases[0].cancelled, true);
  assert.equal(value.releases[0].modeled, false);
  assert.equal(value.releases[0].claimWindowAssumed, null);
  assert.deepEqual(value.projection.expectedPieces, {
    blue: { numerator: "0", denominator: "1" }, purple: { numerator: "0", denominator: "1" },
    yellow: { numerator: "0", denominator: "1" },
  });
});

test("incomplete public coverage preserves raw releases but has no invented zero expectation", async () => {
  const source = structuredClone(await segmentedSource());
  source.candidate.certifiedSnapshot.coverage.future.complete = false;
  source.candidate.certifiedSnapshot.coverage.future.missing = ["reward_rules"];
  source.publicationContentHash = await publicationHash(source.candidate);
  const reference = selectPublishedSupplyReference(source, Date.parse("2026-10-15T12:00:00+09:00"));
  const value = normalizePublishedSupplyReference(source, reference);
  assert.equal(value.coverage.status, "incomplete");
  assert.equal(value.releases.length, 1);
  assert.deepEqual(value.projection, { status: "unavailable", reason: "coverage_incomplete" });
});

test("forged split, wrong publication, impossible date and private timestamp fields are rejected", async () => {
  const source = await segmentedSource();
  const reference = selectPublishedSupplyReference(source, Date.parse("2026-10-15T12:00:00+09:00"));
  assert.throws(() => normalizePublishedSupplyReference(source, { ...reference, slotStart: "2026-10-15T12:01:00+09:00" }),
    /public_supply_slot_not_published/);
  assert.throws(() => normalizePublishedSupplyReference(source, { ...reference, publicationContentHash: "f".repeat(64) }),
    /public_supply_source_mismatch/);
  assert.throws(() => parsePublicSupplyReference({ ...reference, gameDay: "2026-02-30" }), /invalid_public_supply_reference/);
  assert.throws(() => parsePublicSupplyReference({ ...reference, runtimeSnapshotHash: "a".repeat(64) }),
    /invalid_public_supply_reference/);
});
