import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { executeTestSql } from "../../../../shared/testD1Sql";
import schema from "../../test-schema";
import { collectorTestEnv } from "../ingest/test-support/env";
import { now, seed } from "./fixture";
import { runV2CandidateUnit } from "./index";

const db = env.FORECAST_DB;
const configuration = { ...collectorTestEnv, FORECAST_V2_MODE: "on" as const };
beforeEach(async () => {
  await reset();
  await executeTestSql(db, schema, applyD1Migrations);
  await seed(db);
});

async function collaborations(prefix: string, count: number, start: string, end: string) {
  for (let index = 0; index < count; index += 1) {
    const id = `${prefix}-${index}`;
    await db
      .prepare(`INSERT INTO forecast_v2_calendar_revisions
      (event_id,revision,kind,status,starts_at,ends_at,source_feed_ids_json,created_at)
      VALUES(?,1,'collaboration','confirmed',?,?,'[41]',?)`)
      .bind(id, start, end, start)
      .run();
    await db.prepare("INSERT INTO forecast_v2_calendar_heads VALUES(?,1)").bind(id).run();
  }
}

it("ignores more than forty expired and far-future collaborations before the sentinel", async () => {
  await collaborations("expired", 41, "2024-01-01T00:00:00Z", "2024-01-28T00:00:00Z");
  await collaborations("future", 41, "2030-01-01T00:00:00Z", "2030-01-28T00:00:00Z");
  await collaborations("current", 1, "2026-10-15T03:00:00Z", "2026-10-22T19:59:59Z");
  expect(await runV2CandidateUnit(configuration, now)).toEqual({ outcome: "built" });
  const payload = await db
    .prepare("SELECT payload_json FROM forecast_candidates")
    .first<string>("payload_json");
  expect(JSON.parse(payload!).schedule.collaborationPeriods).toEqual([
    {
      effectiveFrom: "2026-10-15T03:00:00Z",
      effectiveUntil: "2026-10-22T19:59:59Z",
    },
  ]);
  expect(await runV2CandidateUnit(configuration, now)).toEqual({ outcome: "unchanged" });
  // Seeds and builds two full candidates; exceeds the 5 s default under suite load.
}, 30_000);

it("holds without creating a candidate when more than forty relevant events remain", async () => {
  await collaborations("current", 41, "2026-10-15T03:00:00Z", "2026-10-22T19:59:59Z");
  expect(await runV2CandidateUnit(configuration, now)).toEqual({
    outcome: "held",
    reason: "candidate_admission_capacity",
  });
  expect(await db.prepare("SELECT COUNT(*) AS n FROM forecast_candidates").first("n")).toBe(0);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM runtime_candidate_cache").first("n")).toBe(0);
  expect(await runV2CandidateUnit(configuration, now + 60000)).toEqual({
    outcome: "held",
    reason: "candidate_admission_capacity",
  });
  expect(await db.prepare("SELECT COUNT(*) AS n FROM forecast_ops_alerts").first("n")).toBe(1);
  expect(
    await db.prepare("SELECT occurrence_count FROM forecast_ops_alerts").first("occurrence_count"),
  ).toBe(1);
});

it("builds after years of post-bundle solo history and expired collaborations/grants", async () => {
  const base = Date.parse("2026-10-15T12:00:00+09:00");
  const day = 86400000;
  for (let round = 43; round <= 100; round += 1) {
    const start = new Date(base + (round - 42) * 28 * day).toISOString();
    const end = new Date(Date.parse(start) + 6 * day + 17 * 3600000 - 1000).toISOString();
    await db
      .prepare(`INSERT INTO forecast_v2_calendar_revisions
      (event_id,revision,kind,status,starts_at,ends_at,prediction_provenance_json,source_feed_ids_json,created_at)
      VALUES(?,1,'solo','confirmed',?,?,?,'[41]',?)`)
      .bind(`growth${round}`, start, end, JSON.stringify({ round }), start)
      .run();
    await db
      .prepare("INSERT INTO forecast_v2_calendar_heads VALUES(?,1)")
      .bind(`growth${round}`)
      .run();
    await db
      .prepare("INSERT INTO forecast_v2_grant_revisions VALUES(?,1,?,1,0,NULL,?)")
      .bind(`growth${round}`, start.slice(0, 10), start)
      .run();
    await db
      .prepare("INSERT INTO forecast_v2_grant_heads VALUES(?,1,?,1,0)")
      .bind(`growth${round}`, start.slice(0, 10))
      .run();
  }
  await collaborations("old-growth", 60, "2026-01-01T00:00:00Z", "2026-01-28T00:00:00Z");
  const at = base + 58 * 28 * day + 2 * day;
  expect(await runV2CandidateUnit(configuration, at)).toEqual({ outcome: "built" });
  const json = await db
    .prepare("SELECT payload_json FROM forecast_candidates")
    .first<string>("payload_json");
  const candidate = JSON.parse(json!);
  expect(candidate.grants).toHaveLength(1);
  expect(candidate.grants[0].id).toContain("growth100");
  expect(
    candidate.schedule.soloPeriods.find((period: { round: number }) => period.round === 101),
  ).toMatchObject({ effectiveFrom: new Date(base + 59 * 28 * day).toISOString() });
  expect(await runV2CandidateUnit(configuration, at)).toEqual({ outcome: "unchanged" });
  // Seeds ~60 seasons of history plus 60 collaborations; exceeds the 5 s default under suite load.
}, 30_000);
