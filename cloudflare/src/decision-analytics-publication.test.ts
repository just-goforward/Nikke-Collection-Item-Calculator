import { applyD1Migrations } from "cloudflare:test";
import { env as bindings } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCertifiedForecastIdentity } from "../../shared/certifiedForecastIdentity";
import { viewCertifiedSupplySnapshot } from "../../shared/certifiedSupply";
import { type Bands, type DecisionEnvelope, type StageData } from "../../shared/decisionAnalyticsV3";
import {
  applyPublicationCommand, createReview, initializePublication, readActive, sealCandidate,
} from "../../shared/forecast-publication/store";
import { TEST_PUBLICATION_COVERAGE } from "../../shared/forecast-publication/test-coverage";
import { migratePublicationDb, seedCandidate, TEST_NOW } from "../../shared/forecast-publication/test-fixtures";
import { encodeBase64 } from "../../shared/forecastPublication";
import { CERTIFIED_ENGINE_CODE_HASH } from "../../shared/generated/certifiedEngineBuild";
import { executeTestSql } from "../../shared/testD1Sql";
import type { ForecastEnv } from "../../site-worker/src/forecast";
import schema from "../decision-analytics/0001_decision_analytics_v3.proposed.sql?raw";
import { handleDecisionEvent, cleanupDecisionAnalytics } from "./decision-analytics";
import {
  createProductionDecisionResolver, type DecisionMetadataInstallation,
} from "./decision-analytics-publication";
import type { WorkerEnv } from "./env";
import { WorkerTestHarness } from "./worker.test-harness";

const harness = new WorkerTestHarness();
const producer = { producerVersion: "TEST-ONLY-public-mapping", producerCodeHash: CERTIFIED_ENGINE_CODE_HASH };
const bands: Bands = { blue: "zero", purple: "one_to_nine", yellow: "ten_to_forty_nine" };
let clock: number;
let env: WorkerEnv & ForecastEnv;
let signing: { privateKey: string; keyId: string };
let installation: DecisionMetadataInstallation;
let publication: Awaited<ReturnType<typeof seedCandidate>>;

async function approve(revision: number) {
  const candidate = await seedCandidate(harness.database, revision);
  const active = await initializePublication(harness.database, "production");
  await sealCandidate(harness.database, candidate.candidate.candidateId, TEST_NOW);
  const reviewId = await createReview(harness.database, active, "approve",
    candidate.candidate.candidateId, candidate.hash, TEST_NOW);
  await harness.database.prepare(`UPDATE forecast_runtime_outbox
    SET state='sent',message_id='666666666',channel_id='333333333' WHERE review_id=? AND kind='review'`)
    .bind(reviewId).run();
  await applyPublicationCommand(harness.database, {
    reviewId, interactionId: String(1000 + revision), environment: "production",
    actorId: "987654321", messageId: "666666666", channelId: "333333333",
  }, signing, TEST_NOW, undefined, TEST_PUBLICATION_COVERAGE);
  return candidate;
}

function calculation(hash = publication.hash): StageData["calculation"] {
  return { ...producer, publicationContentHash: hash, currentAction: "use_blue",
    waitRecommended: true, holdings: bands, expectedSupply: bands };
}
function request(payload?: DecisionEnvelope) {
  return new Request("https://test.example/api/decision-events", {
    method: "POST", headers: {
      Origin: "https://test.example", "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.1",
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
}

beforeEach(async () => {
  clock = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  await harness.setup();
  await migratePublicationDb(harness.database, applyD1Migrations);
  await executeTestSql(harness.database, schema, applyD1Migrations);
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
  signing = {
    privateKey: encodeBase64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey))),
    keyId: "test-only-publication-key",
  };
  installation = {
    producer,
    trust: { environment: "production", keyId: signing.keyId,
      publicKeyBase64: encodeBase64(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey))) },
    // Explicit fixture policy, not a production choice of asOf, units or window.
    acquire: async ({ contentHash, snapshot }) => ({
      contentHash, asOf: snapshot.asOf,
      runtimeSnapshotHash: (await createCertifiedForecastIdentity(viewCertifiedSupplySnapshot(snapshot, snapshot.asOf))).snapshotHash,
    }),
    mapping: () => ({ ...bands }),
  };
  publication = await approve(1);
  env = {
    ...bindings, ...harness.env,
    SITE_ENV: "production", FORECAST_RUNTIME_MODE: "enabled",
    FORECAST_DB: harness.database, FORECAST_RATE_LIMITER: { limit: async () => ({ success: true }) },
    DECISION_ANALYTICS_ENABLED: "true", DECISION_ANALYTICS_SCHEMA_VERSION: "3",
    DECISION_ANALYTICS_PRODUCERS: JSON.stringify([producer]),
    DECISION_ANALYTICS_DAILY_WRITE_ATTEMPTS: "20",
    DECISION_ANALYTICS_MAX_MAINTENANCE_AGE_MS: "120000",
    DECISION_ANALYTICS_MAX_OVERDUE_MS: "0", DECISION_ANALYTICS_MAX_BACKLOG_ROWS: "0",
    DECISION_ANALYTICS_MAINTENANCE_ENABLED: "true", DECISION_ANALYTICS_MAINTENANCE_ROWS_PER_TABLE: "100",
    EVENT_RATE_LIMITER: { limit: async () => ({ success: true }) },
  };
  await cleanupDecisionAnalytics(env, clock);
  harness.mockSiteverify({ body: { success: true, action: "decision_episode", hostname: "test.example" } });
});
afterEach(async () => {
  await harness.teardown();
  vi.restoreAllMocks();
});

