import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as coverage from "../../shared/certifiedEvidenceCoverage.ts";
import {
  applyPublicationCommand,
  type CommandInput,
  createPreviousRollbackReview,
  initializePublication,
  REVIEW_TTL_MS,
  readActive,
  readReview,
  readSealedCandidate,
  sealCandidate,
} from "../../shared/forecast-publication/store.ts";
import {
  approvalReview,
  emergencyReview,
  migratePublicationDb,
  seedCandidate,
  TEST_NOW,
} from "../../shared/forecast-publication/test-fixtures.ts";
import {
  ARTIFACT_DOMAIN,
  encodeBase64,
  verifyPublication,
} from "../../shared/forecastPublication.ts";

const db = env.STAGING_FORECAST_DB;
let signing: { privateKey: string; keyId: string };
let publicKeyBase64: string;
beforeEach(async () => {
  await reset();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No outbound calls permitted");
    }),
  );
  await migratePublicationDb(db, applyD1Migrations);
  const key = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  signing = {
    privateKey: encodeBase64(
      new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey)),
    ),
    keyId: "test-key",
  };
  publicKeyBase64 = encodeBase64(
    new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey)),
  );
});
function input(reviewId: string, interactionId = "1001"): CommandInput {
  return {
    reviewId,
    interactionId,
    environment: "staging",
    actorId: "987654321",
    messageId: "666666666",
    channelId: "333333333",
  };
}
function apply(reviewId: string, id = "1001") {
  return applyPublicationCommand(db, input(reviewId, id), signing, TEST_NOW);
}
async function counts() {
  return db
    .prepare(`SELECT
    (SELECT COUNT(*) FROM forecast_runtime_approvals) approvals,
    (SELECT COUNT(*) FROM forecast_runtime_activation_history) history,
    (SELECT COUNT(*) FROM forecast_runtime_outbox WHERE kind='result') results,
    (SELECT sequence FROM forecast_runtime_active) sequence`)
    .first();
}
async function envelope(candidate: unknown) {
  const active = await readActive(db, "staging");
  const approval = await db
    .prepare("SELECT * FROM forecast_runtime_approvals WHERE candidate_id=?")
    .bind(active.candidate_id)
    .first<{ payload_hash: string; key_id: string; artifact_signature: string }>();
  return {
    pointer: JSON.parse(active.signed_pointer_json!),
    artifact: approval
      ? {
          authorization: {
            statement: {
              domain: ARTIFACT_DOMAIN,
              environment: "staging",
              keyId: approval.key_id,
              candidateId: active.candidate_id,
              contentHash: approval.payload_hash,
            },
            signature: approval.artifact_signature,
          },
          candidate,
        }
      : null,
  };
}
function verify(value: unknown, sequence = 0) {
  return verifyPublication(value, {
    environment: "staging",
    keyId: "test-key",
    publicKeyBase64,
    minimumSequence: sequence,
  });
}

it.each([false, true])("rejects unsupported/uncovered approval: %s", async (median) => {
  const review = await approvalReview(db, 1, median);
  const before = await counts();
  const batch = vi.spyOn(db, "batch");
  const gate = vi.spyOn(coverage, "hasCertifiedEvidenceCoverage").mockReturnValue(false);
  const code = median ? "publication_evidence_uncovered" : "publication_unsupported_cadence";
  try {
    await expect(apply(review.reviewId)).rejects.toThrow(code);
    expect(batch).not.toHaveBeenCalled();
    expect(await counts()).toEqual(before);
    expect(
      await db.prepare("SELECT state,error_code FROM forecast_runtime_commands").first(),
    ).toEqual({ state: "failed", error_code: code });
  } finally {
    gate.mockRestore();
    batch.mockRestore();
  }
});

it("persists the publication fallback, never a runtime error name, for an unregistered failure", async () => {
  const review = await approvalReview(db);
  const before = await counts();
  const sentinel = "SENTINEL_runtime_9f3a";
  const gate = vi.spyOn(coverage, "hasCertifiedEvidenceCoverage").mockImplementation(() => {
    throw new TypeError(sentinel);
  });
  try {
    await expect(apply(review.reviewId)).rejects.toThrow(TypeError);
    expect(await counts()).toEqual(before);
    const command = await db
      .prepare("SELECT state,error_code FROM forecast_runtime_commands")
      .first();
    expect(command).toEqual({ state: "failed", error_code: "publication_operation_failed" });
    expect(JSON.stringify(command)).not.toContain(sentinel);
  } finally {
    gate.mockRestore();
  }
});

