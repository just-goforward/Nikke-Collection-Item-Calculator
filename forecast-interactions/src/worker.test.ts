import {
  applyD1Migrations,
  createExecutionContext,
  reset,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyPublicationCommand } from "../../shared/forecast-publication/store.ts";
import {
  approvalReview,
  emergencyReview,
  migratePublicationDb,
  seedManualReview,
  TEST_NOW,
} from "../../shared/forecast-publication/test-fixtures.ts";
import { encodeBase64 } from "../../shared/forecastPublication.ts";
import { executeTestSql } from "../../shared/testD1Sql.ts";
import usageSchema from "../../usage-guard/schema.sql?raw";
import type { InteractionRouterEnv } from "./types.ts";
import worker from "./worker.ts";

let testEnv: InteractionRouterEnv;
let discordKey: CryptoKeyPair;
let webhook: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  await reset();
  vi.setSystemTime(TEST_NOW);
  testEnv = { ...env } as unknown as InteractionRouterEnv;
  for (const db of [testEnv.STAGING_FORECAST_DB, testEnv.PRODUCTION_FORECAST_DB])
    await migratePublicationDb(db, applyD1Migrations);
  await executeTestSql(testEnv.USAGE_GUARD_DB, usageSchema, applyD1Migrations);
  await testEnv.USAGE_GUARD_DB.prepare(`INSERT INTO usage_guard_state
    (singleton_id,action,observed_at,period_start,period_end,evidence_json,evidence_hash,
    current_percent,projected_percent,governing_metric,normal_streak,release_pending,updated_at)
    VALUES(1,'normal',?,'2026-10-01T00:00:00.000Z','2026-11-01T00:00:00.000Z','{}',?,0,0,'workerRequests',2,0,?)`)
    .bind(new Date(TEST_NOW).toISOString(), "0".repeat(64), new Date(TEST_NOW).toISOString())
    .run();
  discordKey = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  testEnv.DISCORD_PUBLIC_KEY = hex(await crypto.subtle.exportKey("raw", discordKey.publicKey));
  const signing = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  testEnv.FORECAST_PUBLICATION_SIGNING_KEY = encodeBase64(
    new Uint8Array(await crypto.subtle.exportKey("pkcs8", signing.privateKey)),
  );
  webhook = vi.fn().mockImplementation(async () => Response.json({ id: "777777777" }));
  vi.stubGlobal("fetch", webhook);
});
function interaction(customId: string, overrides: object = {}) {
  return {
    id: "1001",
    application_id: testEnv.DISCORD_APPLICATION_ID,
    token: "test-token",
    type: 3,
    guild_id: testEnv.DISCORD_GUILD_ID,
    channel_id: testEnv.DISCORD_APPROVAL_CHANNEL_ID,
    member: { user: { id: testEnv.DISCORD_FORECAST_APPROVER_USER_ID } },
    message: { id: "666666666" },
    data: { custom_id: customId, component_type: 2 },
    ...overrides,
  };
}
async function request(value: object, overrides: Partial<InteractionRouterEnv> = {}) {
  const body = JSON.stringify(value);
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = await crypto.subtle.sign(
    "Ed25519",
    discordKey.privateKey,
    new TextEncoder().encode(timestamp + body),
  );
  const context = createExecutionContext();
  const response = await worker.fetch(
    new Request("https://router.test/discord/interactions", {
      method: "POST",
      body,
      headers: { "x-signature-ed25519": hex(signature), "x-signature-timestamp": timestamp },
    }),
    { ...testEnv, ...overrides },
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}
function hex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function custom(reviewId: string, environment = "staging") {
  return `forecast_publish:${environment}:${reviewId}`;
}
async function count(db = testEnv.STAGING_FORECAST_DB) {
  return db.prepare("SELECT COUNT(*) n FROM forecast_runtime_activation_history").first();
}

describe("new publication Router", () => {
  it("preserves the read-only health/readiness contract", async () => {
    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://router.test/health"),
      testEnv,
      context,
    );
    expect(await response.json()).toMatchObject({
      status: "ok",
      deploymentSha: "test-router-sha",
      productionMutationsEnabled: false,
      databases: { staging: { schemaVersion: 23 }, production: { schemaVersion: 23 } },
    });
    expect(webhook).not.toHaveBeenCalled();
  });
  it.each([
    "forecast_test_approve:old",
    "forecast_staging_approve:old",
    "forecast_manual_staging_requeue:old",
    "forecast_router_test:old",
  ])("disables legacy %s without DB writes", async (id) => {
    const response = await request(interaction(id));
    expect(await response.json()).toMatchObject({
      type: 4,
      data: { content: expect.stringContaining("disabled") },
    });
    expect(await count()).toEqual({ n: 0 });
    expect(
      await testEnv.STAGING_FORECAST_DB.prepare(
        "SELECT COUNT(*) n FROM forecast_runtime_commands",
      ).first(),
    ).toEqual({ n: 0 });
    expect(webhook).not.toHaveBeenCalled();
  });
  it("authenticates the one guild approver, channel, application and signature", async () => {
    const a = await approvalReview(testEnv.STAGING_FORECAST_DB);
    for (const bad of [
      { member: { user: { id: "123" } } },
      { guild_id: "wrong" },
      { channel_id: "wrong" },
      { member: undefined, user: { id: testEnv.DISCORD_FORECAST_APPROVER_USER_ID } },
    ]) {
      expect(await (await request(interaction(custom(a.reviewId), bad))).json()).toMatchObject({
        type: 4,
      });
    }
    expect(
      (await request(interaction(custom(a.reviewId), { application_id: "wrong" }))).status,
    ).toBe(401);
    const context = createExecutionContext();
    expect(
      (
        await worker.fetch(
          new Request("https://router.test/discord/interactions", { method: "POST", body: "{}" }),
          testEnv,
          context,
        )
      ).status,
    ).toBe(401);
    expect(await count()).toEqual({ n: 0 });
  });
  it("keeps production off even when the old mutations flag is enabled", async () => {
    const a = await approvalReview(testEnv.STAGING_FORECAST_DB);
    expect(
      await (
        await request(interaction(custom(a.reviewId, "production")), {
          PRODUCTION_MUTATIONS_ENABLED: "true",
        })
      ).json(),
    ).toMatchObject({ type: 4, data: { content: expect.stringContaining("disabled") } });
    expect(await count(testEnv.PRODUCTION_FORECAST_DB)).toEqual({ n: 0 });
    expect(await count()).toEqual({ n: 0 });
  });
});

