import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { executeTestSql } from "../../../../shared/testD1Sql";
import { buildForecastCandidate, resolveSoloSchedule } from "../../candidate";
import { sha256Hex } from "../../crypto";
import { processSourceQueue } from "../../source-queue";
import schema from "../../test-schema";
import type { ScheduleEvent } from "../../types";
import { collectorTestEnv } from "../ingest/test-support/env";
import { now, seed } from "./fixture";
import { runV2CandidateUnit } from "./index";

beforeEach(async () => {
  await reset();
  await executeTestSql(env.FORECAST_DB, schema, applyD1Migrations);
  await seed(env.FORECAST_DB);
});

it("stores a median candidate once, preserving the S43 instants and grants", async () => {
  const configuration = { ...collectorTestEnv, FORECAST_V2_MODE: "on" as const };
  expect(await runV2CandidateUnit(configuration, now)).toEqual({ outcome: "built" });
  const row = await env.FORECAST_DB.prepare("SELECT payload_json FROM forecast_candidates").first<{
    payload_json: string;
  }>();
  const candidate = JSON.parse(row!.payload_json);
  expect(candidate.schedule.soloPeriods).toContainEqual({
    round: 43,
    segment: 1,
    scheduleStatus: "estimated",
    effectiveFrom: "2026-11-12T03:00:00.000Z",
    effectiveUntil: "2026-11-18T19:59:59.000Z",
  });
  expect(candidate.grants[0].refs).toEqual([
    { lawId: "box-ii-v1", count: 10 },
    { lawId: "regular-box-v1", count: 5 },
  ]);
  expect(await runV2CandidateUnit(configuration, now)).toEqual({ outcome: "unchanged" });
  expect(
    await env.FORECAST_DB.prepare("SELECT COUNT(*) AS n FROM forecast_candidates").first("n"),
  ).toBe(1);
});

it("does not write when legacy mode is selected", async () => {
  expect(await runV2CandidateUnit(collectorTestEnv, now)).toEqual({
    outcome: "held",
    reason: "v2_disabled",
  });
  expect(
    await env.FORECAST_DB.prepare("SELECT COUNT(*) AS n FROM forecast_candidates").first("n"),
  ).toBe(0);
});

it("builds and stores byte-identical legacy candidates with mode off", async () => {
  const off = { ...collectorTestEnv, FORECAST_V2_MODE: "off" as const };
  const text = "Solo Raid";
  const item = {
    source: "naver-board-56" as const,
    itemId: "8060044",
    url: "https://game.naver.com/lounge/nikke/board/detail/8060044",
    title: text,
    excerpt: text,
    normalizedText: text,
    publishedAt: "2026-08-18T03:00:00.000Z",
    contentHash: await sha256Hex(text),
    structured: true,
    official: true,
  };
  const event: ScheduleEvent = {
    eventId: "legacy-test",
    eventType: "solo",
    sourceItem: item,
    startsAt: "2026-08-20T03:00:00.000Z",
    endsAt: "2026-08-26T19:59:00.000Z",
    scheduleStatus: "confirmed",
    manualReview: false,
    reason: null,
  };
  const at = Date.parse("2026-08-24T00:00:00Z");
  const resolved = resolveSoloSchedule([event], at)!;
  const probe = { status: "x_unavailable" as const, sourceItem: null, reason: null };
  const expected = await buildForecastCandidate(resolved, [event], probe, at, 1, [], {
    cadenceVersion: "observed-mean-thursday-v1",
  });
  await runV2CandidateUnit(off, at);
  const actual = await buildForecastCandidate(resolved, [event], probe, at, 1);
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  await processSourceQueue(off.FORECAST_DB, {
    mode: "bootstrap",
    results: [{ source: item.source, itemId: item.itemId, outcome: "processed", item, event }],
    candidate: {
      eventId: event.eventId,
      gameDay: actual.candidate.forecastId.slice(7, 17),
      revision: 1,
      envelope: actual,
    },
  });
  expect(
    await off.FORECAST_DB.prepare("SELECT payload_json FROM forecast_candidates").first(
      "payload_json",
    ),
  ).toBe(JSON.stringify(expected.candidate));
});

it("leaves sealed and approved fixture bytes unchanged when a new input builds", async () => {
  const db = env.FORECAST_DB;
  const configuration = { ...collectorTestEnv, FORECAST_V2_MODE: "on" as const };
  await runV2CandidateUnit(configuration, now);
  const row = await db
    .prepare("SELECT candidate_id,payload_hash,payload_json FROM forecast_candidates")
    .first<{ candidate_id: string; payload_hash: string; payload_json: string }>();
  const id = row!.candidate_id;
  const hash = row!.payload_hash;
  // Local fixture records, not a seal/approval operation or a real signature.
  await db
    .prepare(
      `INSERT INTO forecast_runtime_versions VALUES(?,?,'schedule-kit-v4',5,'certified-daily-v4',?,?)`,
    )
    .bind(id, hash, new TextEncoder().encode(row!.payload_json).length, now)
    .run();
  await db
    .prepare(
      "INSERT INTO forecast_runtime_active(singleton,environment,sequence) VALUES(1,'staging',0)",
    )
    .run();
  await db
    .prepare(`INSERT INTO forecast_runtime_reviews VALUES(?,?,'staging','approve',?,?,0,NULL,?,?)`)
    .bind("a".repeat(32), "fixture-review", id, hash, now + 1000, now)
    .run();
  await db
    .prepare(`INSERT INTO forecast_runtime_commands
    (interaction_id,review_id,request_hash,actor_id,state,created_at,updated_at)
    VALUES('fixture',?,?,'fixture','pending',?,?)`)
    .bind("a".repeat(32), "b".repeat(64), now, now)
    .run();
  await db
    .prepare(
      "INSERT INTO forecast_runtime_approvals VALUES(?,'fixture','staging',?,'fixture',?,'fixture',?)",
    )
    .bind(id, hash, "x".repeat(88), now)
    .run();
  const bytes = async () =>
    JSON.stringify(
      await Promise.all([
        db.prepare("SELECT * FROM forecast_candidates WHERE candidate_id=?").bind(id).first(),
        db.prepare("SELECT * FROM forecast_runtime_versions WHERE candidate_id=?").bind(id).first(),
        db
          .prepare("SELECT * FROM forecast_runtime_approvals WHERE candidate_id=?")
          .bind(id)
          .first(),
      ]),
    );
  const before = await bytes();
  await db
    .prepare("INSERT INTO forecast_v2_grant_revisions VALUES('test',2,'2026-10-18',11,5,NULL,?)")
    .bind(new Date(now).toISOString())
    .run();
  await db
    .prepare("UPDATE forecast_v2_grant_heads SET revision=2,ii_qty=11 WHERE occurrence_id='test'")
    .run();
  expect(await runV2CandidateUnit(configuration, now)).toEqual({ outcome: "built" });
  expect(await bytes()).toBe(before);
});