it("blocks uncovered rollback and suppresses its review without affecting off", async () => {
  const a = await approvalReview(db);
  await apply(a.reviewId);
  const b = await approvalReview(db, 2);
  await apply(b.reviewId, "1002");
  const review = await emergencyReview(db, "rollback", a.candidate.candidateId);
  const before = await counts();
  const gate = vi.spyOn(coverage, "hasCertifiedEvidenceCoverage").mockReturnValue(false);
  try {
    const rows = () =>
      db
        .prepare(`SELECT
      (SELECT COUNT(*) FROM forecast_runtime_reviews) reviews,
      (SELECT COUNT(*) FROM forecast_runtime_outbox) outbox`)
        .first();
    const beforeRows = await rows();
    expect(
      await createPreviousRollbackReview(db, await readActive(db, "staging"), TEST_NOW),
    ).toBeNull();
    expect(await rows()).toEqual(beforeRows);
    const batch = vi.spyOn(db, "batch");
    try {
      await expect(apply(review, "1003")).rejects.toThrow("publication_evidence_uncovered");
      expect(batch).not.toHaveBeenCalled();
    } finally {
      batch.mockRestore();
    }
    expect(await counts()).toEqual(before);
    await expect(apply(await emergencyReview(db, "off"), "1004")).resolves.toMatchObject({
      sequence: 3,
    });
  } finally {
    gate.mockRestore();
  }
});

it("rejects a non-median rollback target before any activation batch", async () => {
  const legacy = await approvalReview(db, 1, false);
  const original = await readReview(db, input(legacy.reviewId));
  // Supply a pre-policy rollback review without bypassing current D1 schema guards.
  const historicalDb = {
    prepare(query: string) {
      if (query.includes("SELECT r.* FROM forecast_runtime_reviews"))
        return {
          bind() {
            return this;
          },
          async first<T>() {
            return { ...original, action: "rollback" } as T;
          },
          async run() {
            throw new Error("unexpected write");
          },
        };
      return db.prepare(query);
    },
    batch: vi.fn(db.batch.bind(db)),
  };
  const before = await counts();
  await expect(
    applyPublicationCommand(historicalDb, input(legacy.reviewId), signing, TEST_NOW),
  ).rejects.toThrow("publication_unsupported_cadence");
  expect(historicalDb.batch).not.toHaveBeenCalled();
  expect(await counts()).toEqual(before);
  expect(
    await db.prepare("SELECT state,error_code FROM forecast_runtime_commands").first(),
  ).toEqual({ state: "failed", error_code: "publication_unsupported_cadence" });
});

it("does not create rollback controls for a historical non-median target", async () => {
  const legacy = await approvalReview(db, 1, false);
  const active = await readActive(db, "staging");
  // Model a pre-policy historical activation. Keep real immutable candidate reads
  // and real D1 writes, but supply the historical predecessor lookup independently.
  const historicalDb = {
    prepare(query: string) {
      if (query.includes("SELECT h.previous_candidate_id"))
        return {
          bind() {
            return this;
          },
          async first<T>() {
            return {
              previous_candidate_id: legacy.candidate.candidateId,
              payload_hash: legacy.hash,
            } as T;
          },
          async run() {
            throw new Error("unexpected write");
          },
        };
      return db.prepare(query);
    },
    batch: vi.fn(db.batch.bind(db)),
  };
  const rows = () =>
    db
      .prepare(`SELECT
    (SELECT COUNT(*) FROM forecast_runtime_reviews) reviews,
    (SELECT COUNT(*) FROM forecast_runtime_outbox) outbox`)
      .first();
  const before = await rows();
  expect(
    await createPreviousRollbackReview(
      historicalDb,
      { ...active, operation_id: "historical" },
      TEST_NOW,
    ),
  ).toBeNull();
  expect(historicalDb.batch).not.toHaveBeenCalled();
  expect(await rows()).toEqual(before);
});

