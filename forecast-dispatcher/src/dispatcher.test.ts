import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as coverage from "../../shared/certifiedEvidenceCoverage.ts";
import { assertCertifiedSupplySnapshot } from "../../shared/certifiedSupply.ts";
import * as publicationStore from "../../shared/forecast-publication/store.ts";
import {
  applyPublicationCommand,
  createReview,
  initializePublication,
  sealCandidate,
} from "../../shared/forecast-publication/store.ts";
import {
  approvalReview,
  emergencyReview,
  migratePublicationDb,
  seedCandidate as seedLegacyCandidate,
  seedManualReview,
  seedRenewedManualReview,
  TEST_NOW,
} from "../../shared/forecast-publication/test-fixtures.ts";
import {
  canonicalPublicationJson,
  encodeBase64,
  publicationHash,
} from "../../shared/forecastPublication.ts";
import { buildV3SupplyForecastCandidate } from "../../shared/supplyForecastCandidate.ts";
import { admitCandidates } from "./admission.ts";
import { raiseOpsAlert, resolveOpsAlert } from "./db.ts";
import { runDispatcher } from "./dispatcher.ts";
import { loadReviewCompetition } from "./publication-review-message.ts";
import type { DispatcherEnv } from "./types.ts";

const testEnv = env as unknown as DispatcherEnv;
// Dispatcher transport/retry fixtures use the supported cadence; no pricing assertion here.
async function seedCandidate(...args: Parameters<typeof seedLegacyCandidate>) {
  const seeded = await seedLegacyCandidate(...args);
  const snapshot = assertCertifiedSupplySnapshot(seeded.candidate.certifiedSnapshot);
  const candidate = buildV3SupplyForecastCandidate({
    ...seeded.candidate,
    certifiedSnapshot: assertCertifiedSupplySnapshot({
      ...snapshot,
      cadence: {
        ...snapshot.cadence,
        version: "observed-median-v2",
        medianDays: 28,
      },
    }),
  });
  const hash = await publicationHash(candidate);
  await args[0]
    .prepare("UPDATE forecast_candidates SET payload_json=?,payload_hash=? WHERE candidate_id=?")
    .bind(canonicalPublicationJson(candidate), hash, candidate.candidateId)
    .run();
  return { candidate, hash };
}
let outbound: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  await reset();
  vi.setSystemTime(TEST_NOW);
  await migratePublicationDb(testEnv.FORECAST_DB, applyD1Migrations);
  outbound = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe("https://discord.com/api/v10/channels/123456789012345678/messages");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.enforce_nonce).toBe(true);
    return Response.json({ id: "123456789012345678" });
  });
  vi.stubGlobal("fetch", outbound);
});

describe("manual-review renewal delivery", () => {
  it("does not reopen retained manual alerts after renewal", async () => {
    const { flushOperations } = await import("./operations");
    const db = testEnv.FORECAST_DB;
    await seedRenewedManualReview(db);
    expect(await db.prepare("SELECT review_generation FROM source_queue").first()).toEqual({
      review_generation: 1,
    });
    expect(
      (
        await db
          .prepare("SELECT generation,state FROM source_manual_reviews ORDER BY generation")
          .all()
      ).results,
    ).toEqual([
      { generation: 0, state: "expired" },
      { generation: 1, state: "pending" },
    ]);
    const before = (
      await db.prepare("SELECT state,occurrence_count FROM forecast_ops_alerts").all()
    ).results;
    expect(await flushOperations(testEnv)).toBe(0);
    expect(
      (await db.prepare("SELECT state,occurrence_count FROM forecast_ops_alerts").all()).results,
    ).toEqual(before);
    expect(await flushOperations(testEnv)).toBe(0);
    expect(outbound).not.toHaveBeenCalled();
  });
});

