import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../forecast-collector");
const migration = readFileSync(resolve(root, "migrations/0027_board11_grants.sql"), "utf8");

it("admits only paired versions and preserves a subsequently superseded sealed candidate", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(readFileSync(resolve(root, "schema.sql"), "utf8"));
    for (const file of [
      "0022_forecast_runtime_versions",
      "0023_forecast_runtime_publication",
      "0024_runtime_ingestion",
      "0025_naver_page_policy",
      "0026_source_judgment_evidence",
    ]) {
      db.exec(readFileSync(resolve(root, `migrations/${file}.sql`), "utf8"));
    }
    db.exec(`
      INSERT INTO source_items VALUES('naver-board-48','1','u','t','e','t',printf('%064d',0),1,1,'t','t');
      INSERT INTO schedule_events VALUES('event','solo','naver-board-48','1',NULL,NULL,'confirmed',0,NULL,'t');
      INSERT INTO forecast_candidates VALUES('candidate','forecast','event','2026-01-01',1,'crosschecked','crosschecked',
        '{"candidateId":"candidate","forecastId":"forecast","rulesVersion":"schedule-kit-v3","payloadVersion":4,"certifiedSnapshot":{"version":"certified-daily-v3"}}',
        printf('%064d',0),'t','t');
      INSERT INTO forecast_runtime_versions SELECT candidate_id,payload_hash,'schedule-kit-v3',4,'certified-daily-v3',length(CAST(payload_json AS BLOB)),1 FROM forecast_candidates;
      UPDATE forecast_candidates SET state='superseded';
    `);
    const before = db.prepare("SELECT * FROM forecast_candidates").all();
    db.exec(`BEGIN;${migration}COMMIT;`);
    expect(db.prepare("SELECT * FROM forecast_candidates").all()).toEqual(before);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => db.exec("UPDATE forecast_runtime_versions SET sealed_at=2")).toThrow(
      "runtime_version_immutable",
    );
    const payload = JSON.stringify({
      candidateId: "v4",
      forecastId: "forecast",
      rulesVersion: "schedule-kit-v4",
      payloadVersion: 5,
      certifiedSnapshot: { version: "certified-daily-v4" },
    });
    db.prepare(
      "INSERT INTO forecast_candidates VALUES('v4','forecast','event','2026-01-02',1,'crosschecked','crosschecked',?,?,'t','t')",
    ).run(payload, "a".repeat(64));
    db.prepare(
      "INSERT INTO forecast_runtime_versions VALUES('v4',?,'schedule-kit-v4',5,'certified-daily-v4',?,1)",
    ).run("a".repeat(64), Buffer.byteLength(payload));
    const definition = String(
      db.prepare("SELECT sql FROM sqlite_schema WHERE name='forecast_runtime_versions'").get()?.[
        "sql"
      ],
    );
    const isolated = new DatabaseSync(":memory:");
    try {
      isolated.exec("PRAGMA foreign_keys=OFF");
      isolated.exec(definition);
      expect(() =>
        isolated.exec(
          "INSERT INTO forecast_runtime_versions VALUES('bad',printf('%064d',0),'schedule-kit-v4',4,'certified-daily-v4',1,1)",
        ),
      ).toThrow("CHECK");
    } finally {
      isolated.close();
    }
    db.exec("INSERT INTO forecast_grants VALUES('g','naver-board-11','1','2026-01-01',1,'t')");
    db.exec("INSERT INTO forecast_grant_revisions VALUES('g','hash','[]',NULL,1,'t')");
    db.exec(
      "INSERT INTO forecast_grant_restatements VALUES('naver-board-11','2','hash','g','{}','t')",
    );
    for (const table of [
      "forecast_grants",
      "forecast_grant_revisions",
      "forecast_grant_restatements",
    ]) {
      expect(() => db.exec(`DELETE FROM ${table}`)).toThrow("forecast_grant_immutable");
      expect(() => db.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`)).toThrow(
        "forecast_grant_immutable",
      );
    }
    expect(() =>
      db.exec(
        "INSERT INTO forecast_grants VALUES('other','naver-board-11','1','2026-01-01',1,'t')",
      ),
    ).toThrow("forecast_grant_immutable");
  } finally {
    db.close();
  }
});
