import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";
import { unstable_splitSqlQuery as splitSqlQuery } from "wrangler";
import { database, migrations, sqliteRunner } from "./forecast-migration-test-fixtures.ts";

const root = resolve(import.meta.dirname, "../forecast-collector");
const sql34 = readFileSync(resolve(root, "migrations/0034_runtime_publication_v5.sql"), "utf8");
const publicationTables = [
  "forecast_runtime_versions",
  "forecast_runtime_reviews",
  "forecast_runtime_commands",
  "forecast_runtime_approvals",
  "forecast_runtime_active",
  "forecast_runtime_activation_history",
  "forecast_runtime_outbox",
];
type LocalD1 = Awaited<ReturnType<Miniflare["getD1Database"]>>;
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function candidate(
  id: string,
  version: number,
  payloadVersion = version + 1,
  rulesVersion = version,
) {
  const json = JSON.stringify({
    candidateId: id,
    forecastId: "forecast",
    rulesVersion: `schedule-kit-v${rulesVersion}`,
    payloadVersion,
    certifiedSnapshot: { version: `certified-daily-v${version}` },
  });
  return {
    insert: `INSERT INTO forecast_candidates VALUES
      (${quote(id)},'forecast','event',${quote(id)},1,'crosschecked','crosschecked',
      ${quote(json)},${quote(hash(json))},'retained-created','retained-updated')`,
    seal: `INSERT INTO forecast_runtime_versions VALUES
      (${quote(id)},${quote(hash(json))},'schedule-kit-v${rulesVersion}',${payloadVersion},
      'certified-daily-v${version}',${Buffer.byteLength(json)},1)`,
    hash: hash(json),
  };
}

function activation(
  id: string,
  contentHash: string,
  sequence: number,
  previous: string | null,
  action: "approve" | "rollback" = "approve",
) {
  const operation = `operation-${sequence}`;
  const review = operation.padEnd(32, "0");
  const prior = previous === null ? "NULL" : quote(previous);
  // Synthetic signatures exercise SQL identity/length fences, not cryptography.
  const pointer = JSON.stringify({
    statement: {
      domain: "nikke.forecast.pointer.v1",
      environment: "staging",
      sequence,
      candidateId: id,
      contentHash,
      mode: "active",
      operationId: operation,
      issuedAt: sequence + 1,
      keyId: "test-key",
    },
    signature: "s".repeat(88),
  });
  return [
    `INSERT INTO forecast_runtime_reviews VALUES
      (${quote(review)},${quote(review)},'staging','${action}',${quote(id)},${quote(contentHash)},
      ${sequence - 1},${prior},10000,1)`,
    `INSERT INTO forecast_runtime_commands
      (interaction_id,review_id,request_hash,actor_id,state,created_at,updated_at) VALUES
      (${quote(operation)},${quote(review)},${quote(hash(operation))},'actor','pending',1,1)`,
    ...(action === "approve"
      ? [
          `INSERT INTO forecast_runtime_approvals VALUES
        (${quote(id)},${quote(operation)},'staging',${quote(contentHash)},'test-key',
        ${quote("s".repeat(88))},'actor',${sequence + 1})`,
        ]
      : []),
    `INSERT INTO forecast_runtime_activation_history VALUES
      (${quote(operation)},${quote(review)},'staging','${action}',${sequence},${prior},${quote(id)},
      'actor',${sequence + 1},${quote(pointer)})`,
  ];
}

async function execute(db: LocalD1, sql: string) {
  return db.batch(splitSqlQuery(sql).map((statement) => db.prepare(statement)));
}

async function migrate(db: LocalD1, from: number, through: number) {
  for (const migration of migrations.filter(
    (entry) => entry.version > from && entry.version <= through,
  )) {
    await execute(db, readFileSync(migration.file, "utf8"));
  }
}

