import { expect, it } from "vitest";
import { maintenanceDependents } from "./maintenance-dependents";
import { localDatabase } from "./sqlite-test-db";

/**
 * D1 allows at most 100 bound parameters per query. One placeholder per removed link id
 * would exceed that as soon as a batch moves >99 links, so the ambiguity lookahead binds
 * its id lists as JSON instead. This spec seeds such a batch on the Node/SQLite lane,
 * where 120 links cost milliseconds, and asserts the lookahead's bind count directly.
 */
const D1_BOUND_PARAMETER_LIMIT = 100;

const hex = (index: number) => index.toString(16).padStart(2, "0").repeat(32);

/** Wrap a database so every prepared statement's SQL and bind values are observable. */
function countingDatabase(db: D1Database) {
  const issued: { sql: string; values: unknown[] }[] = [];
  const counting = new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "prepare") return Reflect.get(target, property, receiver);
      return (sql: string) => {
        const statement = target.prepare(sql);
        return new Proxy(statement, {
          get(stmt, key, recv) {
            if (key === "bind")
              return (...values: unknown[]) => {
                issued.push({ sql, values });
                return stmt.bind(...values);
              };
            const value = Reflect.get(stmt, key, recv);
            return typeof value === "function" ? value.bind(stmt) : value;
          },
        });
      };
    },
  }) as D1Database;
  return { db: counting, issued };
}

it("keeps the ambiguity lookahead within D1's bind budget for a 120-link batch", async () => {
  const { db: raw } = localDatabase();
  const now = "2026-07-03T18:00:00.000Z";
  const oldEnd = "2026-07-03T19:00:00.000Z";
  const newEnd = "2026-07-03T20:00:00.000Z";
  // One colliding grant moves this many links in a single batch.
  const movingLinks = 120;
  expect(movingLinks).toBeGreaterThan(D1_BOUND_PARAMETER_LIMIT);
  await raw.batch([
    raw
      .prepare(`INSERT INTO forecast_v2_calendar_revisions
        (event_id,revision,kind,status,starts_at,ends_at,source_feed_ids_json,created_at)
        VALUES('m',1,'maintenance','confirmed',?,?, '[]',?)`)
      .bind(now, oldEnd, now),
    raw.prepare("INSERT INTO forecast_v2_calendar_heads VALUES('m',1)"),
    // 'moved' loses every link; 'survivor' keeps one the batch never touches.
    raw
      .prepare(`INSERT INTO forecast_v2_grant_revisions VALUES('moved',1,'2026-07-02',10,0,NULL,?)`)
      .bind(now),
    raw.prepare("INSERT INTO forecast_v2_grant_heads VALUES('moved',1,'2026-07-02',10,0)"),
    raw
      .prepare(
        `INSERT INTO forecast_v2_grant_revisions VALUES('survivor',1,'2026-07-02',20,0,NULL,?)`,
      )
      .bind(now),
    raw.prepare("INSERT INTO forecast_v2_grant_heads VALUES('survivor',1,'2026-07-02',20,0)"),
    // A new-day destination with a third quantity: no `exact` re-link, so links are deleted.
    raw
      .prepare(
        `INSERT INTO forecast_v2_grant_revisions VALUES('target',1,'2026-07-04',30,0,NULL,?)`,
      )
      .bind(now),
    raw.prepare("INSERT INTO forecast_v2_grant_heads VALUES('target',1,'2026-07-04',30,0)"),
    raw
      .prepare("INSERT INTO forecast_v2_post_versions VALUES('v_bulk','999',?,?,48,?,?, 'body')")
      .bind(now, hex(0), now, now),
    // One shared version carries every observation, so seeding stays linear and cheap.
    ...Array.from({ length: movingLinks + 1 }, (_, index) => [
      raw
        .prepare(
          "INSERT INTO forecast_v2_grant_observations VALUES(?, 'v_bulk','999',?,0,'[]','legacy_unverified',?)",
        )
        .bind(`observation_${index}`, index + 1, now),
      raw
        .prepare("INSERT INTO forecast_v2_grant_links VALUES(?,?,?,NULL)")
        .bind(`link_${index}`, index < movingLinks ? "moved" : "survivor", `observation_${index}`),
    ]).flat(),
  ]);
  // Every observation of the moving grant gets a maintenance_end candidate that resolves
  // to the old end; the survivor's own link is left untouched, so it keeps its occurrence.
  await raw
    .prepare(
      `UPDATE forecast_v2_grant_observations
      SET date_basis='maintenance_end',candidate_dates_json=?
      WHERE feed_id='999' AND observation_id IN (
        SELECT observation_id FROM forecast_v2_grant_links WHERE occurrence_id='moved')`,
    )
    .bind(JSON.stringify([oldEnd]))
    .run();

  const { db, issued } = countingDatabase(raw);
  await db.batch(await maintenanceDependents(db, "m", 2, oldEnd, newEnd, now, "staging"));

  const lookahead = issued.filter((entry) => entry.sql.includes("l.link_id NOT IN"));
  expect(lookahead).toHaveLength(movingLinks);
  // Precondition: each lookahead really carries every removed id, so binding one
  // placeholder per id would need >100 parameters (D1's per-query limit).
  for (const entry of lookahead) {
    const removed = JSON.parse(String(entry.values[1])) as string[];
    expect(removed.length).toBe(movingLinks);
    expect(removed.length).toBeGreaterThan(D1_BOUND_PARAMETER_LIMIT);
  }
  // ...and it binds only (feedId, removed-ids JSON, relinked JSON): a constant 3.
  expect(new Set(lookahead.map((entry) => entry.values.length))).toEqual(new Set([3]));
  expect(Math.max(...issued.map((entry) => entry.values.length))).toBeLessThanOrEqual(
    D1_BOUND_PARAMETER_LIMIT,
  );

  const reasons = (
    await raw
      .prepare(
        "SELECT json_extract(payload_json,'$.evidence.reason') AS reason FROM forecast_v2_decision_requests",
      )
      .all()
  ).results.map((row) => String(row["reason"]));
  // One decision per moved link, all unambiguous: 'survivor' is the only occurrence left.
  expect(reasons).toHaveLength(movingLinks);
  expect(new Set(reasons)).toEqual(new Set(["grant_quantity"]));
});