describe("human-triggered rollback confirmation", () => {
  it("offers exact previous-target rollback on approval without Cron and confirms it during hard-stop", async () => {
    const db = testEnv.STAGING_FORECAST_DB;
    const a = await approvalReview(db);
    await request(interaction(custom(a.reviewId), { id: "1101" }));
    const b = await approvalReview(db, 2);
    await request(interaction(custom(b.reviewId), { id: "1102" }));
    await testEnv.USAGE_GUARD_DB.prepare("UPDATE usage_guard_state SET action='hard_stop'").run();
    expect(await count()).toEqual({ n: 2 });
    const response = JSON.parse(String(webhook.mock.calls.at(-1)?.[1]?.body));
    expect(response.content).toContain("approve applied at sequence 2");
    expect(response.content).toContain("Confirm rollback against CURRENT sequence 2");
    expect(response.content).toContain(`Candidate: ${a.candidate.candidateId}`);
    expect(response.content).toContain(`SHA-256: ${a.hash}`);
    const rollbackCustomId = response.components[0].components[0].custom_id;
    expect(response.components[0].components[0].label).toBe("Confirm rollback (staging)");
    expect(response.components[0].components[1].label).toBe("Confirm off (staging)");
    expect(
      await db
        .prepare(`SELECT r.action,r.candidate_id,r.payload_hash,r.expected_sequence,
        r.previous_candidate_id,o.state,o.message_id FROM forecast_runtime_reviews r
        JOIN forecast_runtime_outbox o ON o.review_id=r.review_id WHERE r.review_id=?`)
        .bind(rollbackCustomId.split(":")[2])
        .first(),
    ).toEqual({
      action: "rollback",
      candidate_id: a.candidate.candidateId,
      payload_hash: a.hash,
      expected_sequence: 2,
      previous_candidate_id: b.candidate.candidateId,
      state: "sent",
      message_id: "777777777",
    });
    // The control remains subject to the same approver and exact message binding.
    expect(
      await (
        await request(
          interaction(rollbackCustomId, {
            id: "1103",
            member: { user: { id: "123" } },
            message: { id: "777777777" },
          }),
        )
      ).json(),
    ).toMatchObject({ type: 4 });
    await request(interaction(rollbackCustomId, { id: "1104", message: { id: "888888888" } }));
    expect(String(webhook.mock.calls.at(-1)?.[1]?.body)).toContain("publication_review_binding");
    expect(await count()).toEqual({ n: 2 });
    await request(interaction(rollbackCustomId, { id: "1105", message: { id: "777777777" } }));
    expect(await count()).toEqual({ n: 3 });
    const active = await db
      .prepare("SELECT sequence,candidate_id,signed_pointer_json FROM forecast_runtime_active")
      .first<{ sequence: number; candidate_id: string; signed_pointer_json: string }>();
    expect(active).toMatchObject({ sequence: 3, candidate_id: a.candidate.candidateId });
    expect(JSON.parse(active?.signed_pointer_json ?? "{}").statement).toMatchObject({
      sequence: 3,
      candidateId: a.candidate.candidateId,
      contentHash: a.hash,
    });
    await request(interaction(rollbackCustomId, { id: "1105", message: { id: "777777777" } }));
    expect(await count()).toEqual({ n: 3 });
    expect(String(webhook.mock.calls.at(-1)?.[1]?.body)).toContain("already applied");
    // Replaying approval B must not offer an inverse rollback for the now-current A.
    await request(interaction(custom(b.reviewId), { id: "1102" }));
    expect(JSON.parse(String(webhook.mock.calls.at(-1)?.[1]?.body)).components).toEqual([]);
    expect(await count()).toEqual({ n: 3 });
  });
});

