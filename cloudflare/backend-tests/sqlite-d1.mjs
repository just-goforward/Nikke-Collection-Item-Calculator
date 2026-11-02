import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

/** Local SQLite transaction evidence, not a claim about deployed D1 state.
 * The clock is a boundary override; production SQL and constraints run unchanged.
 */
export class SQLiteD1 {
  constructor(now = Date.parse("2026-11-01T12:00:00Z")) {
    this.sqlite = new DatabaseSync(":memory:");
    this.now = now;
    this.sqlite.function("strftime", (format, value) => {
      if (format !== "%s" || value !== "now") throw new Error("unexpected_test_clock_query");
      return String(Math.floor(this.now / 1000));
    });
  }
  apply(relativePath) {
    this.sqlite.exec(readFileSync(new URL(relativePath, import.meta.url), "utf8"));
  }
  withSession() { return this; }
  prepare(sql) {
    const db = this;
    const statement = (args) => ({
      sql, args,
      bind: (...values) => statement(values),
      async first() { return db.sqlite.prepare(sql).get(...args) ?? null; },
      async all() { return { results: db.sqlite.prepare(sql).all(...args) }; },
      async run() { return { meta: db.sqlite.prepare(sql).run(...args) }; },
    });
    return statement([]);
  }
  async batch(statements) {
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map(({ sql, args }) => ({
        results: this.sqlite.prepare(sql).all(...args),
      }));
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  close() { this.sqlite.close(); }
}
