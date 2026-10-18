import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { runRuntimeCandidate } from "./runtime-ingestion";
import { runtimeTestDb } from "./test-runtime-db";
import type { CollectorEnv } from "./types";

export type ColdCandidateData = {
  database: string;
  now: number;
  deploySha: string;
  instrumented: boolean;
};
const data = workerData as ColdCandidateData;
const sqlite = new DatabaseSync(":memory:");
// Restore the prepared fixture before timing. Candidate I/O stays local,
// synchronous in-memory SQLite rather than measuring filesystem fsync latency.
sqlite.exec("PRAGMA foreign_keys=OFF");
sqlite.prepare("ATTACH DATABASE ? AS fixture").run(data.database);
const schema = sqlite
  .prepare(`SELECT type,name,sql FROM fixture.sqlite_schema
  WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid`)
  .all();
for (const row of schema.filter((entry) => entry["type"] === "table"))
  sqlite.exec(String(row["sql"]));
for (const row of schema.filter((entry) => entry["type"] === "table")) {
  const name = `"${String(row["name"]).replaceAll('"', '""')}"`;
  sqlite.exec(`INSERT INTO main.${name} SELECT * FROM fixture.${name}`);
}
for (const row of schema.filter((entry) => entry["type"] !== "table"))
  sqlite.exec(String(row["sql"]));
sqlite.exec("DETACH DATABASE fixture; PRAGMA foreign_keys=ON");
const db = runtimeTestDb(sqlite);
const env: CollectorEnv = {
  FORECAST_DB: db,
  USAGE_GUARD_DB: db,
  ENVIRONMENT: "staging",
  ADMIN_TOKEN: "local",
  DEPLOY_SHA: data.deploySha,
  POLL_MODE: "both",
  RUNTIME_INGESTION_ENABLED: "true",
};
if (data.instrumented) {
  const parse = JSON.parse;
  JSON.parse = (...args: Parameters<typeof JSON.parse>) => {
    const start = performance.now();
    try {
      return parse(...args);
    } finally {
      const global = globalThis as typeof globalThis & {
        __candidateStages?: Record<string, number>;
      };
      global.__candidateStages ??= {};
      const stages = global.__candidateStages;
      stages["JSON.parse"] = (stages["JSON.parse"] ?? 0) + performance.now() - start;
    }
  };
}
const start = process.threadCpuUsage();
const wall = performance.now();
try {
  const result = await runRuntimeCandidate(env, data.now);
  const used = process.threadCpuUsage(start);
  parentPort?.postMessage({
    cpuMs: (used.user + used.system) / 1000,
    wallMs: performance.now() - wall,
    result,
    stages:
      (globalThis as typeof globalThis & { __candidateStages?: unknown }).__candidateStages ?? {},
  });
} finally {
  sqlite.close();
}
