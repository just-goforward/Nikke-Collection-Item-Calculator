import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { executeTestSql } from "../../../../shared/testD1Sql";
import collaborations from "../../../fixtures/forecast-v2/expected/collaborations.json";
import grants from "../../../fixtures/forecast-v2/expected/grants.json";
import solo from "../../../fixtures/forecast-v2/expected/solo.json";
import * as admission from "../../candidate-persistence";
import schema from "../../test-schema";
import { collectorTestEnv } from "../ingest/test-support/env";
import { now } from "./fixture";
import { runV2CandidateUnit } from "./index";

const db = env.FORECAST_DB;
afterEach(() => vi.restoreAllMocks());
const iso = (value: string) => new Date(value).toISOString();
beforeEach(async () => {
  await reset();
  await executeTestSql(db, schema, applyD1Migrations);
});

async function event(
  id: string,
  kind: string,
  start: string,
  end: string,
  feed: number,
  provenance = {},
) {
  await db
    .prepare("INSERT OR IGNORE INTO forecast_v2_post_versions VALUES(?,?,?,?,48,?,?,?)")
    .bind(String(feed), String(feed), start, "a".repeat(64), start, start, `Fixture ${feed}`)
    .run();
  await db
    .prepare(`INSERT INTO forecast_v2_calendar_revisions
    (event_id,revision,kind,status,starts_at,ends_at,prediction_provenance_json,source_feed_ids_json,created_at)
    VALUES(?,1,?,'confirmed',?,?,?,?,?)`)
    .bind(
      id,
      kind,
      iso(start),
      iso(end),
      JSON.stringify(provenance),
      JSON.stringify([feed]),
      iso(start),
    )
    .run();
  await db.prepare("INSERT INTO forecast_v2_calendar_heads VALUES(?,1)").bind(id).run();
}

it("projects the T09-sized confirmed calendar (24 seasons, six collaborations, eleven grants)", async () => {
  for (const season of solo.seasons) {
    for (const [index, segment] of season.segments.entries()) {
      await event(
        `solo_${season.season}_${index + 1}`,
        "solo",
        segment[0]!,
        segment[1]!,
        season.sources[0]!,
        { round: season.season, segment: index + 1 },
      );
    }
  }
  for (const entry of collaborations.collaborations)
    await event(entry.key, "collaboration", entry.startAt, entry.endAt, entry.maintenance);
  for (const [index, grant] of grants.occurrences.entries()) {
    await db
      .prepare("INSERT INTO forecast_v2_grant_revisions VALUES(?,1,?,?,?,NULL,?)")
      .bind(`grant${index}`, grant.gameDay, grant.ii, grant.box, new Date(now).toISOString())
      .run();
    await db
      .prepare("INSERT INTO forecast_v2_grant_heads VALUES(?,1,?,?,?)")
      .bind(`grant${index}`, grant.gameDay, grant.ii, grant.box)
      .run();
  }
  expect(solo.seasons).toHaveLength(24);
  expect(collaborations.collaborations).toHaveLength(6);
  expect(grants.occurrences).toHaveLength(11);
  const configuration = { ...collectorTestEnv, FORECAST_V2_MODE: "on" as const };
  const admitted = vi.spyOn(admission, "processSourceQueue");
  expect(await runV2CandidateUnit(configuration, now)).toEqual({ outcome: "built" });
  expect(admitted).toHaveBeenCalledOnce();
  // Only S42 has window payloads; S41 remains a compact cadence dependency.
  expect(await admitted.mock.results[0]!.value).toEqual({
    processed: 1,
    candidateCreated: true,
  });
  const json = await db
    .prepare("SELECT payload_json FROM forecast_candidates")
    .first<string>("payload_json");
  const candidate = JSON.parse(json!);
  // Historical S1–S40 are already in the certified baseline; publication covers
  // the current window plus later confirmed cadence anchors, not a 2-year ledger.
  for (const season of solo.seasons.filter((entry) => entry.season >= 42))
    for (const [index, period] of season.segments.entries())
      expect(candidate.schedule.soloPeriods).toContainEqual({
        round: season.season,
        segment: index + 1,
        scheduleStatus: "confirmed",
        effectiveFrom: iso(period[0]!),
        effectiveUntil: iso(period[1]!),
      });
  const first = Date.parse(solo.seasons.find((entry) => entry.season === 41)!.segments[0]![0]!);
  const last = Date.parse(solo.seasons.find((entry) => entry.season === 42)!.segments[0]![1]!);
  expect(candidate.schedule.collaborationPeriods).toEqual(
    collaborations.collaborations
      .filter((entry) => Date.parse(entry.endAt) >= first && Date.parse(entry.startAt) <= last)
      .map((entry) => ({
        effectiveFrom: iso(entry.startAt),
        effectiveUntil: iso(entry.endAt),
      })),
  );
  // All eleven fixture grants precede the seven-day publication history window.
  expect(candidate.grants).toEqual([]);
  expect(candidate.schedule.soloPeriods).toContainEqual({
    round: 43,
    segment: 1,
    scheduleStatus: "estimated",
    effectiveFrom: "2026-11-12T03:00:00.000Z",
    effectiveUntil: "2026-11-18T19:59:59.000Z",
  });
  expect(await runV2CandidateUnit(configuration, now)).toEqual({ outcome: "unchanged" });
});
