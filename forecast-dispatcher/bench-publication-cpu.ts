import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runtimeTestDb } from "../forecast-collector/src/test-runtime-db.ts";
import type { InteractionRouterEnv } from "../forecast-interactions/src/types.ts";
import router from "../forecast-interactions/src/worker.ts";
import {
  applyPublicationCommand,
  createReview,
  initializePublication,
  sealCandidate,
} from "../shared/forecast-publication/store.ts";
import {
  approvalReview,
  migratePublicationDb,
  seedCandidate,
  TEST_NOW,
} from "../shared/forecast-publication/test-fixtures.ts";
import { canonicalPublicationJson, encodeBase64 } from "../shared/forecastPublication.ts";
import usageSchema from "../usage-guard/schema.sql?raw";
import { raiseOpsAlert } from "./src/db.ts";
import { runDispatcher } from "./src/dispatcher.ts";
import type { DispatcherEnv } from "./src/types.ts";

// Bundle locally with esbuild's ?raw SQL loader, then execute with Node.
// Actual Router/dispatcher code and SQL; SQLite is synchronous, Discord is stubbed.
// Setup, candidate construction, signing the incoming request, and reporting are NOT timed.
const iterations = 20;
const originalNow = Date.now;
const originalFetch = globalThis.fetch;
Date.now = () => TEST_NOW;
globalThis.fetch = async (input) => {
  assert(String(input).startsWith("https://discord.com/api/v10/"), "unexpected outbound request");
  return Response.json({ id: "777777777" });
};
const signingKey = (await crypto.subtle.generateKey("Ed25519", true, [
  "sign",
  "verify",
])) as CryptoKeyPair;
const discordKey = (await crypto.subtle.generateKey("Ed25519", true, [
  "sign",
  "verify",
])) as CryptoKeyPair;
const privateKey = encodeBase64(
  new Uint8Array(await crypto.subtle.exportKey("pkcs8", signingKey.privateKey)),
);
const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", discordKey.publicKey)).toString(
  "hex",
);
const modes = [
  "router-approve",
  "dispatcher-seal",
  "dispatcher-deliver-five",
  "dispatcher-busy-defers-sealing",
  "dispatcher-seal-plus-five-ops",
] as const;

async function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  const db = runtimeTestDb(sqlite);
  const prepare = db.prepare;
  const totalChanges = () => Number(sqlite.prepare("SELECT total_changes() n").get()?.["n"]);
  // The collector adapter omits changes on RETURNING. Account for real SQLite changes
  // (including triggers) rather than substituting expected/returned row counts.
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const execute = async <T>(mode: "all" | "run") => {
      const before = totalChanges();
      const result = await statement[mode]<T>();
      return { ...result, meta: { ...result.meta, changes: totalChanges() - before } };
    };
    return {
      ...statement,
      bind: (...values) => wrap(statement.bind(...values)),
      all: <T>() => execute<T>("all"),
      run: <T>() => execute<T>("run"),
    };
  };
  db.prepare = (sql) => wrap(prepare(sql));
  await migratePublicationDb(db, async (_db, migrations) => {
    for (const migration of migrations) sqlite.exec(migration.queries.join("\n"));
    sqlite.exec("CREATE TABLE __test_sql_migrations(name TEXT)");
  });
  sqlite.exec(usageSchema);
  sqlite
    .prepare(`INSERT INTO usage_guard_state
    (singleton_id,action,observed_at,period_start,period_end,evidence_json,evidence_hash,
    current_percent,projected_percent,governing_metric,normal_streak,release_pending,updated_at)
    VALUES(1,'normal',?,'2026-10-01T00:00:00.000Z','2026-11-01T00:00:00.000Z','{}',?,0,0,'workerRequests',2,0,?)`)
    .run(new Date(TEST_NOW).toISOString(), "0".repeat(64), new Date(TEST_NOW).toISOString());
  return { sqlite, db };
}

