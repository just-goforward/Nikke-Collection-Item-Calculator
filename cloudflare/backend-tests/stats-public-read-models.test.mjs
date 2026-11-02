import assert from "node:assert/strict";
import test from "node:test";
import { kitResultAggregateStatement } from "../src/kit-result-aggregate.ts";
import { SQLiteD1 } from "./sqlite-d1.mjs";

function fixture(t) {
  const db = new SQLiteD1();
  t.after(() => db.close());
  db.apply("../schema.sql");
  db.sqlite.exec(`
    INSERT INTO event_aggregates VALUES('2026-10-20','R',1,0,'blue',1,'no_great_success',0,2,2,0,1);
    INSERT INTO event_aggregates_game_day VALUES('2026-10-21','R',1,0,'blue',3,'great_success',2,3,6,3,2);
  `);
  db.apply("../decision-analytics/0002_stats_public_read_models.proposed.sql");
  return db;
}
function row(db, sql) { return { ...db.sqlite.prepare(sql).get() }; }

test("compact legacy read models preserve cumulative totals and the separate current game-day basis", (t) => {
  const db = fixture(t);
  assert.deepEqual(row(db, "SELECT * FROM stats_public_totals"), {
    grade: "R", level: 1, kit: "blue", events: 5, attempts: 8, great_successes: 3,
  });
  assert.deepEqual(row(db, "SELECT * FROM stats_public_game_day"), {
    date_key: "2026-10-21", events: 3, attempts: 6, great_successes: 3,
  });
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM event_aggregates").get().n, 1);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM event_aggregates_game_day").get().n, 1);
});

test("legacy settlement and compact summaries commit or roll back together without changing attempt-based rates", async (t) => {
  const db = fixture(t);
  const input = {
    dateKey: "2026-10-21", grade: "R", level: 1, expBucket: 0, kit: "blue",
    recommendedUses: 3, outcome: "great_success", successAttempt: 2, nowSeconds: 3,
  };
  await db.batch([kitResultAggregateStatement(db, input)]);
  assert.deepEqual(row(db, "SELECT events,attempts,great_successes FROM stats_public_totals"), {
    events: 6, attempts: 10, great_successes: 4,
  });
  assert.deepEqual(row(db, "SELECT events,attempts,great_successes FROM stats_public_game_day"), {
    events: 4, attempts: 8, great_successes: 4,
  });
  await assert.rejects(db.batch([
    kitResultAggregateStatement(db, input),
    db.prepare("INSERT INTO stats_public_totals VALUES('invalid',0,'blue',-1,0,0)"),
  ]));
  assert.deepEqual(row(db, "SELECT events,attempts,great_successes FROM event_aggregates_game_day"), {
    events: 4, attempts: 8, great_successes: 4,
  });
  assert.deepEqual(row(db, "SELECT events,attempts,great_successes FROM stats_public_totals"), {
    events: 6, attempts: 10, great_successes: 4,
  });
});

test("an unknown success attempt cannot increment the legacy numerator alone", (t) => {
  const db = fixture(t);
  const statement = kitResultAggregateStatement(db, {
    dateKey: "2026-10-21", grade: "R", level: 1, expBucket: 0, kit: "blue",
    recommendedUses: 3, outcome: "great_success", successAttempt: null, nowSeconds: 3,
  });
  assert.equal(statement, null);
  assert.deepEqual(row(db, "SELECT events,attempts,great_successes FROM stats_public_totals"), {
    events: 5, attempts: 8, great_successes: 3,
  });
});
