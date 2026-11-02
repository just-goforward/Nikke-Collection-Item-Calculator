import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { executeTestSql } from "../../../../shared/testD1Sql";
import schema from "../../test-schema";
import { maintenanceDependents } from "./maintenance-dependents";

beforeEach(async () => {
  await reset();
  await executeTestSql(env.FORECAST_DB, schema, applyD1Migrations);
});

it("advances maintenance-dependent solo and collaboration heads atomically", async () => {
  const db = env.FORECAST_DB;
  const now = "2026-07-03T02:00:00.000Z";
  await db.batch([
    db
      .prepare(`INSERT INTO forecast_v2_calendar_revisions
      (event_id,revision,kind,status,starts_at,ends_at,start_game_day,end_game_day,source_feed_ids_json,created_at)
      VALUES('m',1,'maintenance','confirmed','2026-07-02T20:00:00.000Z','2026-07-03T03:00:00.000Z','2026-07-03','2026-07-03','[]',?)`)
      .bind(now),
    db.prepare("INSERT INTO forecast_v2_calendar_heads VALUES('m',1)"),
    ...(["solo", "collaboration"] as const).flatMap((kind) => [
      db
        .prepare(`INSERT INTO forecast_v2_calendar_revisions
        (event_id,revision,kind,status,starts_at,ends_at,start_game_day,end_game_day,maintenance_event_id,maintenance_revision,source_feed_ids_json,created_at)
        VALUES(?,1,?,'confirmed','2026-07-03T03:00:00.000Z','2026-07-30T19:59:59.000Z','2026-07-03','2026-07-30','m',1,'[]',?)`)
        .bind(kind, kind, now),
      db.prepare("INSERT INTO forecast_v2_calendar_heads VALUES(?,1)").bind(kind),
    ]),
  ]);
  const changed = await maintenanceDependents(
    db,
    "m",
    2,
    "2026-07-03T03:00:00.000Z",
    "2026-07-03T06:00:00.000Z",
    now,
  );
  await db.batch([
    db.prepare(`INSERT INTO forecast_v2_calendar_revisions
      SELECT event_id,2,kind,status,starts_at,'2026-07-03T06:00:00.000Z',start_game_day,end_game_day,
      maintenance_event_id,maintenance_revision,prediction_provenance_json,source_feed_ids_json,created_at
      FROM forecast_v2_calendar_revisions WHERE event_id='m' AND revision=1`),
    db.prepare("UPDATE forecast_v2_calendar_heads SET revision=2 WHERE event_id='m'"),
    ...changed,
  ]);
  const rows = await db
    .prepare(`SELECT starts_at,maintenance_revision FROM forecast_v2_calendar_revisions
    WHERE revision=2 AND kind IN ('solo','collaboration')`)
    .all();
  expect(rows.results).toEqual([
    { starts_at: "2026-07-03T06:00:00.000Z", maintenance_revision: 2 },
    { starts_at: "2026-07-03T06:00:00.000Z", maintenance_revision: 2 },
  ]);
});

