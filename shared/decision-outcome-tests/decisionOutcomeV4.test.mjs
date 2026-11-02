import test from "node:test";
import assert from "node:assert/strict";
import {
  assertOutcomeSettlementBinding, canonicalOutcomeAttemptPatch, canonicalOutcomeCommit,
  classifyOutcomeAttemptPatch, classifyOutcomeCommit, extractOutcomeRawFacts,
  outcomeAttemptPatchDigest, outcomeCommitDigest, parseOutcomeEnvelope,
} from "../decisionOutcomeV4.ts";

const reportId = "00000000-0000-4000-8000-000000000001";
function envelope() {
  return {
    version: 4, kind: "confirmed_outcome", operation: "commit", reportId,
    data: {
      producerVersion: "test-only-producer", producerCodeHash: "a".repeat(64),
      supplyReference: {
        publicationContentHash: "b".repeat(64),
        projectionPolicyVersion: "published-slot-releases-v1", gameDay: "2026-10-15",
        slotStart: "2026-10-15T05:00:00+09:00", slotEnd: "2026-10-15T12:00:00+09:00",
      },
      holdings: { blue: 0, purple: 100000, yellow: 123 },
      recommendedCurrent: "use_blue", chosenMethod: "use_yellow", waitRecommended: true,
      recommendedUses: 10, outcome: "great", attemptCount: null, legacySettlement: null,
    },
    turnstileToken: "test-only-token-never-approved",
  };
}

test("confirmed Current report retains exact holdings, independently chosen method and unknown attempts during WAIT", () => {
  const { event, token } = parseOutcomeEnvelope(envelope());
  assert.deepEqual(event.data.holdings, { blue: 0, purple: 100000, yellow: 123 });
  assert.equal(event.data.recommendedCurrent, "use_blue");
  assert.equal(event.data.chosenMethod, "use_yellow");
  assert.equal(event.data.waitRecommended, true);
  assert.equal(event.data.attemptCount, null);
  assert.equal(event.data.supplyReference.slotStart, "2026-10-14T20:00:00.000Z");
  assert.equal(token, "test-only-token-never-approved");
  assert.equal(Object.hasOwn(event, "turnstileToken"), false);
});

test("wire rejects precise runtime context, pre-outcome parents and non-actionable Current", () => {
  for (const modify of [
    value => { value.calcTime = "2026-10-15T07:32:12.000+09:00"; },
    value => { value.data.runtimeSnapshotHash = "c".repeat(64); },
    value => { value.data.grade = "SR"; },
    value => { value.data.exp = 100; },
    value => { value.data.supplyReference.asOf = "2026-10-15T07:32:12.000+09:00"; },
    value => { delete value.data.outcome; },
    value => { value.data.outcome = "unknown"; },
    value => { value.operation = "calculation"; },
    value => { value.version = 3; },
    value => { value.data.recommendedCurrent = "preserve"; },
  ]) {
    const value = envelope(); modify(value);
    assert.throws(() => parseOutcomeEnvelope(value), /invalid_outcome_event/);
  }
});