try {
  for (const mode of modes) {
    const cpuMs: number[] = [];
    const wallMs: number[] = [];
    let payloadBytes = 0;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const { sqlite, db } = await fixture();
      try {
        let run: () => Promise<unknown>;
        let verify: () => void;
        if (mode === "router-approve") {
          const first = await approvalReview(db);
          await applyPublicationCommand(
            db,
            {
              reviewId: first.reviewId,
              interactionId: "9001",
              environment: "staging",
              actorId: "987654321",
              messageId: "666666666",
              channelId: "333333333",
            },
            { privateKey, keyId: "test-key" },
            TEST_NOW,
          );
          const second = await approvalReview(db, 2);
          payloadBytes = Buffer.byteLength(canonicalPublicationJson(second.candidate));
          const env: InteractionRouterEnv = {
            STAGING_FORECAST_DB: db,
            PRODUCTION_FORECAST_DB: db,
            USAGE_GUARD_DB: db,
            DISCORD_PUBLIC_KEY: publicKey,
            DISCORD_APPLICATION_ID: "123456789",
            DISCORD_GUILD_ID: "222222222",
            DISCORD_FORECAST_APPROVER_USER_ID: "987654321",
            DISCORD_APPROVAL_CHANNEL_ID: "333333333",
            DISCORD_ALERT_CHANNEL_ID: "444444444",
            DISCORD_ACTIVITY_CHANNEL_ID: "555555555",
            STAGING_PUBLICATION_MODE: "enabled",
            PRODUCTION_PUBLICATION_MODE: "off",
            PRODUCTION_MUTATIONS_ENABLED: "false",
            FORECAST_PUBLICATION_SIGNING_KEY: privateKey,
            FORECAST_PUBLICATION_KEY_ID: "test-key",
            DEPLOY_SHA: "local-benchmark",
          };
          const body = JSON.stringify({
            id: "9002",
            application_id: env.DISCORD_APPLICATION_ID,
            token: "local-test-token",
            type: 3,
            guild_id: env.DISCORD_GUILD_ID,
            channel_id: env.DISCORD_APPROVAL_CHANNEL_ID,
            member: { user: { id: env.DISCORD_FORECAST_APPROVER_USER_ID } },
            message: { id: "666666666" },
            data: { component_type: 2, custom_id: `forecast_publish:staging:${second.reviewId}` },
          });
          const timestamp = String(Math.floor(TEST_NOW / 1000));
          const signature = Buffer.from(
            await crypto.subtle.sign(
              "Ed25519",
              discordKey.privateKey,
              new TextEncoder().encode(timestamp + body),
            ),
          ).toString("hex");
          const request = new Request("https://router.test/discord/interactions", {
            method: "POST",
            body,
            headers: { "x-signature-ed25519": signature, "x-signature-timestamp": timestamp },
          });
          const pending: Promise<unknown>[] = [];
          const context = {
            waitUntil: (promise: Promise<unknown>) => pending.push(promise),
          } as unknown as ExecutionContext;
          run = async () => {
            const response = await router.fetch(request, env, context);
            assert.equal(response.status, 200);
            await Promise.all(pending);
          };
          verify = () =>
            assert.equal(
              sqlite.prepare("SELECT sequence FROM forecast_runtime_active").get()?.["sequence"],
              2,
            );
        } else {
          const active = await initializePublication(db, "staging");
          const deliverFive =
            mode === "dispatcher-deliver-five" || mode === "dispatcher-busy-defers-sealing";
          for (let revision = 1; revision <= (deliverFive ? 5 : 0); revision += 1) {
            const { candidate, hash } = await seedCandidate(db, revision);
            payloadBytes = Buffer.byteLength(canonicalPublicationJson(candidate));
            await sealCandidate(db, candidate.candidateId, TEST_NOW);
            await createReview(db, active, "approve", candidate.candidateId, hash, TEST_NOW);
          }
          if (mode !== "dispatcher-deliver-five") {
            const { candidate } = await seedCandidate(db, 6);
            payloadBytes = Buffer.byteLength(canonicalPublicationJson(candidate));
          }
          if (mode === "dispatcher-busy-defers-sealing" || mode === "dispatcher-seal-plus-five-ops")
            for (let index = 0; index < 5; index += 1)
              await raiseOpsAlert(db, {
                alertKey: `local:${index}`,
                environment: "staging",
                severity: "critical",
                component: "collector",
                errorCode: "fixture_error",
                nowMs: TEST_NOW,
              });
          const env = {
            FORECAST_DB: db,
            USAGE_GUARD_DB: db,
            ENVIRONMENT: "staging",
            DEPLOY_SHA: "local-benchmark",
            DISPATCH_ENABLED: "true",
            PUBLICATION_MODE: "enabled",
            DISCORD_BOT_TOKEN: "local-test-token",
            DISCORD_APPROVAL_CHANNEL_ID: "333333333",
            DISCORD_ALERT_CHANNEL_ID: "444444444",
            DISCORD_CHANNEL_ID: "444444444",
          } as DispatcherEnv;
          run = () => runDispatcher(env);
          verify = () => {
            assert.equal(
              sqlite.prepare("SELECT COUNT(*) n FROM forecast_runtime_versions").get()?.["n"],
              deliverFive ? 5 : 1,
            );
            assert.equal(
              sqlite
                .prepare("SELECT COUNT(*) n FROM forecast_runtime_outbox WHERE state='sent'")
                .get()?.["n"],
              deliverFive ? 5 : 1,
            );
          };
        }
        const cpu = process.cpuUsage();
        const start = performance.now();
        await run();
        wallMs.push(performance.now() - start);
        const used = process.cpuUsage(cpu);
        cpuMs.push((used.user + used.system) / 1000);
        verify();
      } finally {
        sqlite.close();
      }
    }
    const sorted = [...wallMs].sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        mode,
        node: process.version,
        platform: process.platform,
        iterations,
        payloadBytes,
        processCpuMsPerRun: cpuMs.reduce((sum, value) => sum + value, 0) / iterations,
        processCpuSamplesMs: cpuMs,
        wallMs: {
          median: sorted[Math.floor(iterations / 2)],
          p95: sorted[Math.ceil(iterations * 0.95) - 1],
          max: sorted.at(-1),
        },
        scope:
          "Node process CPU, including local SQLite and stub Discord; not workerd CPU or a deployed limit proof",
      }),
    );
  }
} finally {
  Date.now = originalNow;
  globalThis.fetch = originalFetch;
}