describe("collector writes with publication protections installed", () => {
  it("admits equivalent collector JSON serialization without changing its stored bytes", async () => {
    const { candidate, hash } = await seedCandidate(db);
    const storedJson = JSON.stringify(candidate);
    await db
      .prepare("UPDATE forecast_candidates SET payload_json=? WHERE candidate_id=?")
      .bind(storedJson, candidate.candidateId)
      .run();
    await initializePublication(db, "staging");
    expect((await sealCandidate(db, candidate.candidateId, TEST_NOW)).hash).toBe(hash);
    expect(
      await db
        .prepare("SELECT payload_json FROM forecast_candidates WHERE candidate_id=?")
        .bind(candidate.candidateId)
        .first(),
    ).toEqual({ payload_json: storedJson });
    expect(await db.prepare("SELECT payload_bytes FROM forecast_runtime_versions").first()).toEqual(
      { payload_bytes: new TextEncoder().encode(storedJson).length },
    );
  });

  it("preserves new-candidate state/link writes and mutable source updates after another artifact is approved", async () => {
    const approved = await approvalReview(db);
    await apply(approved.reviewId);
    const next = await seedCandidate(db, 2);
    for (const state of ["observed", "parsed", "x_unavailable"]) {
      const result = await db
        .prepare("UPDATE forecast_candidates SET state=?,updated_at=? WHERE candidate_id=?")
        .bind(state, new Date(TEST_NOW).toISOString(), next.candidate.candidateId)
        .run();
      expect(result.meta.changes).toBe(1);
    }
    for (const changes of [1, 0]) {
      const result = await db
        .prepare(`INSERT OR IGNORE INTO candidate_sources
        (candidate_id,source,source_item_id) VALUES(?,'naver-board-56','100')`)
        .bind(next.candidate.candidateId)
        .run();
      expect(result.meta.changes).toBe(changes);
    }
    expect(
      (
        await db
          .prepare(
            "UPDATE source_items SET title='corrected notice' WHERE source='naver-board-56' AND item_id='100'",
          )
          .run()
      ).meta.changes,
    ).toBe(1);
    expect(
      (
        await db
          .prepare(
            "UPDATE schedule_events SET reason='runtime_notice_replaced' WHERE event_id='event-1'",
          )
          .run()
      ).meta.changes,
    ).toBe(1);
    await expect(verify(await envelope(approved.candidate))).resolves.toMatchObject({
      pointer: { statement: { sequence: 1, candidateId: approved.candidate.candidateId } },
    });
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
});

describe("M4 local D1 migration and atomic publication", () => {
  it("gives reviews a full 24 hours, including those created just before UTC midnight", async () => {
    vi.setSystemTime(Date.parse("2026-10-07T23:59:59.000Z"));
    const { candidate, hash } = await seedCandidate(db);
    const active = await initializePublication(db, "staging");
    await sealCandidate(db, candidate.candidateId, Date.now());
    const { createReview } = await import("../../shared/forecast-publication/store.ts");
    const id = await createReview(db, active, "approve", candidate.candidateId, hash, Date.now());
    expect(
      await db
        .prepare("SELECT created_at,expires_at FROM forecast_runtime_reviews WHERE review_id=?")
        .bind(id)
        .first(),
    ).toEqual({ created_at: Date.now(), expires_at: Date.now() + REVIEW_TTL_MS });
  });
  it("retains exact profile validation at sealing and checks canonical hashes on sealed reads", async () => {
    const valid = await seedCandidate(db);
    const invalid = await seedCandidate(db, 2);
    invalid.candidate.profiles[0]!.expectedGain.blue += 1;
    const { publicationHash } = await import("../../shared/forecastPublication.ts");
    await db
      .prepare("UPDATE forecast_candidates SET payload_json=?,payload_hash=? WHERE candidate_id=?")
      .bind(
        JSON.stringify(invalid.candidate),
        await publicationHash(invalid.candidate),
        invalid.candidate.candidateId,
      )
      .run();
    await expect(sealCandidate(db, invalid.candidate.candidateId, TEST_NOW)).rejects.toThrow();
    await sealCandidate(db, valid.candidate.candidateId, TEST_NOW);
    expect((await readSealedCandidate(db, valid.candidate.candidateId)).hash).toBe(valid.hash);
    await db.prepare("DROP TRIGGER forecast_runtime_candidate_update").run();
    await db
      .prepare("UPDATE forecast_candidates SET payload_json='{}' WHERE candidate_id=?")
      .bind(valid.candidate.candidateId)
      .run();
    await expect(readSealedCandidate(db, valid.candidate.candidateId)).rejects.toThrow(
      "publication_candidate_hash",
    );
  });
  it("applies baseline 1 and migrations 0002..0023 in order and starts inactive", async () => {
    const versions = await db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all<{ version: number }>();
    expect(versions.results.map((row) => row.version)).toEqual(
      Array.from({ length: 23 }, (_, i) => i + 1),
    );
    expect(await db.prepare("SELECT COUNT(*) n FROM forecast_runtime_active").first()).toEqual({
      n: 0,
    });
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it("commits exactly one approval, pointer, command, history and outbox and verifies both signatures", async () => {
    const review = await approvalReview(db);
    expect(await apply(review.reviewId)).toEqual({ sequence: 1, duplicate: false });
    expect(await counts()).toEqual({ approvals: 1, history: 1, results: 1, sequence: 1 });
    expect(
      await db
        .prepare("SELECT state,result_sequence,attempts FROM forecast_runtime_commands")
        .first(),
    ).toEqual({ state: "applied", result_sequence: 1, attempts: 1 });
    const value = await envelope(review.candidate);
    await expect(verify(value)).resolves.toMatchObject({
      pointer: { statement: { sequence: 1, mode: "active" } },
    });
    const modified = structuredClone(value);
    modified.artifact!.candidate = { ...review.candidate, warnings: ["tampered"] };
    await expect(verify(modified)).rejects.toThrow();
    await expect(
      verifyPublication(value, {
        environment: "production",
        keyId: "test-key",
        publicKeyBase64,
        minimumSequence: 0,
      }),
    ).rejects.toThrow();
  });

  it("allows only one of competing approvals and leaves the loser without approval/history/outbox", async () => {
    const a = await approvalReview(db, 1);
    const b = await approvalReview(db, 2);
    const results = await Promise.allSettled([
      apply(a.reviewId, "1010"),
      apply(b.reviewId, "1011"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await counts()).toEqual({ approvals: 1, history: 1, results: 1, sequence: 1 });
    expect(
      (await db.prepare("SELECT state FROM forecast_runtime_commands ORDER BY state").all())
        .results,
    ).toEqual([{ state: "applied" }, { state: "failed" }]);
  });

  it("deduplicates simultaneous same-command clicks and rejects a changed command identity", async () => {
    const a = await approvalReview(db);
    const results = await Promise.all([apply(a.reviewId), apply(a.reviewId)]);
    expect(results.map((result) => result.sequence)).toEqual([1, 1]);
    expect(await counts()).toEqual({ approvals: 1, history: 1, results: 1, sequence: 1 });
    await expect(
      applyPublicationCommand(
        db,
        { ...input(a.reviewId), actorId: "different" },
        signing,
        TEST_NOW,
      ),
    ).rejects.toThrow("publication_command_conflict");
    await expect(apply(a.reviewId, "1002")).rejects.toThrow("publication_review_stale");
  });
});

describe("publication rollback, recovery and immutability", () => {
  it.each(["observed", "parsed", "conflict", "rejected", "superseded", "approved"])(
    "atomically rejects new approval after the reviewed candidate becomes %s",
    async (state) => {
      const a = await approvalReview(db);
      await db
        .prepare("UPDATE forecast_candidates SET state=? WHERE candidate_id=?")
        .bind(state, a.candidate.candidateId)
        .run();
      await expect(apply(a.reviewId)).rejects.toThrow("runtime_approval_ineligible");
      expect(await counts()).toEqual({ approvals: 0, history: 0, results: 0, sequence: 0 });
      expect(
        await db.prepare("SELECT state,error_code FROM forecast_runtime_commands").first(),
      ).toEqual({ state: "failed", error_code: "runtime_approval_ineligible" });
    },
  );
  it("rolls back to an approved artifact, signs off, rejects stale sequences, and never reactivates a replay", async () => {
    const a = await approvalReview(db);
    await apply(a.reviewId);
    const firstEnvelope = await envelope(a.candidate);
    const b = await approvalReview(db, 2);
    await apply(b.reviewId, "1002");
    await apply(await emergencyReview(db, "rollback", a.candidate.candidateId), "1003");
    await expect(verify(await envelope(a.candidate), 2)).resolves.toMatchObject({
      pointer: { statement: { sequence: 3 } },
    });
    await apply(await emergencyReview(db, "off"), "1004");
    await expect(verify(await envelope(null), 3)).resolves.toMatchObject({
      artifact: null,
      pointer: { statement: { mode: "off", sequence: 4 } },
    });
    await expect(verify(firstEnvelope, 4)).rejects.toThrow("publication_invalid_pointer");
    expect(await apply(a.reviewId)).toEqual({ sequence: 1, duplicate: true });
    expect(await counts()).toEqual({ approvals: 2, history: 4, results: 4, sequence: 4 });
  });

  it("keeps signing failures retryable with no publication effects", async () => {
    const a = await approvalReview(db);
    await expect(
      applyPublicationCommand(
        db,
        input(a.reviewId),
        { ...signing, privateKey: "invalid" },
        TEST_NOW,
      ),
    ).rejects.toThrow();
    expect(await counts()).toEqual({ approvals: 0, history: 0, results: 0, sequence: 0 });
    expect(
      await db.prepare("SELECT state,attempts FROM forecast_runtime_commands").first(),
    ).toEqual({ state: "failed", attempts: 1 });
    expect(await apply(a.reviewId)).toEqual({ sequence: 1, duplicate: false });
    expect(await db.prepare("SELECT attempts FROM forecast_runtime_commands").first()).toEqual({
      attempts: 2,
    });
  });

  it("rolls the whole D1 batch back on outbox failure, then retries after restart", async () => {
    const a = await approvalReview(db);
    await db
      .prepare(`CREATE TRIGGER fail_result BEFORE INSERT ON forecast_runtime_outbox
      WHEN NEW.kind='result' BEGIN SELECT RAISE(ABORT,'injected_result_failure'); END`)
      .run();
    await expect(apply(a.reviewId)).rejects.toThrow();
    expect(await counts()).toEqual({ approvals: 0, history: 0, results: 0, sequence: 0 });
    await db.prepare("DROP TRIGGER fail_result").run();
    expect(await apply(a.reviewId)).toEqual({ sequence: 1, duplicate: false });
  });

  it("rejects expired, wrong-message and cross-environment approvals", async () => {
    const a = await approvalReview(db);
    await expect(
      applyPublicationCommand(db, input(a.reviewId), signing, TEST_NOW + 24 * 60 * 60_000),
    ).rejects.toThrow("publication_review_expired");
    await expect(
      applyPublicationCommand(
        db,
        { ...input(a.reviewId), messageId: "777777777" },
        signing,
        TEST_NOW,
      ),
    ).rejects.toThrow("publication_review_binding");
    await expect(
      applyPublicationCommand(
        db,
        { ...input(a.reviewId), environment: "production" },
        signing,
        TEST_NOW,
      ),
    ).rejects.toThrow("publication_review_binding");
    expect(await counts()).toEqual({ approvals: 0, history: 0, results: 0, sequence: 0 });
  });

  it("forbids immutable update/delete/replace and direct pointer writes", async () => {
    const a = await approvalReview(db);
    await apply(a.reviewId);
    for (const table of [
      "forecast_runtime_versions",
      "forecast_runtime_reviews",
      "forecast_runtime_approvals",
      "forecast_runtime_activation_history",
      "forecast_runtime_commands",
      "forecast_candidates",
    ]) {
      const firstColumn =
        table === "forecast_runtime_reviews"
          ? "review_id"
          : table === "forecast_runtime_activation_history"
            ? "operation_id"
            : table === "forecast_runtime_commands"
              ? "interaction_id"
              : "candidate_id";
      await expect(
        db.prepare(`UPDATE ${table} SET ${firstColumn}=${firstColumn}`).run(),
      ).rejects.toThrow();
      await expect(db.prepare(`DELETE FROM ${table}`).run()).rejects.toThrow();
      await expect(
        db.prepare(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`).run(),
      ).rejects.toThrow();
    }
    await expect(
      db.prepare("UPDATE forecast_runtime_active SET sequence=sequence+1").run(),
    ).rejects.toThrow();
    await expect(db.prepare("DELETE FROM forecast_runtime_active").run()).rejects.toThrow();
    await expect(
      db
        .prepare(
          "INSERT OR REPLACE INTO forecast_runtime_active SELECT * FROM forecast_runtime_active",
        )
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare("UPDATE forecast_runtime_outbox SET message_id='999999999' WHERE kind='review'")
        .run(),
    ).rejects.toThrow();
    await expect(db.prepare("DELETE FROM forecast_runtime_outbox").run()).rejects.toThrow();
    expect(await counts()).toEqual({ approvals: 1, history: 1, results: 1, sequence: 1 });
  });
});