async function snapshot(db: LocalD1) {
  const catalog = (
    await db
      .prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY name`)
      .all()
  ).results as Record<string, unknown>[];
  const tables = catalog.filter(
    (row) => row["type"] === "table" && row["name"] !== "schema_migrations",
  );
  const rows = Object.fromEntries(
    await Promise.all(
      tables.map(async (table) => [
        String(table["name"]),
        (await db.prepare(`SELECT * FROM "${table["name"]}" ORDER BY rowid`).all()).results,
      ]),
    ),
  );
  return { catalog, rows };
}

it("discovers 0034 and skips it on replay without changing its applied timestamp", () => {
  const db = database();
  const runner = sqliteRunner(db);
  expect(runner.run().versions).toEqual(Array.from({ length: 34 }, (_, i) => i + 1));
  const before = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
  expect(runner.run().applied).toEqual([]);
  expect(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(before);
  expect(db.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
});

it.each([false, true])(
  "local workerd D1: migrates from empty, historical v27=%s, keeps guards and rolls back atomically",
  async (historical) => {
    const mf = new Miniflare({
      workers: [
        {
          config: {
            name: "migration-test",
            compatibilityDate: "2026-08-14",
            manifest: {
              mainModule: "worker.js",
              modules: {
                "worker.js": {
                  type: "esm",
                  contents:
                    "export default { fetch() { return new Response('local migration test'); } };",
                },
              },
            },
            env: { DB: { type: "d1", id: "migration-test", dev: { remote: false } } },
          },
        },
      ],
    });
    try {
      const db = await mf.getD1Database("DB");
      // The supported empty-database path is the v21 bootstrap plus 0022 onward;
      // earlier incremental files are covered by the migration-runner specs.
      await execute(db, readFileSync(resolve(root, "schema.sql"), "utf8"));
      await migrate(db, 21, 27);
      await execute(
        db,
        `
        INSERT INTO source_items VALUES('naver-board-48','1','u','t','e','t',${quote("a".repeat(64))},1,1,'t','t');
        INSERT INTO schedule_events
          (event_id,event_type,source,source_item_id,schedule_status,manual_review,observed_at)
          VALUES('event','solo','naver-board-48','1','confirmed',0,'t');
        INSERT INTO forecast_runtime_active(singleton,environment,sequence) VALUES(1,'staging',0);
      `,
      );
      const v4 = candidate("v4", 4);
      if (historical) {
        // v1/v2 artifacts predate runtime sealing (0022 admitted only v3).
        // Preserve their opaque bytes; do not invent new legacy seal permissions.
        for (const version of [1, 2])
          await execute(db, candidate(`legacy-${version}`, version).insert);
        const v3 = candidate("v3-superseded", 3);
        await execute(
          db,
          `${v3.insert};${v3.seal};
          UPDATE forecast_candidates SET state='superseded' WHERE candidate_id='v3-superseded';
          ${v4.insert};${v4.seal};
          INSERT INTO candidate_sources VALUES('v4','naver-board-48','1');
          ${activation("v4", v4.hash, 1, null).join(";")};
          UPDATE forecast_runtime_outbox SET state='sent',message_id='retained-message',channel_id='channel';
        `,
        );
      }
      const at27 = await snapshot(db);
      await migrate(db, 27, 33);
      const before = await snapshot(db);
      const ledger = (await db.prepare("SELECT * FROM schema_migrations ORDER BY version").all())
        .results;
      // Every statement is separate (including each trigger body) within one batch.
      // This is the D1 100 KB per-statement limit, not a whole-file string prepare.
      const statements = splitSqlQuery(sql34);
      expect(
        Math.max(...statements.map((statement) => Buffer.byteLength(statement))),
      ).toBeLessThanOrEqual(100000);
      // Force a failure after the rebuild, trigger installation and ledger insert.
      await expect(
        execute(db, `${sql34}\nINSERT INTO schema_migrations VALUES(34,'duplicate');`),
      ).rejects.toThrow(/UNIQUE constraint failed/);
      expect(await snapshot(db)).toEqual(before);
      expect(
        (await db.prepare("SELECT * FROM schema_migrations ORDER BY version").all()).results,
      ).toEqual(ledger);

      await execute(db, sql34);
      const after = await snapshot(db);
      expect(after.rows).toEqual(before.rows);
      for (const [table, rows] of Object.entries(at27.rows))
        expect(after.rows[table]).toEqual(rows);
      // All external/attached triggers, indexes and unrelated table definitions survive exactly.
      const exceptVersionCheck = (row: Record<string, unknown>) =>
        row["name"] !== "forecast_runtime_versions";
      expect(after.catalog.filter(exceptVersionCheck)).toEqual(
        before.catalog.filter(exceptVersionCheck),
      );
      expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
      // D1 rejects PRAGMA integrity_check (SQLITE_AUTH); native SQLite covers it above.
      expect(
        (await db.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).results,
      ).toEqual(Array.from({ length: 34 }, (_, i) => ({ version: i + 1 })));

      const v5 = candidate("v5", 5);
      await execute(
        db,
        `${v5.insert};${v5.seal};${activation("v5", v5.hash, historical ? 2 : 1, historical ? "v4" : null).join(";")}`,
      );
      expect(await db.prepare("SELECT candidate_id FROM forecast_runtime_active").first()).toEqual({
        candidate_id: "v5",
      });
      if (historical) {
        await execute(db, activation("v4", v4.hash, 3, "v5", "rollback").join(";"));
        expect(
          await db.prepare("SELECT candidate_id,sequence FROM forecast_runtime_active").first(),
        ).toEqual({ candidate_id: "v4", sequence: 3 });
        expect(
          await db
            .prepare(
              "SELECT state FROM forecast_runtime_commands WHERE interaction_id='operation-3'",
            )
            .first(),
        ).toEqual({ state: "applied" });
      } else {
        for (const version of [3, 4]) {
          const old = candidate(`still-admitted-${version}`, version);
          await execute(db, `${old.insert};${old.seal}`);
        }
      }
      for (const [version, payload, rules] of [
        [6, 7, 6],
        [5, 5, 5],
        [5, 6, 4],
        [4, 6, 5],
      ]) {
        const bad = candidate(`bad-${version}-${payload}-${rules}`, version!, payload!, rules!);
        await expect(execute(db, `${bad.insert};${bad.seal}`)).rejects.toThrow(
          /CHECK constraint failed/,
        );
      }
      const mismatch = candidate("mismatch", 5);
      await expect(
        execute(
          db,
          `${mismatch.insert};${mismatch.seal.replace("'certified-daily-v5'", "'certified-daily-v4'")}`,
        ),
      ).rejects.toThrow(/runtime_version_invalid/);
      for (const table of publicationTables) {
        await expect(db.prepare(`DELETE FROM ${table}`).run()).rejects.toThrow(/runtime_/);
        await expect(
          db.prepare(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`).run(),
        ).rejects.toThrow(/runtime_/);
      }
      await expect(
        db.prepare("UPDATE forecast_runtime_versions SET sealed_at=2").run(),
      ).rejects.toThrow(/runtime_version_immutable/);
      await expect(
        db.prepare("UPDATE forecast_runtime_active SET sequence=sequence+1").run(),
      ).rejects.toThrow(/runtime_pointer_direct_write/);
      await expect(
        db
          .prepare("UPDATE forecast_candidates SET payload_json='{}' WHERE candidate_id='v5'")
          .run(),
      ).rejects.toThrow(/runtime_(approved_candidate_immutable|candidate_sealed)/);
      if (historical) {
        await expect(
          db.prepare("DELETE FROM candidate_sources WHERE candidate_id='v4'").run(),
        ).rejects.toThrow(/runtime_approved_source_immutable/);
      }
      expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    } finally {
      await mf.dispose();
    }
  },
  60000,
);