it("requires installed acquisition/mapping and authentic production trust, not an opaque hash", async () => {
  const limit = vi.fn(async () => ({ success: true }));
  env.FORECAST_RATE_LIMITER = { limit };
  await expect(createProductionDecisionResolver()(request(), env, calculation()))
    .rejects.toMatchObject({ status: 503, message: "analytics_not_ready" });
  await expect(createProductionDecisionResolver({ producer, trust: installation.trust })(request(), env, calculation()))
    .rejects.toMatchObject({ status: 503, message: "analytics_not_ready" });
  expect(limit).not.toHaveBeenCalled();
  await expect(createProductionDecisionResolver({
    ...installation, trust: { ...installation.trust, keyId: "untrusted-key" },
  }, () => clock)(request(), env, calculation()))
    .rejects.toMatchObject({ status: 503, message: "analytics_not_ready" });
});

it("verifies the exact acquisition identity and the mapping bands against authenticated candidate bytes", async () => {
  const mapping = vi.fn(installation.mapping!);
  const resolve = createProductionDecisionResolver({ ...installation, mapping }, () => clock);
  await expect(resolve(request(), env, calculation())).resolves.toEqual({ expiresAt: clock + 60000 });
  expect(mapping).toHaveBeenCalledWith(expect.objectContaining({
    actual: expect.objectContaining({ contentHash: publication.hash, asOf: publication.candidate.certifiedSnapshot!.asOf }),
    signedCandidate: publication.candidate,
  }));
  await expect(resolve(request(), env, {
    ...calculation(), expectedSupply: { ...bands, blue: "two_hundred_plus" },
  })).rejects.toMatchObject({ status: 400, message: "unsupported_expected_supply" });
  await expect(createProductionDecisionResolver({
    ...installation,
    acquire: ({ contentHash, snapshot }) => ({ contentHash, asOf: snapshot.asOf, runtimeSnapshotHash: "0".repeat(64) }),
  }, () => clock)(request(), env, calculation()))
    .rejects.toMatchObject({ status: 503, message: "analytics_not_ready" });
});

it("refreshes through real publication approval without changing static hash config, while retaining admitted parents", async () => {
  const resolver = createProductionDecisionResolver(installation, () => clock);
  const send = (payload: DecisionEnvelope) => handleDecisionEvent(request(payload), env,
    (req, data) => resolver(req, env, data));
  const first: DecisionEnvelope = {
    version: 3, kind: "decision_episode", decisionId: crypto.randomUUID(), eventId: crypto.randomUUID(),
    ordinal: 1, stage: "calculation", data: calculation(), turnstileToken: "first-test-security-token",
  };
  expect(await (await send(first)).json()).toEqual({ ok: true, duplicate: false });
  const next = await approve(2);
  expect((await readActive(harness.database, "production")).candidate_id).toBe(next.candidate.candidateId);
  clock += 60001;
  const second: DecisionEnvelope = { ...first, decisionId: crypto.randomUUID(), eventId: crypto.randomUUID(),
    data: calculation(next.hash), turnstileToken: "next-test-security-token" };
  expect(await (await send(second)).json()).toEqual({ ok: true, duplicate: false });
  expect(await (await send({ ...first, turnstileToken: "retry-fresh-security-token" })).json())
    .toEqual({ ok: true, duplicate: true });
  expect(await (await send({
    version: 3, kind: "decision_episode", decisionId: first.decisionId, eventId: crypto.randomUUID(),
    ordinal: 2, stage: "current_presented", data: {}, turnstileToken: "followup-test-security-token",
  })).json()).toEqual({ ok: true, duplicate: false });
  const stale = await send({ ...first, decisionId: crypto.randomUUID(), eventId: crypto.randomUUID() });
  expect(stale.status).toBe(400);
  expect(await stale.json()).toEqual({ error: "unsupported_publication_content", retryable: false });
  expect(await harness.countRows("decision_analytics_episodes")).toBe(2);
});

it.each(["mapping", "admission"] as const)("rejects a metadata lease expiring during %s without admitting an episode", async (phase) => {
  const resolver = createProductionDecisionResolver({
    ...installation, mapping: () => {
      if (phase === "mapping") clock += 60000;
      return bands;
    },
  }, () => clock);
  const payload: DecisionEnvelope = {
    version: 3, kind: "decision_episode", decisionId: crypto.randomUUID(), eventId: crypto.randomUUID(),
    ordinal: 1, stage: "calculation", data: calculation(), turnstileToken: "expiry-test-security-token",
  };
  const response = await handleDecisionEvent(request(payload), env, async (req, data) => {
    const lease = await resolver(req, env, data);
    if (phase === "admission") clock += 60000;
    return lease;
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "analytics_not_ready", retryable: false });
  expect(await harness.countRows("decision_analytics_episodes")).toBe(0);
  expect(await harness.countRows("decision_analytics_dedupe")).toBe(0);
});