describe("D1 publication Discord dispatcher", () => {
  it("continues legacy delivery when the v2 table is unavailable", async () => {
    await seedCandidate(testEnv.FORECAST_DB);
    const result = await runDispatcher({ ...testEnv, FORECAST_V2_NOTIFICATIONS_ENABLED: "true" });
    expect(result.sent).toBeGreaterThan(0);
    expect(outbound).toHaveBeenCalled();
  });
  it("retains renewed history without redelivering a review", async () => {
    const { flushOperations } = await import("./operations");
    const db = testEnv.FORECAST_DB;
    await seedRenewedManualReview(db);
    const before = await db.prepare("SELECT COUNT(*) n FROM forecast_ops_alerts").first();
    expect(await db.prepare("SELECT discord_message_id FROM forecast_ops_alerts").first()).toEqual({
      discord_message_id: null,
    });
    expect(await flushOperations(testEnv)).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) n FROM forecast_ops_alerts").first()).toEqual(before);
    expect(await db.prepare("SELECT discord_message_id FROM forecast_ops_alerts").first()).toEqual({
      discord_message_id: null,
    });
  });
  it("admits only the first candidate in the SQL tie order and supersedes the older page", async () => {
    for (let revision = 1; revision <= 6; revision += 1)
      await seedCandidate(testEnv.FORECAST_DB, revision);
    await runDispatcher(testEnv);
    expect(
      await testEnv.FORECAST_DB.prepare("SELECT COUNT(*) n FROM forecast_runtime_versions").first(),
    ).toEqual({ n: 1 });
    for (let run = 1; run < 6; run += 1) await runDispatcher(testEnv);
    expect(
      await testEnv.FORECAST_DB.prepare(
        "SELECT COUNT(*) n FROM forecast_runtime_reviews WHERE action='approve'",
      ).first(),
    ).toEqual({ n: 1 });
    expect(
      (
        await testEnv.FORECAST_DB.prepare(
          "SELECT candidate_id FROM forecast_runtime_reviews WHERE action='approve'",
        ).first<{ candidate_id: string }>()
      )?.candidate_id,
    ).toBe("forecast-publication-fixture-1");
  });
  it("sends bounded candidate/hash/version/expiry review and controls, without GitHub", async () => {
    const { candidate, hash } = await seedCandidate(testEnv.FORECAST_DB);
    expect(await runDispatcher(testEnv)).toEqual({ status: "completed", sent: 1 });
    const messages = outbound.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    const review = messages.find((message) => message.content.includes(candidate.candidateId));
    expect(review.content).toContain(hash.slice(0, 12));
    expect(review.content).toContain("**Forecast 예보 반영 승인 요청** · 환경: staging");
    expect(review.content).toContain("지금은 예보가 끄기 상태입니다.");
    expect(review.content).toContain("📊 지금 반영된 것: 없음(끄기 상태)");
    expect(review.content).not.toContain("솔로 레이드 일정은 지금과 같습니다");
    expect(review.content).toContain("🕔 그대로 두면:");
    expect(review.content).toMatch(/^기록용: |\n기록용: /);
    expect(review.content.length).toBeLessThanOrEqual(2000);
    expect(review.content).not.toContain("Expected sequence");
    expect(review.components[0].components[0].label).toBe("승인 (staging)");
    expect(review.components[0].components[0].custom_id).toMatch(
      /^forecast_publish:staging:[0-9a-f]{32}$/,
    );
    await runDispatcher(testEnv);
    expect(outbound).toHaveBeenCalledTimes(1);
    expect(
      await testEnv.FORECAST_DB.prepare("SELECT COUNT(*) n FROM forecast_runtime_versions").first(),
    ).toEqual({ n: 1 });
    expect(
      await testEnv.FORECAST_DB.prepare(
        "SELECT COUNT(*) n FROM forecast_runtime_activation_history",
      ).first(),
    ).toEqual({ n: 0 });
  });
  it("reports competing reviews for the same sequence from the real review table", async () => {
    const db = testEnv.FORECAST_DB;
    const { candidate } = await seedCandidate(db);
    const active = await initializePublication(db, "staging");
    await sealCandidate(db, candidate.candidateId, Date.now());
    const reviewId = await createReview(
      db,
      active,
      "approve",
      candidate.candidateId,
      await publicationHash(candidate),
      Date.now(),
    );
    // A second, actionable review for the same expected sequence: it expires after the
    // review under test, so both are still pending and must be counted.
    await createReview(db, active, "off", null, null, Date.now() + 1);
    await runDispatcher(testEnv);
    const review = outbound.mock.calls
      .map((call) => JSON.parse(String(call[1]?.body)))
      .find((message) => message.content.includes(reviewId));
    expect(review.content).toContain(
      "🔢 같은 차례(순번 0)에 대기 중인 요청이 이 메시지 포함 2건 있습니다: 승인 1 · 끄기 1.",
    );
    expect(review.content).toContain("하나를 반영하면 나머지는 이미 지난 요청이 됩니다.");
    // The sibling is an `off` review, so it makes no game-day claim beyond having no target.
    expect(review.content).toContain("더 최근 요청 있음: 끄기(후보 없음, 10/07(수) 12:00 KST)");
  });
  it("does not renew an expired approval once a newer candidate holds a live review", async () => {
    const db = testEnv.FORECAST_DB;
    const older = await seedCandidate(db, 1);
    const newer = await seedCandidate(db, 2);
    await db
      .prepare("UPDATE forecast_candidates SET created_at=? WHERE candidate_id=?")
      .bind(
        new Date(Date.parse(older.candidate.generatedAt) + 1).toISOString(),
        newer.candidate.candidateId,
      )
      .run();
    const active = await initializePublication(db, "staging");
    // The staging incident: the older candidate's review expires, then a renewal run
    // happens after the newer candidate already asked for the same sequence.
    await sealCandidate(db, older.candidate.candidateId, Date.now());
    await sealCandidate(db, newer.candidate.candidateId, Date.now());
    const newerReview = await createReview(
      db,
      active,
      "approve",
      newer.candidate.candidateId,
      newer.hash,
      Date.now(),
    );
    await createReview(
      db,
      active,
      "approve",
      older.candidate.candidateId,
      older.hash,
      // Created a review TTL ago, so it is expired now: reviews are immutable, which is
      // why the incident could only ever be "renewed" by a new request.
      Date.now() - 25 * 60 * 60_000,
    );
    await admitCandidates(
      db,
      active,
      Date.now(),
      (await import("../../shared/certifiedEvidenceCoverage.ts")).CERTIFIED_EVIDENCE_COVERAGE,
    );
    // Exactly one live approval request exists for this sequence, and it is the newer one.
    const live = await db
      .prepare(`SELECT candidate_id,review_id FROM forecast_runtime_reviews
      WHERE action='approve' AND expected_sequence=? AND expires_at>?`)
      .bind(active.sequence, Date.now())
      .all<{ candidate_id: string; review_id: string }>();
    expect(live.results).toEqual([
      { candidate_id: newer.candidate.candidateId, review_id: newerReview },
    ]);
    // The superseded candidate is terminal with a registered code, not retried forever.
    expect(
      await db
        .prepare("SELECT state,error_code FROM forecast_runtime_admissions WHERE candidate_id=?")
        .bind(older.candidate.candidateId)
        .first(),
    ).toEqual({ state: "dead", error_code: "publication_review_superseded" });
  });
  it("counts every pending review by its real action without sealing sibling payloads", async () => {
    const db = testEnv.FORECAST_DB;
    const seeded = await seedCandidate(db);
    const active = await initializePublication(db, "staging");
    await sealCandidate(db, seeded.candidate.candidateId, TEST_NOW);
    const own = await createReview(
      db,
      active,
      "approve",
      seeded.candidate.candidateId,
      seeded.hash,
      TEST_NOW,
    );
    for (let index = 0; index < 7; index++)
      await createReview(db, active, "off", null, null, TEST_NOW + index + 1, `off-${index}`);
    const review = await db
      .prepare("SELECT * FROM forecast_runtime_reviews WHERE review_id=?")
      .bind(own)
      .first<import("../../shared/forecast-publication/store.ts").ReviewRow>();
    if (!review) throw new Error("review_fixture_missing");
    const result = await loadReviewCompetition(db, review, TEST_NOW);
    expect(result.counts).toEqual({ approve: 1, rollback: 0, off: 7 });
    expect(result.newer).toEqual({ action: "off", candidateId: null, createdAt: TEST_NOW + 7 });
    const off = await db
      .prepare(
        "SELECT * FROM forecast_runtime_reviews WHERE action='off' ORDER BY created_at DESC LIMIT 1",
      )
      .first<import("../../shared/forecast-publication/store.ts").ReviewRow>();
    if (!off) throw new Error("review_fixture_missing");
    expect((await loadReviewCompetition(db, off, TEST_NOW)).counts).toEqual(result.counts);
    expect((await loadReviewCompetition(db, off, TEST_NOW)).newer).toBeNull();
  });

  it.each([false, true])(
    "blocks an approval older than the active candidate (equal timestamps=%s)",
    async (tie) => {
      const db = testEnv.FORECAST_DB;
      const activeCandidate = await seedCandidate(db, 1);
      const older = await seedCandidate(db, 2);
      if (!tie)
        await db
          .prepare("UPDATE forecast_candidates SET created_at=? WHERE candidate_id=?")
          .bind(new Date(TEST_NOW - 1).toISOString(), older.candidate.candidateId)
          .run();
      // Read-only active snapshot passed to admission; rollback/off creation is outside its policy.
      const active = {
        environment: "staging" as const,
        sequence: 3,
        candidate_id: activeCandidate.candidate.candidateId,
        operation_id: "active",
        signed_pointer_json: null,
      };
      await initializePublication(db, "staging");
      // Mark the active artifact admitted so the next candidate page reaches the older one.
      await db
        .prepare(`INSERT INTO forecast_runtime_admissions
      (candidate_id,state,attempts,next_attempt_at,updated_at) VALUES(?,'dead',5,?,?)`)
        .bind(active.candidate_id, TEST_NOW, TEST_NOW)
        .run();
      await admitCandidates(db, active, TEST_NOW);
      expect(
        await db
          .prepare("SELECT state,error_code FROM forecast_runtime_admissions WHERE candidate_id=?")
          .bind(older.candidate.candidateId)
          .first(),
      ).toEqual({
        state: "dead",
        error_code: "publication_review_superseded",
      });
      expect(await db.prepare("SELECT COUNT(*) n FROM forecast_runtime_reviews").first()).toEqual({
        n: 0,
      });
    },
  );
  it("backs off transient admission failures and retries them after a restart", async () => {
    const db = testEnv.FORECAST_DB;
    const { candidate } = await seedCandidate(db);
    await db
      .prepare(`CREATE TRIGGER fail_admission BEFORE INSERT ON forecast_runtime_versions
      BEGIN SELECT RAISE(ABORT,'publication_admission_unavailable'); END`)
      .run();
    await runDispatcher(testEnv);
    await db.prepare("DROP TRIGGER fail_admission").run();
    await runDispatcher(testEnv);
    // The test-only trigger's token is not a registered code, so the persisted reason is
    // the fixed D1 category rather than text read out of the driver message.
    expect(
      await db.prepare("SELECT state,attempts,error_code FROM forecast_runtime_admissions").first(),
    ).toEqual({ state: "pending", attempts: 1, error_code: "D1_ERROR" });
    vi.setSystemTime(TEST_NOW + 5 * 60_000);
    await runDispatcher(testEnv);
    expect(
      await db.prepare("SELECT state,attempts,error_code FROM forecast_runtime_admissions").first(),
    ).toEqual({ state: "ready", attempts: 2, error_code: "D1_ERROR" });
    expect(
      await db
        .prepare("SELECT candidate_id FROM forecast_runtime_reviews WHERE action='approve'")
        .first(),
    ).toEqual({ candidate_id: candidate.candidateId });
  });
  it("persists the publication fallback, never a runtime error name, for an unregistered admission failure", async () => {
    const db = testEnv.FORECAST_DB;
    await seedCandidate(db);
    const sentinel = "SENTINEL_runtime_9f3a";
    const gate = vi.spyOn(coverage, "hasCertifiedEvidenceCoverage").mockImplementationOnce(() => {
      throw new TypeError(sentinel);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await runDispatcher(testEnv);
      const admission = await db
        .prepare("SELECT state,attempts,error_code FROM forecast_runtime_admissions")
        .first();
      expect(admission).toEqual({
        state: "pending",
        attempts: 1,
        error_code: "publication_operation_failed",
      });
      expect(JSON.stringify(admission)).not.toContain(sentinel);
      // The column keeps the compatible fallback; the log keeps the runtime category.
      const review = warn.mock.calls
        .map(([line]) => String(line))
        .find((line) => line.includes("publication_candidate_review_failed"));
      expect(JSON.parse(review ?? "{}")).toMatchObject({
        code: "publication_operation_failed",
        errorCode: "TypeError",
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(sentinel);
    } finally {
      gate.mockRestore();
      warn.mockRestore();
    }
  });
  it("records an interrupted final admission as terminal and continues with other candidates", async () => {
    const db = testEnv.FORECAST_DB;
    const exhausted = await seedCandidate(db);
    const valid = await seedCandidate(db, 2);
    await db
      .prepare(`INSERT INTO forecast_runtime_admissions
      (candidate_id,state,attempts,next_attempt_at,lease_token,lease_until,updated_at)
      VALUES(?,'running',5,?,'lost',?,?)`)
      .bind(exhausted.candidate.candidateId, TEST_NOW - 1, TEST_NOW - 1, TEST_NOW - 60_000)
      .run();
    await runDispatcher(testEnv);
    expect(
      await db
        .prepare(
          "SELECT state,attempts,error_code FROM forecast_runtime_admissions WHERE candidate_id=?",
        )
        .bind(exhausted.candidate.candidateId)
        .first(),
    ).toEqual({ state: "dead", attempts: 5, error_code: "publication_admission_exhausted" });
    expect(
      await db
        .prepare("SELECT candidate_id FROM forecast_runtime_reviews WHERE action='approve'")
        .first(),
    ).toEqual({ candidate_id: valid.candidate.candidateId });
  });
  it("claims each outbox row only once under competing Cron runs", async () => {
    await seedCandidate(testEnv.FORECAST_DB);
    await Promise.all([runDispatcher(testEnv), runDispatcher(testEnv)]);
    expect(outbound).toHaveBeenCalledTimes(1);
    expect(
      (
        await testEnv.FORECAST_DB.prepare(
          "SELECT attempts,state FROM forecast_runtime_outbox",
        ).all()
      ).results,
    ).toEqual([{ attempts: 1, state: "sent" }]);
    expect(
      await testEnv.FORECAST_DB.prepare(
        "SELECT state,attempts FROM forecast_runtime_admissions",
      ).first(),
    ).toEqual({ state: "ready", attempts: 1 });
  });
  it("persists retry_after and reclaims expired leases after restart", async () => {
    await seedCandidate(testEnv.FORECAST_DB);
    outbound.mockResolvedValueOnce(Response.json({ retry_after: 600 }, { status: 429 }));
    await runDispatcher(testEnv);
    expect(
      await testEnv.FORECAST_DB.prepare(
        "SELECT state,next_attempt_at FROM forecast_runtime_outbox",
      ).first(),
    ).toEqual({ state: "pending", next_attempt_at: TEST_NOW + 600_000 });
    await runDispatcher(testEnv);
    expect(outbound).toHaveBeenCalledTimes(1);
    await testEnv.FORECAST_DB.prepare(`UPDATE forecast_runtime_outbox SET state='sending',lease_token='lost',
      lease_until=?,next_attempt_at=?`)
      .bind(TEST_NOW + 60_000, TEST_NOW)
      .run();
    await runDispatcher(testEnv);
    expect(outbound).toHaveBeenCalledTimes(1);
    vi.setSystemTime(TEST_NOW + 60_001);
    await runDispatcher(testEnv);
    expect(outbound).toHaveBeenCalledTimes(2);
    expect(
      await testEnv.FORECAST_DB.prepare(
        "SELECT state,attempts FROM forecast_runtime_outbox",
      ).first(),
    ).toEqual({ state: "sent", attempts: 2 });
  });
  it("makes exhausted leases terminal instead of leaving restart work stuck", async () => {
    await seedCandidate(testEnv.FORECAST_DB);
    outbound.mockResolvedValueOnce(new Response(null, { status: 500 }));
    await runDispatcher(testEnv);
    await testEnv.FORECAST_DB.prepare(`UPDATE forecast_runtime_outbox SET state='sending',attempts=5,
      lease_token='lost',lease_until=?`)
      .bind(TEST_NOW - 1)
      .run();
    await runDispatcher(testEnv);
    expect(
      await testEnv.FORECAST_DB.prepare(
        "SELECT state,error_code FROM forecast_runtime_outbox",
      ).first(),
    ).toEqual({ state: "dead", error_code: "publication_delivery_exhausted" });
  });
  it("disables only publication when its mode is off and rejects cross-environment DB reuse", async () => {
    expect(await runDispatcher({ ...testEnv, PUBLICATION_MODE: "off" })).toEqual({
      status: "completed",
      sent: 0,
    });
    expect(outbound).not.toHaveBeenCalled();
    await runDispatcher(testEnv);
    await expect(runDispatcher({ ...testEnv, ENVIRONMENT: "production" })).rejects.toThrow(
      "publication_environment_mismatch",
    );
  });
});

describe("unrecorded operational delivery outcomes", () => {
  it("reports a sent message whose delivery could not be recorded instead of counting it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await raiseOpsAlert(testEnv.FORECAST_DB, {
      alertKey: "fixture:collector",
      environment: "staging",
      severity: "critical",
      component: "collector",
      errorCode: "fixture_failure",
      nowMs: TEST_NOW,
    });
    // The row disappears while the message is in flight, so recording matches nothing.
    outbound.mockImplementationOnce(async () => {
      await testEnv.FORECAST_DB.prepare("DELETE FROM forecast_ops_alerts").run();
      return Response.json({ id: "123456789012345678" });
    });
    expect(await runDispatcher({ ...testEnv, PUBLICATION_MODE: "off" })).toEqual({
      status: "completed",
      sent: 0,
    });
    expect(JSON.parse(String(error.mock.calls.at(-1)?.[0]))).toMatchObject({
      event: "forecast_ops_send_result_not_recorded",
      alertKey: "fixture:collector",
      code: "stale_row",
    });
    error.mockRestore();
  });
  it("reports a failed delivery whose retry deadline could not be recorded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await raiseOpsAlert(testEnv.FORECAST_DB, {
      alertKey: "fixture:collector",
      environment: "staging",
      severity: "critical",
      component: "collector",
      errorCode: "fixture_failure",
      nowMs: TEST_NOW,
    });
    outbound.mockImplementationOnce(async () => {
      await testEnv.FORECAST_DB.prepare("DELETE FROM forecast_ops_alerts").run();
      return new Response(null, { status: 403 });
    });
    expect(await runDispatcher({ ...testEnv, PUBLICATION_MODE: "off" })).toEqual({
      status: "completed",
      sent: 0,
    });
    expect(JSON.parse(String(warn.mock.calls.at(-1)?.[0]))).toMatchObject({
      event: "forecast_ops_send_failure_not_recorded",
      alertKey: "fixture:collector",
      code: "stale_row",
    });
    warn.mockRestore();
  });
});