it("marks a maintenance-grant collision ambiguous when both options would be rejected", async () => {
  const db = env.FORECAST_DB;
  const now = "2026-07-03T18:00:00.000Z";
  const oldEnd = "2026-07-03T19:00:00.000Z",
    newEnd = "2026-07-03T20:00:00.000Z";
  await db.batch([
    db
      .prepare(`INSERT INTO forecast_v2_calendar_revisions
      (event_id,revision,kind,status,starts_at,ends_at,source_feed_ids_json,created_at)
      VALUES('m',1,'maintenance','confirmed',?,?, '[]',?)`)
      .bind(now, oldEnd, now),
    db.prepare("INSERT INTO forecast_v2_calendar_heads VALUES('m',1)"),
    db
      .prepare("INSERT INTO forecast_v2_post_versions VALUES('mv','999',?,?,48,?,?, 'body')")
      .bind(now, "f".repeat(64), now, now),
    db
      .prepare(
        "INSERT INTO forecast_v2_grant_observations VALUES('mo','mv','999',10,0,?,'maintenance_end',?)",
      )
      .bind(JSON.stringify([oldEnd]), now),
    db
      .prepare(`INSERT INTO forecast_v2_grant_revisions VALUES('old',1,'2026-07-03',10,0,NULL,?)`)
      .bind(now),
    db.prepare("INSERT INTO forecast_v2_grant_heads VALUES('old',1,'2026-07-03',10,0)"),
    db.prepare("INSERT INTO forecast_v2_grant_links VALUES('old_link','old','mo',NULL)"),
    // Two more occurrences of the same feed: apply-grants would find >1 previous and
    // reject BOTH "별도 지급" and "정정" (grant_correction_target_ambiguous).
    ...["a", "b"]
      .map((suffix, index) => ({ suffix, index }))
      .flatMap(({ suffix, index }) => [
        db
          .prepare("INSERT INTO forecast_v2_post_versions VALUES(?,?,?,?,48,?,?, 'body')")
          .bind(`version_${suffix}`, "999", now, suffix.repeat(64), now, now),
        db
          .prepare(
            "INSERT INTO forecast_v2_grant_observations VALUES(?,?,'999',5,0,'[]','legacy_unverified',?)",
          )
          .bind(`observation_${suffix}`, `version_${suffix}`, now),
        // Distinct days/quantities: grant_heads keeps (game_day, ii, box) unique.
        db
          .prepare(`INSERT INTO forecast_v2_grant_revisions VALUES(?,1,?,5,0,NULL,?)`)
          .bind(`occurrence_${suffix}`, `2026-07-0${index + 1}`, now),
        db
          .prepare("INSERT INTO forecast_v2_grant_heads VALUES(?,1,?,?,0)")
          .bind(`occurrence_${suffix}`, `2026-07-0${index + 1}`, 5),
        db
          .prepare("INSERT INTO forecast_v2_grant_links VALUES(?,?,?,NULL)")
          .bind(`link_${suffix}`, `occurrence_${suffix}`, `observation_${suffix}`),
      ]),
    db
      .prepare(
        `INSERT INTO forecast_v2_grant_revisions VALUES('target',1,'2026-07-04',20,0,NULL,?)`,
      )
      .bind(now),
    db.prepare("INSERT INTO forecast_v2_grant_heads VALUES('target',1,'2026-07-04',20,0)"),
  ]);
  await db.batch(await maintenanceDependents(db, "m", 2, oldEnd, newEnd, now, "staging"));
  const request = await db
    .prepare("SELECT payload_json FROM forecast_v2_decision_requests")
    .first<Record<string, unknown>>();
  expect(request).not.toBeNull();
  const payload = JSON.parse(String(request?.["payload_json"])) as {
    evidence: { reason: string; confirmed: string[]; blocked?: string; todo?: string };
  };
  expect(payload.evidence.reason).toBe("grant_quantity_ambiguous");
  expect(payload.evidence.confirmed.join(" ")).toContain("이전 지급 기록");
  // Neither option can be applied, so the message must not say which button to press.
  expect(payload.evidence.todo).toBeUndefined();
  const outbox = await db
    .prepare(
      "SELECT payload_json FROM forecast_v2_notification_outbox WHERE kind='decision_request'",
    )
    .first<Record<string, unknown>>();
  expect(JSON.parse(String(outbox?.["payload_json"]))).toMatchObject({
    reason: "grant_quantity_ambiguous",
  });
});