test("wire rejects time IDs, fractional or out-of-bounds holdings, and inferred zero attempts", () => {
  for (const id of [
    "00000000-0000-7000-8000-000000000001",
    "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  ]) assert.throws(() => parseOutcomeEnvelope({ ...envelope(), reportId: id }), /invalid_outcome_event/);
  for (const count of [-1, 1.5, 100001, Number.NaN, Number.POSITIVE_INFINITY]) {
    const value = envelope(); value.data.holdings.blue = count;
    assert.throws(() => parseOutcomeEnvelope(value), /invalid_outcome_event/);
  }
  for (const count of [0, -1, 1.5, 100001, undefined]) {
    const value = envelope(); value.data.attemptCount = count;
    assert.throws(() => parseOutcomeEnvelope(value), /invalid_outcome_event/);
  }
});

test("every commit or patch envelope requires a bounded token; verification freshness is server-owned", () => {
  for (const operation of ["commit", "attempt_patch"]) {
    const value = envelope();
    value.operation = operation;
    if (operation === "attempt_patch") value.data = { attemptCount: 7, legacySettlement: null };
    for (const token of ["", "x".repeat(19), "x".repeat(2049)]) {
      assert.throws(() => parseOutcomeEnvelope({ ...value, turnstileToken: token }), /turnstile_token_required/);
    }
    assert.equal(parseOutcomeEnvelope(value).event.operation, operation);
  }
});

test("initial commit digest normalizes equivalent public instants, excludes tokens and includes report identity", async () => {
  const first = envelope();
  const second = envelope();
  second.turnstileToken = "different-test-only-fresh-token";
  second.data.supplyReference.slotStart = "2026-10-14T20:00:00Z";
  second.data.supplyReference.slotEnd = "2026-10-15T03:00:00.000Z";
  const firstEvent = parseOutcomeEnvelope(first).event;
  const secondEvent = parseOutcomeEnvelope(second).event;
  assert.equal(canonicalOutcomeCommit(firstEvent), canonicalOutcomeCommit(secondEvent));
  const initial = await outcomeCommitDigest(firstEvent);
  assert.equal(initial, await outcomeCommitDigest(secondEvent));
  assert.notEqual(initial, await outcomeCommitDigest({ ...firstEvent, reportId: "00000000-0000-4000-8000-000000000002" }));
  assert.notEqual(initial, await outcomeCommitDigest({ ...firstEvent, data: { ...firstEvent.data, chosenMethod: "use_purple" } }));
  assert.equal(classifyOutcomeCommit(null, initial), "insert");
  assert.equal(classifyOutcomeCommit(initial, initial), "duplicate");
  assert.equal(classifyOutcomeCommit(initial, "f".repeat(64)), "conflict");
});

test("original commit retry stays a no-op after optional patch and receipt cleanup", async () => {
  const commit = parseOutcomeEnvelope(envelope()).event;
  const permanentInitialDigest = await outcomeCommitDigest(commit);
  let attempts = commit.data.attemptCount;
  assert.equal(classifyOutcomeAttemptPatch(attempts, 8, true, commit.data.recommendedUses), "apply");
  attempts = 8;
  assert.equal(classifyOutcomeAttemptPatch(attempts, 8, false, commit.data.recommendedUses), "duplicate");
  assert.equal(classifyOutcomeAttemptPatch(attempts, 9, true, commit.data.recommendedUses), "conflict");
  assert.equal(classifyOutcomeAttemptPatch(null, 8, false, commit.data.recommendedUses), "expired");
  // The permanent digest is not replaced with the patched row or deleted with its receipt.
  assert.equal(classifyOutcomeCommit(permanentInitialDigest, await outcomeCommitDigest(commit)), "duplicate");
  assert.equal(classifyOutcomeCommit(permanentInitialDigest,
    await outcomeCommitDigest({ ...commit, data: { ...commit.data, attemptCount: 8 } })), "conflict");
});

test("patch cannot change any confirmed fact or clear an accepted count", () => {
  const patch = { ...envelope(), operation: "attempt_patch", data: { attemptCount: 3, legacySettlement: null } };
  assert.equal(parseOutcomeEnvelope(patch).event.data.attemptCount, 3);
  assert.throws(() => parseOutcomeEnvelope({ ...patch, data: { attemptCount: null, legacySettlement: null } }), /invalid_outcome_event/);
  assert.throws(() => parseOutcomeEnvelope({ ...patch, data: { attemptCount: 3, legacySettlement: null, outcome: "no_great" } }), /invalid_outcome_event/);
});

test("patch digest binds report and count but never a retry token or mutable stored facts", async () => {
  const patch = parseOutcomeEnvelope({ ...envelope(), operation: "attempt_patch", data: { attemptCount: 3, legacySettlement: null } }).event;
  const retry = parseOutcomeEnvelope({
    ...envelope(), operation: "attempt_patch", data: { attemptCount: 3, legacySettlement: null },
    turnstileToken: "another-test-only-fresh-token",
  }).event;
  assert.equal(canonicalOutcomeAttemptPatch(patch), canonicalOutcomeAttemptPatch(retry));
  assert.equal(await outcomeAttemptPatchDigest(patch), await outcomeAttemptPatchDigest(retry));
  assert.notEqual(await outcomeAttemptPatchDigest(patch),
    await outcomeAttemptPatchDigest({ ...patch, data: { attemptCount: 4, legacySettlement: null } }));
  assert.notEqual(await outcomeAttemptPatchDigest(patch),
    await outcomeAttemptPatchDigest({ ...patch, reportId: "00000000-0000-4000-8000-000000000002" }));
  assert.throws(() => canonicalOutcomeAttemptPatch(parseOutcomeEnvelope(envelope()).event), /invalid_outcome_event/);
});

function settledEnvelope(outcome = "great", attemptCount = null) {
  const value = envelope();
  value.data.recommendedUses = 2;
  value.data.outcome = outcome;
  value.data.attemptCount = attemptCount;
  value.data.legacySettlement = {
    kind: "kit_result", start: { grade: "SR", level: 0, exp: 0 }, kit: "yellow",
    recommendedUses: 2, outcome: outcome === "great" ? "great_success" : "no_great_success",
    successAttempt: outcome === "great" ? 2 : null,
    stockBefore: { ...value.data.holdings }, stockAfter: { ...value.data.holdings, yellow: 103 },
    resultState: outcome === "great" ? { grade: "SR", level: 5, exp: 0 } : { grade: "SR", level: 0, exp: 2000 },
  };
  return value;
}

test("prepared run quantity is uses of ten pieces and bounds explicit attempts by that accepted batch", () => {
  const accepted = parseOutcomeEnvelope(settledEnvelope("great", 2)).event;
  assert.equal(accepted.data.recommendedUses, 2);
  for (const quantity of [0, 1.5, 101, 13]) {
    const value = envelope(); value.data.recommendedUses = quantity;
    assert.throws(() => parseOutcomeEnvelope(value), /invalid_outcome_event/);
  }
  const tooMany = envelope(); tooMany.data.attemptCount = 11;
  assert.throws(() => parseOutcomeEnvelope(tooMany), /invalid_outcome_event/);
  const wrongFailedBatch = envelope(); wrongFailedBatch.data.outcome = "no_great"; wrongFailedBatch.data.attemptCount = 9;
  assert.throws(() => parseOutcomeEnvelope(wrongFailedBatch), /invalid_outcome_event/);
  assert.throws(() => classifyOutcomeAttemptPatch(null, 3, true, 2), /invalid_outcome_event/);
  assert.equal(classifyOutcomeAttemptPatch(null, 2, true, 2), "apply");
});

test("eligible legacy payload binds to accepted raw facts without storing transient game states", async () => {
  for (const outcome of ["great", "no_great"]) {
    const commit = parseOutcomeEnvelope(settledEnvelope(outcome)).event;
    const facts = extractOutcomeRawFacts(commit);
    assert.deepEqual(Object.keys(facts).sort(), [
      "attemptCount", "chosenMethod", "holdings", "outcome", "producerCodeHash", "producerVersion",
      "recommendedCurrent", "recommendedUses", "supplyReference", "waitRecommended",
    ]);
    assert.equal(facts.attemptCount, null);
    assert.equal(facts.recommendedUses, 2);
    assert.equal(commit.data.legacySettlement.start.grade, "SR");
    const changed = structuredClone(commit); changed.data.legacySettlement.start.exp = 100;
    assert.notEqual(await outcomeCommitDigest(commit), await outcomeCommitDigest(changed));
    assert.deepEqual(extractOutcomeRawFacts(commit), extractOutcomeRawFacts(changed));
  }
});

test("legacy shape is strict and cross-protocol binding cannot replace the existing transition validator", () => {
  for (const mutate of [
    event => { event.legacySettlement.kit = "blue"; },
    event => { event.legacySettlement.recommendedUses = 1; },
    event => { event.legacySettlement.outcome = "no_great_success"; },
    event => { event.legacySettlement.stockBefore.yellow = 122; },
    event => { event.attemptCount = 1; },
  ]) {
    const value = settledEnvelope(); mutate(value.data);
    assert.throws(() => parseOutcomeEnvelope(value), /outcome_settlement_mismatch/);
  }
  const extra = settledEnvelope(); extra.data.legacySettlement.calcTime = "private";
  assert.throws(() => parseOutcomeEnvelope(extra), /invalid_outcome_event/);
  const malformed = settledEnvelope(); malformed.data.legacySettlement.start.exp = 3000;
  assert.throws(() => parseOutcomeEnvelope(malformed), /invalid_outcome_event/);
  // A structurally bounded but numerically invalid transition MUST still reach the existing server validator.
  const serverOwned = settledEnvelope(); serverOwned.data.legacySettlement.resultState.exp = 100;
  assert.equal(parseOutcomeEnvelope(serverOwned).event.data.legacySettlement.resultState.exp, 100);
});

test("late correction can settle legacy contribution without inventing an explicit attempt count", () => {
  const original = settledEnvelope();
  const settlement = original.data.legacySettlement;
  original.data.legacySettlement = null;
  const commit = parseOutcomeEnvelope(original).event;
  const facts = extractOutcomeRawFacts(commit);
  const patch = parseOutcomeEnvelope({
    ...envelope(), operation: "attempt_patch", data: { attemptCount: null, legacySettlement: settlement },
  }).event;
  assert.equal(patch.data.attemptCount, null);
  assert.equal(facts.attemptCount, null);
  assert.doesNotThrow(() => assertOutcomeSettlementBinding(facts, patch.data.legacySettlement));
  assert.throws(() => assertOutcomeSettlementBinding(facts, patch.data.legacySettlement, 1), /outcome_settlement_mismatch/);
});