describe("operational bookkeeping failures stay contained", () => {
  it("keeps sending later alerts and later phases when one send cannot be recorded", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const alertKey of ["fixture:a", "fixture:b"])
      await raiseOpsAlert(testEnv.FORECAST_DB, {
        alertKey,
        environment: "staging",
        severity: "critical",
        component: "collector",
        errorCode: "fixture_failure",
        nowMs: TEST_NOW,
      });
    // Deterministic order: fixture:a is due first.
    await testEnv.FORECAST_DB.prepare(
      "UPDATE forecast_ops_alerts SET first_seen_at=? WHERE alert_key='fixture:b'",
    )
      .bind(new Date(TEST_NOW + 1).toISOString())
      .run();
    // Recording the first alert's delivery fails at the database, after Discord accepted it.
    await testEnv.FORECAST_DB.prepare(`CREATE TRIGGER test_fail_record BEFORE UPDATE ON
      forecast_ops_alerts WHEN OLD.alert_key='fixture:a'
      BEGIN SELECT RAISE(ABORT,'test_record_failure'); END`).run();
    expect(await runDispatcher(testEnv)).toEqual({ status: "completed", sent: 1 });
    expect(outbound).toHaveBeenCalledTimes(2);
    const logged = String(error.mock.calls.at(-1)?.[0]);
    expect(JSON.parse(logged)).toMatchObject({
      event: "forecast_ops_send_result_not_recorded",
      alertKey: "fixture:a",
      // The D1 error text stays out of the log; the test trigger's token is not a
      // registered code, so only the fixed D1 category is logged.
      code: "D1_ERROR",
    });
    expect(logged).not.toContain("test_record_failure");
    // The later phase of the same tick still ran.
    expect(
      await testEnv.FORECAST_DB.prepare("SELECT COUNT(*) n FROM forecast_runtime_active").first(),
    ).toEqual({ n: 1 });
    error.mockRestore();
  });
});