it("marks a maintenance-grant collision ambiguous when the moved occurrence survives", async () => {
  const db = env.FORECAST_DB;
  const now = "2026-07-03T18:00:00.000Z";
  const oldEnd = "2026-07-03T19:00:00.000Z",
    newEnd = "2026-07-03T20:00:00.000Z";
  await db.batch([
    db
      .prepare(`INSERT INTO forecast_v2_calendar_revisions
      (event_id,revision,kind,status,starts_at,ends_at,source_feed_ids_json,created_at)
      VALUES('m',1,'maintenance','confirmed',?,?, '[]',?)`)
      .bind(now, oldEnd, now),
    db.prepare("INSERT INTO forecast_v2_calendar_heads VALUES('m',1)"),
    db
      .prepare("INSERT INTO forecast_v2_post_versions VALUES('mv','999',?,?,48,?,?, 'body')")
      .bind(now, "f".repeat(64), now, now),
    db
      .prepare(
        "INSERT INTO forecast_v2_grant_observations VALUES('mo','mv','999',10,0,?,'maintenance_end',?)",
      )
      .bind(JSON.stringify([oldEnd]), now),
    db
      .prepare(`INSERT INTO forecast_v2_grant_revisions VALUES('old',1,'2026-07-03',10,0,NULL,?)`)
      .bind(now),
    db.prepare("INSERT INTO forecast_v2_grant_heads VALUES('old',1,'2026-07-03',10,0)"),
    db.prepare("INSERT INTO forecast_v2_grant_links VALUES('old_link','old','mo',NULL)"),
    // The same feed has a second observation on the moved occurrence, linked from a
    // different basis: this batch deletes only the maintenance_end link, so occurrence
    // 'old' still counts for apply-grants' previousGrantOccurrences.
    db
      .prepare("INSERT INTO forecast_v2_post_versions VALUES('mv2','999',?,?,48,?,?, 'body')")
      .bind(now, "e".repeat(64), now, now),
    db
      .prepare(
        "INSERT INTO forecast_v2_grant_observations VALUES('mo2','mv2','999',10,0,'[]','in_post_datetime',?)",
      )
      .bind(now),
    db.prepare("INSERT INTO forecast_v2_grant_links VALUES('old_link2','old','mo2',NULL)"),
    // A second occurrence of the same feed on another day survives as well.
    db
      .prepare("INSERT INTO forecast_v2_post_versions VALUES('mv3','999',?,?,48,?,?, 'body')")
      .bind(now, "d".repeat(64), now, now),
    db
      .prepare(
        "INSERT INTO forecast_v2_grant_observations VALUES('mo3','mv3','999',7,0,'[]','in_post_datetime',?)",
      )
      .bind(now),
    db
      .prepare(`INSERT INTO forecast_v2_grant_revisions VALUES('other',1,'2026-07-01',7,0,NULL,?)`)
      .bind(now),
    db.prepare("INSERT INTO forecast_v2_grant_heads VALUES('other',1,'2026-07-01',7,0)"),
    db.prepare("INSERT INTO forecast_v2_grant_links VALUES('other_link','other','mo3',NULL)"),
    db
      .prepare(
        `INSERT INTO forecast_v2_grant_revisions VALUES('target',1,'2026-07-04',20,0,NULL,?)`,
      )
      .bind(now),
    db.prepare("INSERT INTO forecast_v2_grant_heads VALUES('target',1,'2026-07-04',20,0)"),
  ]);
  await db.batch(await maintenanceDependents(db, "m", 2, oldEnd, newEnd, now, "staging"));
  const payload = JSON.parse(
    String(
      await db
        .prepare("SELECT payload_json FROM forecast_v2_decision_requests")
        .first<string>("payload_json"),
    ),
  ) as { evidence: { reason: string; confirmed: string[]; todo?: string } };
  // apply-grants counts 'old' and 'other' and rejects BOTH options, so the message must
  // be the ambiguous variant rather than telling the approver to press a button.
  expect(payload.evidence.reason).toBe("grant_quantity_ambiguous");
  expect(payload.evidence.confirmed.join(" ")).toContain("이전 지급 기록: 2건");
  expect(payload.evidence.todo).toBeUndefined();
});

