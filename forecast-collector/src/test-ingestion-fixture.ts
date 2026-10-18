import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, vi } from "vitest";
import { parseNoticeDetail } from "./notice";
import { runRuntimeCandidate, runRuntimeIngestion } from "./runtime-ingestion";
import { runtimeTestDb } from "./test-runtime-db";
import { seedNormalUsageGuard } from "./test-usage-guard";
import type { CollectorEnv } from "./types";

export const root = new URL("../", import.meta.url);
export const fixture = JSON.parse(
  readFileSync(new URL("fixtures/official-solo-history/8060044.json", root), "utf8"),
);
export const now = Date.parse("2026-08-20T12:00:00Z");
export let sqlite: DatabaseSync;
export let env: CollectorEnv;

export async function initializeDatabase() {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("fixtures/schema-v27-test.sql", root), "utf8"));
  const db = runtimeTestDb(sqlite);
  env = {
    FORECAST_DB: db,
    USAGE_GUARD_DB: db,
    ADMIN_TOKEN: "fixture",
    ENVIRONMENT: "staging",
    DEPLOY_SHA: "fixture",
    POLL_MODE: "both",
    RUNTIME_INGESTION_ENABLED: "true",
  };
  await seedNormalUsageGuard(db);
}

beforeEach(initializeDatabase);
afterEach(() => {
  vi.useRealTimers();
  sqlite.close();
});

export async function enqueue(payload = fixture) {
  const board = payload.content.board.boardId as 48 | 56;
  const id = String(payload.content.feed.feedId);
  const item = await parseNoticeDetail(payload, board, id);
  if (!item) throw new Error("fixture_missing_item");
  sqlite
    .prepare(`INSERT OR IGNORE INTO source_queue
    (source,item_id,url,title,published_at,official,status,attempts,first_seen_at,updated_at)
    VALUES(?,?,?,?,?,1,'pending',0,?,?)`)
    .run(
      item.source,
      id,
      item.url,
      item.title,
      item.publishedAt,
      new Date().toISOString(),
      new Date().toISOString(),
    );
  return item;
}

export function rows(sql: string) {
  return sqlite.prepare(sql).all();
}
export function allowRecheck() {
  sqlite.exec("UPDATE runtime_ingestion_items SET next_check_at='2000-01-01T00:00:00.000Z'");
}
export function runNoticeIngestion(fetcher: typeof fetch = async () => Response.json(fixture)) {
  return runRuntimeIngestion(env, { fetcher, candidateNowMs: now });
}
export function runCandidateInvocation(at = now) {
  return runRuntimeCandidate(env, at);
}
export async function runIngestionThenCandidate(
  fetcher: typeof fetch = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => Response.json(fixture)),
) {
  const ingestion = await runNoticeIngestion(fetcher);
  if (ingestion.outcome !== "completed") return ingestion;
  const candidate = await runCandidateInvocation();
  return { ...ingestion, candidateCreated: candidate.candidateCreated };
}
