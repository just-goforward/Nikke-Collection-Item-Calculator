import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildForecastCandidate, resolveSoloSchedule } from "./src/candidate";
import { parseScheduleEvents } from "./src/naver";
import { parseNoticeDetail } from "./src/notice";
import { runRuntimeIngestion } from "./src/runtime-ingestion";
import { runtimeTestDb } from "./src/test-runtime-db";
import { seedNormalUsageGuard } from "./src/test-usage-guard";
import type { CollectorEnv } from "./src/types";

// Bundle with the installed esbuild (platform=node, format=esm), then run that
// bundle with node --cpu-prof. Schema/fixture setup is outside each timed run.
const root = resolve(process.argv[2] ?? ".");
const schema = readFileSync(resolve(root, "forecast-collector/schema.sql"), "utf8");
const migration = readFileSync(
  resolve(root, "forecast-collector/migrations/0024_runtime_ingestion.sql"),
  "utf8",
);
const body = readFileSync(
  resolve(root, "forecast-collector/fixtures/official-solo-history/8060044.json"),
  "utf8",
);
const item = await parseNoticeDetail(JSON.parse(body), 56, "8060044");
assert(item);
if (process.argv[3] === "candidate") {
  const events = await parseScheduleEvents([item]);
  const nowMs = Date.parse("2026-08-20T12:00:00Z");
  const resolved = resolveSoloSchedule(events, nowMs);
  assert(resolved);
  for (let iteration = 0; iteration < 3; iteration++) {
    const cpu = process.cpuUsage();
    const startUs = Number(process.hrtime.bigint() / 1000n);
    const result = await buildForecastCandidate(
      resolved,
      events,
      { status: "x_unavailable", sourceItem: null, reason: "runtime_advisory_pending" },
      nowMs,
      1,
    );
    const endUs = Number(process.hrtime.bigint() / 1000n);
    const used = process.cpuUsage(cpu);
    console.log(
      JSON.stringify({
        phase: "candidate-constructor-only",
        iteration,
        startUs,
        endUs,
        cpuMs: (used.user + used.system) / 1000,
        wallMs: (endUs - startUs) / 1000,
        payloadHash: result.payloadHash,
      }),
    );
  }
  process.exit(0);
}
for (let iteration = 0; iteration < 3; iteration++) {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(schema);
    sqlite.exec(migration);
    const db = runtimeTestDb(sqlite);
    const env: CollectorEnv = {
      FORECAST_DB: db,
      USAGE_GUARD_DB: db,
      ENVIRONMENT: "staging",
      ADMIN_TOKEN: "local-fixture",
      DEPLOY_SHA: "local-fixture",
      POLL_MODE: "both",
      RUNTIME_INGESTION_ENABLED: "true",
    };
    await seedNormalUsageGuard(db);
    sqlite
      .prepare(`INSERT INTO source_queue
      (source,item_id,url,title,published_at,official,status,attempts,first_seen_at,updated_at)
      VALUES(?,?,?,?,?,1,'pending',0,?,?)`)
      .run(
        item.source,
        item.itemId,
        item.url,
        item.title,
        item.publishedAt,
        item.publishedAt,
        item.publishedAt,
      );
    const cpu = process.cpuUsage();
    const startUs = Number(process.hrtime.bigint() / 1000n);
    const result = await runRuntimeIngestion(env, {
      candidateNowMs: Date.parse("2026-08-20T12:00:00Z"),
      fetcher: async () => new Response(body, { headers: { "content-type": "application/json" } }),
    });
    const endUs = Number(process.hrtime.bigint() / 1000n);
    const used = process.cpuUsage(cpu);
    assert.equal(result.candidateCreated, true);
    console.log(
      JSON.stringify({
        iteration,
        node: process.version,
        startUs,
        endUs,
        cpuMs: (used.user + used.system) / 1000,
        wallMs: (endUs - startUs) / 1000,
        payloadHash: sqlite.prepare("SELECT payload_hash FROM forecast_candidates").get()?.[
          "payload_hash"
        ],
      }),
    );
  } finally {
    sqlite.close();
  }
}
