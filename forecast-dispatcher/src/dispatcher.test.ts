import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  seedCandidate,
  seedManualReview,
  TEST_NOW,
} from "../../shared/forecast-publication/test-fixtures.ts";
import { encodeBase64 } from "../../shared/forecastPublication.ts";
import { raiseOpsAlert, resolveOpsAlert } from "./db.ts";
import { runDispatcher } from "./dispatcher.ts";
import type { DispatcherEnv } from "./types.ts";

const testEnv = env as unknown as DispatcherEnv;
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

describe("D1 publication Discord dispatcher", () => {
  it("advances beyond the first bounded candidate page instead of starving older reviews", async () => {
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
    ).toEqual({ n: 6 });
  });
  it("sends bounded candidate/hash/version/expiry review and controls, without GitHub", async () => {
    const { candidate, hash } = await seedCandidate(testEnv.FORECAST_DB);
    expect(await runDispatcher(testEnv)).toEqual({ status: "completed", sent: 1 });
    const messages = outbound.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    const review = messages.find((message) => message.content.includes(candidate.candidateId));
    expect(review.content).toContain(hash);
    expect(review.content).toContain("schedule-kit-v3");
    expect(review.content).toContain("Expires:");
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
  it("admits an older valid candidate past newer legacy/invalid candidates and caps failed retries", async () => {
    const db = testEnv.FORECAST_DB;
    const valid = await seedCandidate(db);
    await db
      .prepare("UPDATE forecast_candidates SET created_at=? WHERE candidate_id=?")
      .bind(new Date(TEST_NOW - 1).toISOString(), valid.candidate.candidateId)
      .run();
    for (let revision = 2; revision <= 6; revision += 1) {
      const { candidate } = await seedCandidate(db, revision);
      await db
        .prepare("UPDATE forecast_candidates SET payload_json=?,created_at=? WHERE candidate_id=?")
        .bind(
          JSON.stringify(
            revision % 2 === 0
              ? { ...candidate, payloadVersion: 3, rulesVersion: "schedule-kit-v2" }
              : {},
          ),
          new Date(TEST_NOW + revision).toISOString(),
          candidate.candidateId,
        )
        .run();
    }
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let run = 0; run < 5; run += 1) await runDispatcher(testEnv);
      expect(
        await db
          .prepare("SELECT COUNT(*) n FROM forecast_runtime_reviews WHERE action='approve'")
          .first(),
      ).toEqual({ n: 0 });
      expect(
        (
          await db
            .prepare(
              "SELECT state,attempts,next_attempt_at,error_code FROM forecast_runtime_admissions",
            )
            .all()
        ).results,
      ).toEqual(
        Array.from({ length: 5 }, () => ({
          state: "pending",
          attempts: 1,
          next_attempt_at: TEST_NOW + 5 * 60_000,
          error_code: expect.stringMatching(/^publication_/),
        })),
      );
      // Even when the failures are due again, an untried candidate gets priority.
      vi.setSystemTime(TEST_NOW + 5 * 60_000);
      await runDispatcher(testEnv);
      expect(
        await db
          .prepare(`SELECT r.candidate_id,o.state FROM forecast_runtime_reviews r
        JOIN forecast_runtime_outbox o ON o.review_id=r.review_id WHERE r.action='approve'`)
          .first(),
      ).toEqual({ candidate_id: valid.candidate.candidateId, state: "sent" });
      for (let attempt = 2; attempt <= 5; attempt += 1) {
        vi.setSystemTime(TEST_NOW + attempt * 5 * 60_000);
        for (let run = 0; run < 5; run += 1) await runDispatcher(testEnv);
      }
      const terminal = await db
        .prepare(
          "SELECT state,attempts,error_code FROM forecast_runtime_admissions WHERE candidate_id!=?",
        )
        .bind(valid.candidate.candidateId)
        .all();
      expect(terminal.results).toEqual(
        Array.from({ length: 5 }, () => ({
          state: "dead",
          attempts: 5,
          error_code: expect.stringMatching(/^publication_/),
        })),
      );
      expect(warnings).toHaveBeenCalledTimes(25);
      vi.setSystemTime(TEST_NOW + 60 * 60_000);
      await runDispatcher(testEnv);
      expect(warnings).toHaveBeenCalledTimes(25);
      expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    } finally {
      warnings.mockRestore();
    }
  });
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
    expect(
      await db.prepare("SELECT state,attempts,error_code FROM forecast_runtime_admissions").first(),
    ).toEqual({ state: "pending", attempts: 1, error_code: "publication_admission_unavailable" });
    vi.setSystemTime(TEST_NOW + 5 * 60_000);
    await runDispatcher(testEnv);
    expect(
      await db.prepare("SELECT state,attempts,error_code FROM forecast_runtime_admissions").first(),
    ).toEqual({ state: "ready", attempts: 2, error_code: "publication_admission_unavailable" });
    expect(
      await db
        .prepare("SELECT candidate_id FROM forecast_runtime_reviews WHERE action='approve'")
        .first(),
    ).toEqual({ candidate_id: candidate.candidateId });
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
    await seedCandidate(db, 2);
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
    // Also restore delivery for retained manual rows whose alert was never created.
    await testEnv.FORECAST_DB.prepare("DELETE FROM forecast_ops_alerts WHERE alert_key=?")
      .bind(manual.alertKey)
      .run();
    expect(await runDispatcher({ ...testEnv, PUBLICATION_MODE: "off" })).toEqual({
      status: "completed",
      sent: 4,
    });
    const messages = outbound.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    const review = messages.find((message) => message.components);
    expect(
      review.components[0].components.map((button: { custom_id?: string }) => button.custom_id),
    ).toContain(`forecast_manual_staging_requeue:${manual.reviewId}`);
    expect(
      review.components[0].components.map((button: { custom_id?: string }) => button.custom_id),
    ).toContain(`forecast_manual_staging_ignore:${manual.reviewId}`);
    await runDispatcher({ ...testEnv, PUBLICATION_MODE: "off" });
    expect(outbound).toHaveBeenCalledTimes(4);
    await resolveOpsAlert(testEnv.FORECAST_DB, "fixture:collector", TEST_NOW);
    await runDispatcher({ ...testEnv, PUBLICATION_MODE: "off" });
    expect(outbound).toHaveBeenCalledTimes(5);
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