describe("durable emergency controls without Cron", () => {
  it("keeps first-activation off and subsequent rollback confirmations public, bound and usable during hard-stop", async () => {
    const db = testEnv.STAGING_FORECAST_DB;
    const a = await approvalReview(db);
    const activation = await request(interaction(custom(a.reviewId), { id: "1201" }));
    expect(await activation.json()).toEqual({ type: 5, data: { flags: 0 } });
    const firstMessage = JSON.parse(String(webhook.mock.calls.at(-1)?.[1]?.body));
    expect(firstMessage.content).toContain("Activation operation: 1201");
    expect(firstMessage.components[0].components).toHaveLength(1);
    const offButton = firstMessage.components[0].components[0];
    expect(offButton.label).toBe("Confirm off (staging)");
    expect(
      await db
        .prepare(`SELECT r.expected_sequence,r.previous_candidate_id,r.review_key,
      o.state,o.message_id,o.channel_id FROM forecast_runtime_reviews r
      JOIN forecast_runtime_outbox o ON o.review_id=r.review_id WHERE r.review_id=?`)
        .bind(offButton.custom_id.split(":")[2])
        .first(),
    ).toEqual({
      expected_sequence: 1,
      previous_candidate_id: a.candidate.candidateId,
      review_key: expect.stringContaining(":1201"),
      state: "sent",
      message_id: "777777777",
      channel_id: testEnv.DISCORD_APPROVAL_CHANNEL_ID,
    });
    await testEnv.USAGE_GUARD_DB.prepare("UPDATE usage_guard_state SET action='hard_stop'").run();
    // A fresh signed request/context models a reloaded client: only persisted message
    // and review identities are needed. No Cron or manually seeded emergency review.
    const off = await request(
      interaction(offButton.custom_id, {
        id: "1202",
        message: { id: "777777777" },
      }),
    );
    expect(await off.json()).toEqual({ type: 5, data: { flags: 0 } });
    expect(
      await db.prepare("SELECT sequence,candidate_id FROM forecast_runtime_active").first(),
    ).toEqual({ sequence: 2, candidate_id: null });
    const offMessage = JSON.parse(String(webhook.mock.calls.at(-1)?.[1]?.body));
    expect(offMessage.content).toContain("Activation operation: 1202");
    expect(offMessage.content).toContain(`Candidate: ${a.candidate.candidateId}`);
    expect(offMessage.content).toContain(`SHA-256: ${a.hash}`);
    expect(offMessage.components[0].components).toHaveLength(1);
    const rollbackButton = offMessage.components[0].components[0];
    expect(rollbackButton.label).toBe("Confirm rollback (staging)");
    await request(
      interaction(rollbackButton.custom_id, {
        id: "1203",
        message: { id: "777777777" },
      }),
    );
    expect(
      await db.prepare("SELECT sequence,candidate_id FROM forecast_runtime_active").first(),
    ).toEqual({ sequence: 3, candidate_id: a.candidate.candidateId });
    const rollbackMessage = JSON.parse(String(webhook.mock.calls.at(-1)?.[1]?.body));
    expect(rollbackMessage.content).toContain("Confirm off against CURRENT sequence 3");
    expect(await count()).toEqual({ n: 3 });
  });
});

