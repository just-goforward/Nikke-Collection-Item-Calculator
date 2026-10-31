import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { runtimeTestDb } from "../../forecast-collector/src/test-runtime-db.ts";
import { seedNormalUsageGuard } from "../../forecast-collector/src/test-usage-guard.ts";
import type { InteractionRouterEnv } from "../src/types.ts";
import { handleV2Interaction } from "../src/v2-interactions.ts";
import worker from "../src/worker.ts";
import { seedV2Decision, v2Baseline, v2Migrations } from "./v2-test-fixture.ts";

it.each([
  `forecast_publish:production:${"a".repeat(32)}`,
  "fv2:p:opt:d:0:a",
  "fv2:p:bok:d:0",
  "fv2:p:bedit:d:0",
  "fv2:p:bno:d:0",
  "fv2m:p:d:0",
])("keeps signed staging rejection of %s below the 10ms CPU budget", async (customId) => {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const hex = (buffer: ArrayBuffer) => Buffer.from(buffer).toString("hex");
  const env: InteractionRouterEnv = {
    FORECAST_ENVIRONMENT: "staging",
    get STAGING_FORECAST_DB(): D1Database {
      throw new Error("unexpected staging DB access");
    },
    get PRODUCTION_FORECAST_DB(): D1Database {
      throw new Error("unexpected production binding lookup");
    },
    get USAGE_GUARD_DB(): D1Database {
      throw new Error("unexpected usage DB access");
    },
    DISCORD_PUBLIC_KEY: hex(await crypto.subtle.exportKey("raw", keys.publicKey)),
    DISCORD_APPLICATION_ID: "123456789",
    DISCORD_GUILD_ID: "222222222",
    DISCORD_FORECAST_APPROVER_USER_ID: "987654321",
    DISCORD_APPROVAL_CHANNEL_ID: "333333333",
    DISCORD_ALERT_CHANNEL_ID: "444444444",
    DISCORD_ACTIVITY_CHANNEL_ID: "555555555",
    DEPLOY_SHA: "cpu-test",
    STAGING_PUBLICATION_MODE: "off",
    PRODUCTION_PUBLICATION_MODE: "enabled",
    PRODUCTION_MUTATIONS_ENABLED: "true",
    FORECAST_PUBLICATION_KEY_ID: "unset",
  };
  const body = JSON.stringify({
    id: "1001",
    application_id: env.DISCORD_APPLICATION_ID,
    type: customId.startsWith("fv2m:") ? 5 : 3,
    data: { custom_id: customId, component_type: 2 },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = hex(
    await crypto.subtle.sign(
      "Ed25519",
      keys.privateKey,
      new TextEncoder().encode(timestamp + body),
    ),
  );
  const context = {
    get exports(): Cloudflare.Exports {
      throw new Error("unused");
    },
    get tracing(): Tracing {
      throw new Error("unused");
    },
    props: {},
    abort() {
      throw new Error("unused");
    },
    passThroughOnException() {
      throw new Error("unused");
    },
    waitUntil() {
      throw new Error("unexpected deferred work");
    },
  } satisfies ExecutionContext;
  const run = () =>
    worker.fetch(
      new Request("https://router.test/discord/interactions", {
        method: "POST",
        body,
        headers: { "x-signature-ed25519": signature, "x-signature-timestamp": timestamp },
      }),
      env,
      context,
    );
  expect(await (await run()).json()).toMatchObject({
    type: 4,
    data: { flags: 64 },
  });
  // Local Node thread CPU regression signal, not a measurement of deployed workerd CPU.
  // Include request construction, signature verification and response serialization;
  // exclude signing and setup. No network or database work is permitted.
  const repetitions = 100;
  const start = process.threadCpuUsage();
  for (let index = 0; index < repetitions; index++) await (await run()).arrayBuffer();
  const used = process.threadCpuUsage(start);
  expect((used.user + used.system) / 1000 / repetitions).toBeLessThan(10);
});

it.each(["opt", "bok", "bno", "bedit", "edit", "collaboration", "maintenance"])(
  "successful %s handler stays below 10ms local thread CPU",
  async (scenario) => {
    const action = ["collaboration", "maintenance"].includes(scenario) ? "edit" : scenario;
    const sqlite = new DatabaseSync(":memory:");
    try {
      for (const sql of [v2Baseline, ...v2Migrations]) sqlite.exec(sql);
      const db = runtimeTestDb(sqlite);
      await seedNormalUsageGuard(db);
      const environment = {
        FORECAST_ENVIRONMENT: "staging",
        STAGING_FORECAST_DB: db,
        USAGE_GUARD_DB: db,
        DISCORD_APPLICATION_ID: "123456789",
        DISCORD_GUILD_ID: "222222222",
        DISCORD_APPROVAL_CHANNEL_ID: "333333333",
        DISCORD_FORECAST_APPROVER_USER_ID: "987654321",
      } as InteractionRouterEnv;
      const repetitions = 30;
      let total = 0;
      const oldFetch = globalThis.fetch;
      globalThis.fetch = async () => Response.json({});
      try {
        for (let index = 0; index <= repetitions; index++) {
          const decision = `cpu-${index}`;
          await seedV2Decision(
            db,
            environment.DISCORD_APPROVAL_CHANNEL_ID,
            action === "opt" ? "grant_date" : action !== scenario ? scenario : "solo_review",
            decision,
          );
          const tasks: Promise<unknown>[] = [];
          const interaction = {
            id: String(index + 1000),
            token: "cpu-token",
            application_id: environment.DISCORD_APPLICATION_ID,
            guild_id: environment.DISCORD_GUILD_ID,
            channel_id: environment.DISCORD_APPROVAL_CHANNEL_ID,
            member: { user: { id: environment.DISCORD_FORECAST_APPROVER_USER_ID } },
            message: { id: "666666666" },
            type: action === "edit" ? 5 : 3,
            data: {
              custom_id:
                action === "edit"
                  ? `fv2m:s:${decision}:0`
                  : `fv2:s:${action}:${decision}:0${action === "opt" ? ":a" : ""}`,
              component_type: 2,
              components: [
                { component: { custom_id: "start", value: "2026-11-01 12:00" } },
                { component: { custom_id: "end", value: "2026-11-02 05:00" } },
              ],
            },
          };
          const start = process.threadCpuUsage();
          const response = await handleV2Interaction(interaction, environment, {
            waitUntil(task: Promise<unknown>) {
              tasks.push(task);
            },
          });
          await Promise.all(tasks);
          const body = await response.json();
          const used = process.threadCpuUsage(start);
          if (index > 0) total += (used.user + used.system) / 1000;
          expect(body).toMatchObject({ type: action === "edit" ? 6 : action === "bedit" ? 9 : 7 });
        }
      } finally {
        globalThis.fetch = oldFetch;
      }
      // Isolated Node thread CPU proxy: includes actual transactional SQLite,
      // Usage Guard, hashing and rendering; excludes setup, signing and network latency.
      expect(total / repetitions).toBeLessThanOrEqual(10);
    } finally {
      sqlite.close();
    }
  },
);