describe("dispatcher log codes", () => {
  it("never logs the message of an unexpected failure", async () => {
    const sentinel = "SENTINEL_SECRET_9f3a";
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // A real D1 error quoting an arbitrary identifier is the leak this guards against.
    await testEnv.FORECAST_DB.prepare(
      `CREATE VIEW forecast_v2_notification_outbox AS SELECT * FROM "${sentinel}"`,
    ).run();
    expect(
      await runDispatcher({ ...testEnv, FORECAST_V2_NOTIFICATIONS_ENABLED: "true" }),
    ).toMatchObject({ status: "completed" });
    const logged = error.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("v2_outbox_drain_failed");
    // The driver message keeps only its fixed D1 token, never the quoted identifier.
    expect(logged).toContain('"code":"D1_ERROR"');
    expect(logged).not.toContain(sentinel);
    error.mockRestore();
  });

  it("keeps an allowlisted code at the scheduled handler boundary", async () => {
    const { default: worker } = await import("./worker.ts");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await testEnv.USAGE_GUARD_DB.prepare(`CREATE TABLE usage_guard_state (singleton_id INTEGER
      PRIMARY KEY, action TEXT NOT NULL, observed_at TEXT NOT NULL, period_start TEXT NOT NULL,
      period_end TEXT NOT NULL, evidence_hash TEXT NOT NULL)`).run();
    await testEnv.USAGE_GUARD_DB.prepare(
      "INSERT INTO usage_guard_state VALUES (1,'normal',?,?,?,?)",
    )
      .bind(
        new Date(TEST_NOW).toISOString(),
        new Date(TEST_NOW - 86_400_000).toISOString(),
        new Date(TEST_NOW + 2_592_000_000).toISOString(),
        "a".repeat(64),
      )
      .run();
    // Staging owns the publication rows, so a production run against them is rejected
    // with an allowlisted code rather than a driver message.
    await runDispatcher(testEnv);
    let pending: Promise<unknown> | undefined;
    await worker.scheduled(
      { scheduledTime: TEST_NOW } as ScheduledController,
      { ...testEnv, ENVIRONMENT: "production" },
      {
        waitUntil: (promise: Promise<unknown>) => (pending = promise),
      } as unknown as ExecutionContext,
    );
    await expect(pending).rejects.toThrow("publication_environment_mismatch");
    expect(JSON.parse(String(error.mock.calls.at(-1)?.[0]))).toMatchObject({
      event: "forecast_dispatcher_run_failed",
      code: "publication_environment_mismatch",
    });
    error.mockRestore();
  });
});

