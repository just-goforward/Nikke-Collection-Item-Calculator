import {
  applyD1Migrations,
  createExecutionContext,
  reset,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as coverage from "../../shared/certifiedEvidenceCoverage.ts";
import * as publicationStore from "../../shared/forecast-publication/store.ts";
import { applyPublicationCommand } from "../../shared/forecast-publication/store.ts";
import {
  approvalReview,
  emergencyReview,
  migratePublicationDb,
  TEST_NOW,
} from "../../shared/forecast-publication/test-fixtures.ts";
import { encodeBase64 } from "../../shared/forecastPublication.ts";
import { executeTestSql } from "../../shared/testD1Sql.ts";
import usageSchema from "../../usage-guard/schema.sql?raw";
import type { InteractionRouterEnv } from "./types.ts";
import worker from "./worker.ts";

type SharedRouterTestEnv = InteractionRouterEnv & { PRODUCTION_FORECAST_DB: D1Database };
let testEnv: SharedRouterTestEnv;
let discordKey: CryptoKeyPair;
let webhook: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  await reset();
  vi.setSystemTime(TEST_NOW);
  testEnv = { ...env } as unknown as SharedRouterTestEnv;
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
async function request(
  value: object,
  overrides: Partial<InteractionRouterEnv> = {},
  routerEnv: InteractionRouterEnv = testEnv,
) {
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
    Object.defineProperties(
      {},
      {
        ...Object.getOwnPropertyDescriptors(routerEnv),
        ...Object.getOwnPropertyDescriptors(overrides),
      },
    ) as InteractionRouterEnv,
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
    ...["staging", "production"].flatMap((environment) =>
      ["requeue", "ignore", "cancel", "requeue_confirm", "ignore_confirm", "cancel_confirm"].map(
        (action) => `forecast_manual_${environment}_${action}:mr-${"a".repeat(32)}`,
      ),
    ),
  ])("disables legacy %s without DB writes", async (id) => {
    const prepare = vi.fn(() => {
      throw new Error("legacy_interaction_must_not_access_database");
    });
    const database = { prepare } as unknown as D1Database;
    const response = await request(interaction(id), {
      STAGING_FORECAST_DB: database,
      PRODUCTION_FORECAST_DB: database,
      USAGE_GUARD_DB: database,
      PRODUCTION_MUTATIONS_ENABLED: "true",
    });
    expect(await response.json()).toMatchObject({
      type: 4,
      data: { flags: 64, content: expect.stringContaining("disabled") },
    });
    expect(prepare).not.toHaveBeenCalled();
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
  it("rejects a signed but unparseable body with 400 before any dispatch", async () => {
    const body = "not-json{";
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
      testEnv,
      context,
    );
    await waitOnExecutionContext(context);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid JSON");
    expect(webhook).not.toHaveBeenCalled();
  });

  it("rejects a forged signature without logging attacker-controlled detail", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const body = "{}";
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://router.test/discord/interactions", {
        method: "POST",
        body,
        headers: {
          "x-signature-ed25519": "a".repeat(128),
          "x-signature-timestamp": timestamp,
        },
      }),
      testEnv,
      context,
    );
    await waitOnExecutionContext(context);

    expect(response.status).toBe(401);
    // An ordinary invalid signature is a routine 401 and is not logged at all.
    expect(warning).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
    warning.mockRestore();
    errorLog.mockRestore();
  });

  it("serves 401 when signature verification itself rejects, and logs a bad configured key", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const a = await approvalReview(testEnv.STAGING_FORECAST_DB);
    // An unusable configured public key is a misconfiguration, not attacker input.
    errorLog.mockClear();
    const request = new Request("https://router.test/discord/interactions", {
      method: "POST",
      body: JSON.stringify(interaction(custom(a.reviewId))),
      headers: {
        "x-signature-ed25519": "b".repeat(128),
        "x-signature-timestamp": String(Math.floor(Date.now() / 1_000)),
      },
    });
    const verify = vi
      .spyOn(crypto.subtle, "importKey")
      .mockRejectedValue(new Error("SENTINEL_key_import_secret"));
    const failing = await worker.fetch(request, testEnv, createExecutionContext());
    expect(failing.status).toBe(401);
    verify.mockRestore();
    // A rejected crypto.subtle.verify is also just "not verified".
    const rejectVerify = vi
      .spyOn(crypto.subtle, "verify")
      .mockRejectedValue(new Error("SENTINEL_verify_secret"));
    const rejected = await worker.fetch(request, testEnv, createExecutionContext());
    expect(rejected.status).toBe(401);
    rejectVerify.mockRestore();

    const logged = JSON.stringify(errorLog.mock.calls);
    expect(logged).toContain("discord_public_key_unusable");
    expect(logged).not.toContain("SENTINEL_key_import_secret");
    errorLog.mockRestore();
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

describe("isolated staging Router", () => {
  let stagingEnv: InteractionRouterEnv;
  beforeEach(() => {
    stagingEnv = { ...testEnv, FORECAST_ENVIRONMENT: "staging" };
    Object.defineProperty(stagingEnv, "PRODUCTION_FORECAST_DB", {
      get() {
        throw new Error("staging must never look up the production binding");
      },
      enumerable: true,
      configurable: true,
    });
    // A missing binding must fail closed independently of the configured flags.
    stagingEnv.PRODUCTION_MUTATIONS_ENABLED = "true";
    stagingEnv.PRODUCTION_PUBLICATION_MODE = "enabled";
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    `forecast_publish:production:${"a".repeat(32)}`,
    `forecast_manual_production_requeue:mr-${"a".repeat(32)}`,
    `forecast_manual_production_ignore:mr-${"a".repeat(32)}`,
  ])("rejects %s before database access or deferred work", async (customId) => {
    const reads = [
      stagingEnv.STAGING_FORECAST_DB,
      testEnv.PRODUCTION_FORECAST_DB,
      stagingEnv.USAGE_GUARD_DB,
    ].map((db) => vi.spyOn(db, "prepare"));
    const response = await request(
      interaction(customId, {
        channel_id: customId.startsWith("forecast_manual_")
          ? stagingEnv.DISCORD_ALERT_CHANNEL_ID
          : stagingEnv.DISCORD_APPROVAL_CHANNEL_ID,
      }),
      {},
      stagingEnv,
    );
    expect(await response.json()).toEqual({
      type: 4,
      data: {
        content: "production actions are disabled on this deployment. No changes were made.",
        flags: 64,
      },
    });
    for (const read of reads) expect(read).not.toHaveBeenCalled();
    expect(webhook).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "checks staging-only health with signing key available=%s",
    async (keyAvailable) => {
      if (!keyAvailable) delete stagingEnv.FORECAST_PUBLICATION_SIGNING_KEY;
      const productionReads = vi.spyOn(testEnv.PRODUCTION_FORECAST_DB, "prepare");
      const response = await worker.fetch(
        new Request("https://router.test/health"),
        stagingEnv,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        status: "ok",
        deploymentSha: "test-router-sha",
        productionMutationsEnabled: false,
        stagingPublication: keyAvailable,
        productionPublication: false,
        publicationError: keyAvailable ? null : "publication_signing_key_unavailable",
        databases: { staging: { schemaVersion: 23, latestInteraction: null } },
      });
      expect(productionReads).not.toHaveBeenCalled();
      expect(webhook).not.toHaveBeenCalled();
    },
  );

  it("keeps staging publication opt-in and usable without a production binding", async () => {
    const { reviewId } = await approvalReview(stagingEnv.STAGING_FORECAST_DB);
    expect(
      await (
        await request(
          interaction(custom(reviewId)),
          { STAGING_PUBLICATION_MODE: "off" },
          stagingEnv,
        )
      ).json(),
    ).toMatchObject({ type: 4, data: { content: expect.stringContaining("disabled") } });
    expect(await count()).toEqual({ n: 0 });
    expect(await (await request(interaction(custom(reviewId)), {}, stagingEnv)).json()).toEqual({
      type: 5,
      data: { flags: 0 },
    });
    expect(await count()).toEqual({ n: 1 });
    expect(await count(testEnv.PRODUCTION_FORECAST_DB)).toEqual({ n: 0 });
  });
});

describe("human-triggered rollback confirmation", () => {
  it.each([
    ["legacy", false],
    ["legacy", true],
    ["uncovered", false],
    ["uncovered", true],
    ["covered", false],
  ] as const)("refresh policy %s expired=%s", async (policy, expired) => {
    const db = testEnv.STAGING_FORECAST_DB;
    const a = await approvalReview(db);
    await request(interaction(custom(a.reviewId), { id: "1301" }));
    const rollback = await emergencyReview(db, "rollback", a.candidate.candidateId);
    const b = await approvalReview(db, 2);
    await request(interaction(custom(b.reviewId), { id: "1302" }));
    if (expired) vi.setSystemTime(TEST_NOW + 2 * 24 * 60 * 60_000);
    const state = () =>
      db
        .prepare(`SELECT
        (SELECT sequence FROM forecast_runtime_active) sequence,
        (SELECT candidate_id FROM forecast_runtime_active) candidate,
        (SELECT COUNT(*) FROM forecast_runtime_approvals) approvals,
        (SELECT COUNT(*) FROM forecast_runtime_activation_history) history`)
        .first();
    const controls = () =>
      db
        .prepare(`SELECT
        (SELECT COUNT(*) FROM forecast_runtime_reviews) reviews,
        (SELECT COUNT(*) FROM forecast_runtime_outbox) outbox`)
        .first<{
          reviews: number;
          outbox: number;
        }>();
    const before = await state();
    const beforeControls = await controls();
    const sealed = await publicationStore.readSealedCandidate(db, a.candidate.candidateId);
    // Simulate immutable pre-policy target content at the sealed-reader boundary.
    const reader = vi.spyOn(publicationStore, "readSealedCandidate");
    if (policy === "legacy") {
      const snapshot = sealed.candidate.certifiedSnapshot;
      if (!snapshot) throw new Error("fixture_snapshot_missing");
      reader.mockResolvedValue({
        ...sealed,
        candidate: {
          ...sealed.candidate,
          certifiedSnapshot: {
            ...snapshot,
            cadence: { ...snapshot.cadence, version: "observed-mean-thursday-v1" },
          },
        },
      });
    }
    const gate = vi.spyOn(coverage, "hasCertifiedEvidenceCoverage");
    if (policy === "uncovered") gate.mockReturnValue(false);
    try {
      await request(interaction(custom(rollback), { id: "1303" }));
      expect(await state()).toEqual(before);
      const body = JSON.parse(String(webhook.mock.calls.at(-1)?.[1]?.body));
      if (policy === "covered") {
        expect(await controls()).toEqual({
          reviews: Number(beforeControls?.reviews) + 1,
          outbox: Number(beforeControls?.outbox) + 1,
        });
        expect(body.components?.length).toBeGreaterThan(0);
      } else {
        expect(await controls()).toEqual(beforeControls);
        expect(body.components ?? []).toEqual([]);
        expect(body.content).toContain("nothing was published");
        expect(body.content).toContain(
          expired ? "publication_review_expired" : "publication_review_stale",
        );
      }
    } finally {
      reader.mockRestore();
      gate.mockRestore();
    }
  });
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

describe("stale activation re-confirmation is decided by the registered trigger token", () => {
  it.each([
    ["driver layout", "D1_ERROR: runtime_activation_stale: SQLITE_CONSTRAINT"],
    [
      "extended result code",
      "D1_ERROR: runtime_activation_stale: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)",
    ],
    [
      "prefixed variant",
      "Error: D1_ERROR: runtime_activation_stale: SQLITE_CONSTRAINT: SENTINEL_layout_9f3a",
    ],
  ])("re-confirms a stale activation whatever the %s of the trigger abort", async (_, message) => {
    const db = testEnv.STAGING_FORECAST_DB;
    const a = await approvalReview(db);
    const off = await emergencyReview(db, "off");
    await request(interaction(custom(a.reviewId)));
    const reviews = () =>
      db.prepare("SELECT COUNT(*) n FROM forecast_runtime_reviews").first<{ n: number }>();
    const before = await reviews();
    // The branch is decided by comparing the registered token against the message, not
    // by the exact shape the sanitizer recognises.
    const apply = vi
      .spyOn(publicationStore, "applyPublicationCommand")
      .mockRejectedValueOnce(new Error(message));
    try {
      await request(interaction(custom(off), { id: "1002" }));
    } finally {
      apply.mockRestore();
    }
    expect(await count()).toEqual({ n: 1 });
    expect(await reviews()).toEqual({ n: Number(before?.n) + 1 });
    const body = String(webhook.mock.calls.at(-1)?.[1]?.body);
    expect(body).toContain("the emergency review was stale/expired. Nothing was published.");
    expect(body).not.toContain("SENTINEL_layout_9f3a");
    expect(body).not.toContain("D1_ERROR");
  });
  it("does not re-confirm when the token is only a fragment of an unregistered abort", async () => {
    const db = testEnv.STAGING_FORECAST_DB;
    const a = await approvalReview(db);
    const off = await emergencyReview(db, "off");
    await request(interaction(custom(a.reviewId)));
    const reviews = () =>
      db.prepare("SELECT COUNT(*) n FROM forecast_runtime_reviews").first<{ n: number }>();
    const before = await reviews();
    const apply = vi
      .spyOn(publicationStore, "applyPublicationCommand")
      .mockRejectedValueOnce(
        new Error("D1_ERROR: runtime_activation_stale_sentinel_9f3a: SQLITE_CONSTRAINT"),
      );
    try {
      await request(interaction(custom(off), { id: "1002" }));
    } finally {
      apply.mockRestore();
    }
    expect(await count()).toEqual({ n: 1 });
    expect(await reviews()).toEqual(before);
    const body = String(webhook.mock.calls.at(-1)?.[1]?.body);
    // Rendered from the registry: the fixed D1 category, never the unregistered token.
    expect(body).toContain("Publication not applied (D1_ERROR)");
    expect(body).not.toContain("sentinel_9f3a");
  });
});
