import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { expect, it } from "vitest";
import {
  ACCESS_AUD,
  ADMIN_EMAIL,
  accessClaims,
  applySql,
  createAccessKeys,
  SCHEMA_LEDGER_SQL,
  seedCalendar,
  seedUsageGuard,
  signAccessToken,
  TEAM_DOMAIN,
} from "../test/fixtures.ts";
import { type AdminEnv, createAdminHandler } from "./worker.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** In-process SQLite with the real migrations and the real fixed SELECT (no network). */
function sqlite() {
  const db = new DatabaseSync(":memory:");
  const session = {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      return {
        bind: (...values: unknown[]) => ({
          run: async () => statement.run(...(values as SQLInputValue[])),
        }),
        all: async () => ({ results: statement.all() }),
        first: async () => statement.get() ?? null,
      };
    },
  };
  return { ...session, withSession: () => session };
}

it("keeps an authenticated full calendar render below the 50 ms CPU budget", async () => {
  const now = Date.parse("2026-10-18T10:00:00.000Z");
  const forecast = sqlite();
  await applySql(forecast, SCHEMA_LEDGER_SQL);
  for (const file of [
    "0030_monitor_streams",
    "0031_calendar_decisions",
    "0032_grant_occurrences",
    "0033_calendar_snapshots",
  ])
    await applySql(forecast, read(`../../forecast-collector/migrations/${file}.sql`));
  await seedCalendar(forecast, now);
  const guard = sqlite();
  await applySql(guard, read("../../usage-guard/schema.sql"));
  await seedUsageGuard(guard, now);
  const keys = await createAccessKeys();
  const token = await signAccessToken(keys.privateKey, accessClaims(now));
  const handler = createAdminHandler({
    now: () => now,
    fetch: async () => Response.json(keys.jwks),
  });
  const limiter = { limit: async () => ({ success: true }) };
  const env = {
    FORECAST_DB: forecast,
    USAGE_GUARD_DB: guard,
    ADMIN_IP_RATE_LIMITER: limiter,
    ADMIN_IDENTITY_RATE_LIMITER: limiter,
    ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    ACCESS_AUD,
    ADMIN_ALLOWED_EMAILS: ADMIN_EMAIL,
  } as unknown as AdminEnv;
  const run = () =>
    handler(
      new Request("https://forecast-admin-staging.nikkecollection.com/?rev=2", {
        headers: { "CF-Connecting-IP": "203.0.113.9", "Cf-Access-Jwt-Assertion": token },
      }),
      env,
    );
  const first = await run();
  expect(first.status).toBe(200);
  expect(await first.text()).toContain("이 링크 이후 갱신됨");
  // Local Node thread CPU regression signal, not a measurement of deployed workerd CPU.
  // Includes signature verification (cached key), the SQL read, rendering and serialization;
  // the in-process SQLite query overstates D1, whose query runs outside the isolate.
  const repetitions = 50;
  const start = process.threadCpuUsage();
  for (let index = 0; index < repetitions; index++) await (await run()).arrayBuffer();
  const used = process.threadCpuUsage(start);
  expect((used.user + used.system) / 1000 / repetitions).toBeLessThan(50);
});

it("declares a staging-only, non-workers.dev deployment with Access-ready placeholders", () => {
  const config = read("../wrangler.toml");
  expect(config).toMatch(/^workers_dev = false$/m);
  expect(config).toMatch(/^preview_urls = false$/m);
  expect(config).toContain('pattern = "forecast-admin-staging.nikkecollection.com"');
  expect(config).toContain("custom_domain = true");
  // Staging forecast DB only; never the production forecast database.
  expect(config).toContain("49b5dc06-37ae-4245-896c-daea98562ed8");
  expect(config).not.toContain("2d58bcc0-a7b5-43f3-8f42-34e1bf1ff853");
  expect(config).toContain('binding = "USAGE_GUARD_DB"');
  expect(config).toContain('name = "ADMIN_IP_RATE_LIMITER"');
  expect(config).toContain('name = "ADMIN_IDENTITY_RATE_LIMITER"');
  expect(config).toMatch(/^ADMIN_ALLOWED_EMAILS = "unset"$/m);
  expect(config).not.toMatch(/@(?!example\.)[a-z0-9-]+\.[a-z]/i);
});