describe("D1 operational delivery alongside publication", () => {
  it("drains pending deliveries before deriving a new candidate on the next run", async () => {
    const db = testEnv.FORECAST_DB;
    const first = await seedCandidate(db);
    await sealCandidate(db, first.candidate.candidateId, TEST_NOW);
    await createReview(
      db,
      await initializePublication(db, "staging"),
      "approve",
      first.candidate.candidateId,
      first.hash,
      TEST_NOW,
    );
    const second = await seedCandidate(db, 2);
    await db
      .prepare("UPDATE forecast_candidates SET created_at=? WHERE candidate_id=?")
      .bind(
        new Date(Date.parse(first.candidate.generatedAt) + 1).toISOString(),
        second.candidate.candidateId,
      )
      .run();
    expect(await runDispatcher(testEnv)).toEqual({ status: "completed", sent: 1 });
    expect(await db.prepare("SELECT COUNT(*) n FROM forecast_runtime_versions").first()).toEqual({
      n: 1,
    });
    expect(await runDispatcher(testEnv)).toEqual({ status: "completed", sent: 1 });
    expect(await db.prepare("SELECT COUNT(*) n FROM forecast_runtime_versions").first()).toEqual({
      n: 2,
    });
  });
  it("delivers collector, source-queue, legacy workflow and manual-review alerts with publication off", async () => {
    for (const component of ["collector", "source-queue", "github-workflow"])
      await raiseOpsAlert(testEnv.FORECAST_DB, {
        alertKey: `fixture:${component}`,
        environment: "staging",
        severity: "critical",
        component,
        errorCode: "fixture_failure",
        nowMs: TEST_NOW,
      });
    const manual = await seedManualReview(testEnv.FORECAST_DB);
    // Retained manual rows must not generate new alerts.
    await testEnv.FORECAST_DB.prepare("DELETE FROM forecast_ops_alerts WHERE alert_key=?")
      .bind(manual.alertKey)
      .run();
    expect(await runDispatcher({ ...testEnv, PUBLICATION_MODE: "off" })).toEqual({
      status: "completed",
      sent: 3,
    });
    const messages = outbound.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(messages.every((message) => !message.components)).toBe(true);
    await runDispatcher({ ...testEnv, PUBLICATION_MODE: "off" });
    expect(outbound).toHaveBeenCalledTimes(3);
    await resolveOpsAlert(testEnv.FORECAST_DB, "fixture:collector", TEST_NOW);
    await runDispatcher({ ...testEnv, PUBLICATION_MODE: "off" });
    expect(outbound).toHaveBeenCalledTimes(4);
    expect(
      await testEnv.FORECAST_DB.prepare("SELECT COUNT(*) n FROM forecast_runtime_active").first(),
    ).toEqual({ n: 0 });
  });
  it("retains failed operational delivery with a retry deadline while publication proceeds", async () => {
    await raiseOpsAlert(testEnv.FORECAST_DB, {
      alertKey: "fixture:collector",
      environment: "staging",
      severity: "critical",
      component: "collector",
      errorCode: "fixture_failure",
      nowMs: TEST_NOW,
    });
    await seedCandidate(testEnv.FORECAST_DB);
    outbound.mockResolvedValueOnce(Response.json({ retry_after: 600 }, { status: 429 }));
    expect(await runDispatcher(testEnv)).toEqual({ status: "completed", sent: 1 });
    expect(
      await testEnv.FORECAST_DB.prepare(
        "SELECT last_send_error,next_send_at FROM forecast_ops_alerts",
      ).first(),
    ).toEqual({
      last_send_error: "discord_create_message_429",
      next_send_at: new Date(TEST_NOW + 600_000).toISOString(),
    });
  });
});