it("does not mark a collision ambiguous when the batch removes the other occurrences", async () => {
  const db = env.FORECAST_DB;
  const now = "2026-07-03T18:00:00.000Z";
  const oldEnd = "2026-07-03T19:00:00.000Z",
    newEnd = "2026-07-03T20:00:00.000Z";
  // Two occurrences A and B both move with the same maintenance: A keeps a non-moving
  // link of this feed, B is fully removed. After the batch only A survives, so apply
  // counts 1 and both options stay applicable.
  await db.batch([
    db
      .prepare(`INSERT INTO forecast_v2_calendar_revisions
      (event_id,revision,kind,status,starts_at,ends_at,source_feed_ids_json,created_at)
      VALUES('m',1,'maintenance','confirmed',?,?, '[]',?)`)
      .bind(now, oldEnd, now),
    db.prepare("INSERT INTO forecast_v2_calendar_heads VALUES('m',1)"),
    // A and B both hold a maintenance_end observation pointing at the old end.
    ...["a", "b"]
      .map((suffix, index) => ({ suffix, index }))
      .flatMap(({ suffix, index }) => [
        db
          .prepare("INSERT INTO forecast_v2_post_versions VALUES(?,?,?,?,48,?,?, 'body')")
          .bind(`version_${suffix}`, "999", now, suffix.repeat(64), now, now),
        db
          .prepare(
            "INSERT INTO forecast_v2_grant_observations VALUES(?,?, '999',10,0,?,'maintenance_end',?)",
          )
          .bind(`observation_${suffix}`, `version_${suffix}`, JSON.stringify([oldEnd]), now),
        db
          .prepare(`INSERT INTO forecast_v2_grant_revisions VALUES(?,1,?,10,0,NULL,?)`)
          .bind(`occurrence_${suffix}`, `2026-07-0${index + 1}`, now),
        db
          .prepare("INSERT INTO forecast_v2_grant_heads VALUES(?,1,?,?,0)")
          .bind(`occurrence_${suffix}`, `2026-07-0${index + 1}`, 10),
        db
          .prepare("INSERT INTO forecast_v2_grant_links VALUES(?,?,?,NULL)")
          .bind(`moving_${suffix}`, `occurrence_${suffix}`, `observation_${suffix}`),
      ]),
    // A keeps one more link of the same feed that this batch does not move.
    db
      .prepare(
        "INSERT INTO forecast_v2_post_versions VALUES('version_keep','999',?,?,48,?,?, 'body')",
      )
      .bind(now, "k".repeat(64), now, now),
    db
      .prepare(
        "INSERT INTO forecast_v2_grant_observations VALUES('observation_keep','version_keep','999',10,0,'[]','in_post_datetime',?)",
      )
      .bind(now),
    db.prepare(
      "INSERT INTO forecast_v2_grant_links VALUES('keep_link','occurrence_a','observation_keep',NULL)",
    ),
    db
      .prepare(
        `INSERT INTO forecast_v2_grant_revisions VALUES('target',1,'2026-07-04',20,0,NULL,?)`,
      )
      .bind(now),
    db.prepare("INSERT INTO forecast_v2_grant_heads VALUES('target',1,'2026-07-04',20,0)"),
  ]);
  await db.batch(await maintenanceDependents(db, "m", 2, oldEnd, newEnd, now, "staging"));
  const reasons = (
    await db.prepare("SELECT payload_json FROM forecast_v2_decision_requests").all()
  ).results.map(
    (row) =>
      (
        JSON.parse(String(row["payload_json"])) as {
          evidence: { reason: string; confirmed: string[]; todo?: string };
        }
      ).evidence,
  );
  expect(reasons.length).toBeGreaterThan(0);
  // A survives alone, so apply finds one previous occurrence and accepts either option.
  for (const evidence of reasons) {
    expect(evidence.reason).toBe("grant_quantity");
    expect(evidence.confirmed.join(" ")).not.toContain("이전 지급 기록:");
    expect(evidence.todo).toBeDefined();
  }
});