describe("publication emergency controls and delivery recovery", () => {
  it("blocks approval on stop but allows signed off and rollback", async () => {
    const db = testEnv.STAGING_FORECAST_DB;
    const a = await approvalReview(db);
    const signing = {
      privateKey: testEnv.FORECAST_PUBLICATION_SIGNING_KEY ?? "",
      keyId: testEnv.FORECAST_PUBLICATION_KEY_ID,
    };
    await applyPublicationCommand(
      db,
      {
        interactionId: "9001",
        reviewId: a.reviewId,
        environment: "staging",
        actorId: testEnv.DISCORD_FORECAST_APPROVER_USER_ID,
        messageId: "666666666",
        channelId: "333333333",
      },
      signing,
      TEST_NOW,
    );
    const b = await approvalReview(db, 2);
    await testEnv.USAGE_GUARD_DB.prepare("UPDATE usage_guard_state SET action='hard_stop'").run();
    await request(interaction(custom(b.reviewId)));
    expect(await count()).toEqual({ n: 1 });
    expect(
      await db
        .prepare("SELECT state FROM forecast_runtime_commands WHERE interaction_id='1001'")
        .first(),
    ).toEqual({ state: "failed" });
    const off = await emergencyReview(db, "off");
    vi.setSystemTime(TEST_NOW + 2 * 24 * 60 * 60_000);
    await request(interaction(custom(off), { id: "1002" }));
    expect(await count()).toEqual({ n: 1 });
    const refreshedOff = await db
      .prepare(`SELECT review_id FROM forecast_runtime_reviews
      WHERE action='off' AND created_at=?`)
      .bind(Date.now())
      .first<{ review_id: string }>();
    expect(refreshedOff).not.toBeNull();
    await request(
      interaction(custom(refreshedOff!.review_id), { id: "1004", message: { id: "777777777" } }),
    );
    expect(await count()).toEqual({ n: 2 });
    const rollback = await emergencyReview(db, "rollback", a.candidate.candidateId);
    await testEnv.USAGE_GUARD_DB.prepare("DELETE FROM usage_guard_state").run();
    await request(interaction(custom(rollback), { id: "1003" }));
    expect(await count()).toEqual({ n: 2 });
    const refreshedRollback = await db
      .prepare(`SELECT review_id FROM forecast_runtime_reviews
      WHERE action='rollback' AND created_at=?`)
      .bind(Date.now())
      .first<{ review_id: string }>();
    expect(refreshedRollback).not.toBeNull();
    await request(
      interaction(custom(refreshedRollback!.review_id), {
        id: "1005",
        message: { id: "777777777" },
      }),
    );
    expect(await count()).toEqual({ n: 3 });
    expect(
      await db.prepare("SELECT sequence,candidate_id FROM forecast_runtime_active").first(),
    ).toEqual({ sequence: 3, candidate_id: a.candidate.candidateId });
  });
  it("refreshes a stale emergency pointer without applying it, even when Cron is stopped", async () => {
    const db = testEnv.STAGING_FORECAST_DB;
    const a = await approvalReview(db);
    const off = await emergencyReview(db, "off");
    await request(interaction(custom(a.reviewId)));
    await testEnv.USAGE_GUARD_DB.prepare("UPDATE usage_guard_state SET action='hard_stop'").run();
    await request(interaction(custom(off), { id: "1002" }));
    expect(await count()).toEqual({ n: 1 });
    const next = await db
      .prepare(
        "SELECT review_id FROM forecast_runtime_reviews WHERE action='off' AND expected_sequence=1",
      )
      .first<{ review_id: string }>();
    expect(next).not.toBeNull();
    await request(
      interaction(custom(next!.review_id), { id: "1003", message: { id: "777777777" } }),
    );
    expect(await count()).toEqual({ n: 2 });
    const reviewsBeforeReplay = await db
      .prepare("SELECT COUNT(*) n FROM forecast_runtime_reviews")
      .first();
    await request(
      interaction(custom(next!.review_id), { id: "1003", message: { id: "777777777" } }),
    );
    expect(await db.prepare("SELECT COUNT(*) n FROM forecast_runtime_reviews").first()).toEqual(
      reviewsBeforeReplay,
    );
    expect(String(webhook.mock.calls.at(-1)?.[1]?.body)).toContain("already applied");
  });
  it("retains committed outcome and durable result when Discord fails after DB commit", async () => {
    const a = await approvalReview(testEnv.STAGING_FORECAST_DB);
    webhook.mockRejectedValueOnce(new Error("connection lost"));
    expect(await (await request(interaction(custom(a.reviewId)))).json()).toEqual({
      type: 5,
      data: { flags: 0 },
    });
    expect(await count()).toEqual({ n: 1 });
    expect(
      await testEnv.STAGING_FORECAST_DB.prepare(
        "SELECT state FROM forecast_runtime_outbox WHERE kind='result'",
      ).first(),
    ).toEqual({ state: "pending" });
    await request(interaction(custom(a.reviewId)));
    expect(await count()).toEqual({ n: 1 });
    expect(String(webhook.mock.calls.at(-1)?.[1]?.body)).toContain("already applied");
  });
  it("returns signing failure to Discord while leaving the original review retryable", async () => {
    const a = await approvalReview(testEnv.STAGING_FORECAST_DB);
    for (const key of ["", "invalid"]) {
      const response = await request(interaction(custom(a.reviewId)), {
        FORECAST_PUBLICATION_SIGNING_KEY: key,
      });
      expect(await response.json()).toMatchObject({
        type: 4,
        data: {
          content: expect.stringContaining("publication_signing_key_unavailable"),
        },
      });
      expect(await count()).toEqual({ n: 0 });
      expect(
        await testEnv.STAGING_FORECAST_DB.prepare(
          "SELECT COUNT(*) n FROM forecast_runtime_commands",
        ).first(),
      ).toEqual({ n: 0 });
    }
    expect(webhook).not.toHaveBeenCalled();
    await request(interaction(custom(a.reviewId)));
    expect(await count()).toEqual({ n: 1 });
  });
});