describe("collector budget alerts reach the dispatcher", () => {
  it("delivers the unexplained fallback alert and silently retires legacy budget keys", async () => {
    const { flushOperations } = await import("./operations");
    const { upsertOpsAlert } = await import("../../forecast-collector/src/ops.ts");
    const { budgetUnexplainedAlertKey, BUDGET_UNEXPLAINED_ERROR_CODE } = await import(
      "../../shared/forecastOpsAlerts.ts"
    );
    const db = testEnv.FORECAST_DB;
    // Producer-owned rows: the fallback alert and a superseded legacy per-stream key.
    await upsertOpsAlert(db, {
      alertKey: budgetUnexplainedAlertKey("staging", "A"),
      environment: "staging",
      severity: "warning",
      component: "collector",
      errorCode: BUDGET_UNEXPLAINED_ERROR_CODE,
      context: { stream: "A", gameDay: "2026-10-18" },
      nowMs: TEST_NOW,
    });
    await upsertOpsAlert(db, {
      alertKey: "forecast-v2:staging:A:budget_exhausted",
      environment: "staging",
      severity: "warning",
      component: "collector",
      errorCode: "budget_exhausted",
      context: { stream: "A" },
      nowMs: TEST_NOW,
    });

    expect(await flushOperations({ ...testEnv, PUBLICATION_MODE: "off" })).toBe(1);
    expect(outbound).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(String(outbound.mock.calls[0]?.[1]?.body)) as {
      embeds: { title: string; description: string }[];
    };
    expect(sent.embeds[0]?.title).toBe("Forecast 운영 경고");
    expect(sent.embeds[0]?.description).toContain("budget_unexplained");
    expect(sent.embeds[0]?.description).not.toContain("공지 수집 일시 대기");

    const legacy = await db
      .prepare("SELECT state, recovery_sent_at FROM forecast_ops_alerts WHERE alert_key=?")
      .bind("forecast-v2:staging:A:budget_exhausted")
      .first<{ state: string; recovery_sent_at: string | null }>();
    expect(legacy?.state).toBe("resolved");
    expect(legacy?.recovery_sent_at).not.toBeNull();
    // The retirement is idempotent and never turns into a delivery.
    expect(await flushOperations({ ...testEnv, PUBLICATION_MODE: "off" })).toBe(0);
    expect(outbound).toHaveBeenCalledTimes(1);
  });
});