it("does not mark a collision ambiguous when only one unrelated occurrence survives", async () => {
  const db = env.FORECAST_DB;
  const now = "2026-07-03T18:00:00.000Z";
  const oldEnd = "2026-07-03T19:00:00.000Z",
    newEnd = "2026-07-03T20:00:00.000Z";
  // Both moving occurrences lose every link of this feed in this batch; one unrelated
  // occurrence stays. apply counts 1, so the message must not claim auto-apply is lost.
  await db.batch([
    db
      .prepare(`INSERT INTO forecast_v2_calendar_revisions
      (event_id,revision,kind,status,starts_at,ends_at,source_feed_ids_json,created_at)
      VALUES('m',1,'maintenance','confirmed',?,?, '[]',?)`)
      .bind(now, oldEnd, now),
    db.prepare("INSERT INTO forecast_v2_calendar_heads VALUES('m',1)"),
    ...["a", "b"]
      .map((suffix, index) => ({ suffix, index }))
      .flatMap(({ suffix, index }) => [
        db
          .prepare("INSERT INTO forecast_v2_post_versions VALUES(?,?,?,?,48,?,?, 'body')")
          .bind(`version_${suffix}`, "999", now, suffix.repeat(64), now, now),
        db
          .prepare(
            "INSERT INTO forecast_v2_grant_observations VALUES(?,?, '999',10,0,?,'maintenance_end',?)",
          )
          .bind(`observation_${suffix}`, `version_${suffix}`, JSON.stringify([oldEnd]), now),
        db
          .prepare(`INSERT INTO forecast_v2_grant_revisions VALUES(?,1,?,10,0,NULL,?)`)
          .bind(`occurrence_${suffix}`, `2026-07-0${index + 1}`, now),
        db
          .prepare("INSERT INTO forecast_v2_grant_heads VALUES(?,1,?,?,0)")
          .bind(`occurrence_${suffix}`, `2026-07-0${index + 1}`, 10),
        db
          .prepare("INSERT INTO forecast_v2_grant_links VALUES(?,?,?,NULL)")
          .bind(`moving_${suffix}`, `occurrence_${suffix}`, `observation_${suffix}`),
      ]),
    db
      .prepare(
        "INSERT INTO forecast_v2_post_versions VALUES('version_other','999',?,?,48,?,?, 'body')",
      )
      .bind(now, "o".repeat(64), now, now),
    db
      .prepare(
        "INSERT INTO forecast_v2_grant_observations VALUES('observation_other','version_other','999',7,0,'[]','in_post_datetime',?)",
      )
      .bind(now),
    db
      .prepare(`INSERT INTO forecast_v2_grant_revisions VALUES('other',1,'2026-07-01',7,0,NULL,?)`)
      .bind(now),
    db.prepare("INSERT INTO forecast_v2_grant_heads VALUES('other',1,'2026-07-01',7,0)"),
    db.prepare(
      "INSERT INTO forecast_v2_grant_links VALUES('other_link','other','observation_other',NULL)",
    ),
    db
      .prepare(
        `INSERT INTO forecast_v2_grant_revisions VALUES('target',1,'2026-07-04',20,0,NULL,?)`,
      )
      .bind(now),
    db.prepare("INSERT INTO forecast_v2_grant_heads VALUES('target',1,'2026-07-04',20,0)"),
  ]);
  await db.batch(await maintenanceDependents(db, "m", 2, oldEnd, newEnd, now, "staging"));
  const evidence = JSON.parse(
    String(
      await db
        .prepare("SELECT payload_json FROM forecast_v2_decision_requests")
        .first<string>("payload_json"),
    ),
  ).evidence as { reason: string; confirmed: string[]; todo?: string };
  // Only 'other' survives the batch, so apply accepts either option.
  expect(evidence.reason).toBe("grant_quantity");
  expect(evidence.confirmed.join(" ")).not.toContain("이전 지급 기록:");
  expect(evidence.todo).toBeDefined();
});

// The lookahead's bound-parameter budget over a batch of >100 moved links is covered in
// decisions.maintenance-grants.spec.ts (Node/SQLite lane, where those ids are cheap to
// seed): it counts the binds the lookahead issues instead of raising a timeout. The real
// D1 limit those binds must stay under is asserted against workerd in
// decisions.bound-parameter.test.ts.