describe("retained D1-only manual-review controls", () => {
  it.each(["requeue", "ignore"] as const)(
    "handles %s with publication off and without a signing key",
    async (decision) => {
      delete testEnv.FORECAST_PUBLICATION_SIGNING_KEY;
      testEnv.STAGING_PUBLICATION_MODE = "off";
      const { reviewId } = await seedManualReview(testEnv.STAGING_FORECAST_DB, true);
      const value = interaction(`forecast_manual_staging_${decision}:${reviewId}`, {
        channel_id: testEnv.DISCORD_ALERT_CHANNEL_ID,
      });
      expect(await (await request(value)).json()).toEqual({ type: 5, data: { flags: 64 } });
      expect(
        await testEnv.STAGING_FORECAST_DB.prepare(
          "SELECT status,review_generation FROM source_queue WHERE item_id='200'",
        ).first(),
      ).toEqual({
        status: decision === "requeue" ? "pending" : "ignored",
        review_generation: decision === "requeue" ? 1 : 0,
      });
      expect(
        await testEnv.STAGING_FORECAST_DB.prepare(
          "SELECT state,decision,actor FROM source_manual_reviews",
        ).first(),
      ).toEqual({
        state: "resolved",
        decision,
        actor: `discord:${testEnv.DISCORD_FORECAST_APPROVER_USER_ID}`,
      });
      expect(
        await testEnv.STAGING_FORECAST_DB.prepare(
          "SELECT result FROM discord_interaction_audit",
        ).first(),
      ).toEqual({ result: "completed" });
      await request(value);
      expect(
        await testEnv.STAGING_FORECAST_DB.prepare(
          "SELECT COUNT(*) n FROM discord_interaction_audit",
        ).first(),
      ).toEqual({ n: 1 });
      expect(await count()).toEqual({ n: 0 });
    },
  );
  it("rejects unauthorized, unbound, production-disabled and quota-stopped manual decisions", async () => {
    const { reviewId } = await seedManualReview(testEnv.STAGING_FORECAST_DB, true);
    const button = `forecast_manual_staging_requeue:${reviewId}`;
    for (const overrides of [
      { member: { user: { id: "123" } } },
      { guild_id: "wrong" },
      { channel_id: "wrong" },
      { message: { id: "999999999" } },
    ]) {
      expect(
        await (
          await request(
            interaction(button, {
              channel_id: testEnv.DISCORD_ALERT_CHANNEL_ID,
              ...overrides,
            }),
          )
        ).json(),
      ).toMatchObject({ type: 4 });
    }
    expect(
      await (
        await request(
          interaction(`forecast_manual_production_requeue:${reviewId}`, {
            channel_id: testEnv.DISCORD_ALERT_CHANNEL_ID,
          }),
        )
      ).json(),
    ).toMatchObject({ type: 4 });
    await testEnv.USAGE_GUARD_DB.prepare("UPDATE usage_guard_state SET action='hard_stop'").run();
    expect(
      await (
        await request(interaction(button, { channel_id: testEnv.DISCORD_ALERT_CHANNEL_ID }))
      ).json(),
    ).toMatchObject({ type: 4, data: { content: expect.stringContaining("Usage Guard") } });
    expect(
      await testEnv.STAGING_FORECAST_DB.prepare("SELECT state FROM source_manual_reviews").first(),
    ).toEqual({ state: "pending" });
    expect(
      await testEnv.STAGING_FORECAST_DB.prepare(
        "SELECT COUNT(*) n FROM discord_interaction_audit",
      ).first(),
    ).toEqual({ n: 0 });
    expect(webhook).not.toHaveBeenCalled();
  });
});