describe("emergency review admission does not block delivery", () => {
  async function approve() {
    const review = await approvalReview(testEnv.FORECAST_DB);
    const key = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const signing = {
      privateKey: encodeBase64(
        new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey)),
      ),
      keyId: "test",
    };
    const input = {
      reviewId: review.reviewId,
      interactionId: "9001",
      environment: "staging" as const,
      actorId: "987654321",
      messageId: "666666666",
      channelId: "333333333",
    };
    await applyPublicationCommand(testEnv.FORECAST_DB, input, signing, TEST_NOW);
    return { input, signing };
  }
  it("delivers an explicit unavailable comparison when the active artifact cannot be read", async () => {
    await approve();
    const db = testEnv.FORECAST_DB;
    const active = await publicationStore.readActive(db, "staging");
    const next = await seedCandidate(db, 2);
    await sealCandidate(db, next.candidate.candidateId, TEST_NOW);
    const reviewId = await createReview(
      db,
      active,
      "approve",
      next.candidate.candidateId,
      next.hash,
      TEST_NOW,
    );
    const original = publicationStore.readSealedCandidate;
    const reader = vi
      .spyOn(publicationStore, "readSealedCandidate")
      .mockImplementation(async (database, candidateId) => {
        if (candidateId === active.candidate_id) throw new Error("publication_candidate_unsealed");
        return original(database, candidateId);
      });
    try {
      await runDispatcher(testEnv);
    } finally {
      reader.mockRestore();
    }
    const delivered = outbound.mock.calls
      .map((call) => JSON.parse(String(call[1]?.body)))
      .find((message) => message.content.includes(`검토 ${reviewId}`));
    expect(delivered.content).toContain("현재 반영본을 읽을 수 없어 비교할 수 없습니다.");
    expect(delivered.content).toContain(`📊 지금 반영된 것: 후보 ${active.candidate_id}`);
    expect(delivered.content).not.toContain("지금은 예보가 끄기 상태");
    expect(delivered.content).not.toContain("구성 동일");
  });
  it("creates no off control before activation or when already off", async () => {
    await runDispatcher(testEnv);
    expect(
      await testEnv.FORECAST_DB.prepare("SELECT COUNT(*) n FROM forecast_runtime_reviews").first(),
    ).toEqual({ n: 0 });
    const { input, signing } = await approve();
    const off = await emergencyReview(testEnv.FORECAST_DB, "off");
    await applyPublicationCommand(
      testEnv.FORECAST_DB,
      { ...input, reviewId: off, interactionId: "9002" },
      signing,
      TEST_NOW,
    );
    await runDispatcher(testEnv);
    expect(
      await testEnv.FORECAST_DB.prepare(
        "SELECT COUNT(*) n FROM forecast_runtime_reviews WHERE action='off' AND expected_sequence=2",
      ).first(),
    ).toEqual({ n: 0 });
  });
  it("still delivers a committed result when off-review creation loses a concurrent pointer race", async () => {
    await approve();
    await testEnv.FORECAST_DB.prepare(`CREATE TRIGGER off_race BEFORE INSERT ON forecast_runtime_reviews
      WHEN NEW.action='off' BEGIN SELECT RAISE(ABORT,'runtime_review_stale'); END`).run();
    expect(await runDispatcher(testEnv)).toEqual({ status: "completed", sent: 1 });
    expect(
      await testEnv.FORECAST_DB.prepare(
        "SELECT state FROM forecast_runtime_outbox WHERE kind='result'",
      ).first(),
    ).toEqual({ state: "sent" });
  });
});
