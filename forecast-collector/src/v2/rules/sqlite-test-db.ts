import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

function metadata(changes = 0): D1Meta & Record<string, unknown> {
  return {
    changes,
    changed_db: changes > 0,
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: changes,
    last_row_id: 0,
  };
}

class Statement implements D1PreparedStatement {
  values: SQLInputValue[] = [];
  constructor(
    readonly sqlite: DatabaseSync,
    readonly sql: string,
  ) {}
  bind(...values: SQLInputValue[]) {
    this.values = values;
    return this;
  }
  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const value = this.sqlite.prepare(this.sql).get(...this.values);
    return (column ? (value?.[column] ?? null) : (value ?? null)) as T | null;
  }
  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return {
      results: this.sqlite.prepare(this.sql).all(...this.values) as T[],
      success: true,
      meta: metadata(),
    };
  }
  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const result = this.sqlite.prepare(this.sql).run(...this.values);
    return { success: true, results: [], meta: metadata(Number(result.changes)) };
  }
  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw(): Promise<never> {
    throw new Error("raw is not supported by the local rules test database");
  }
}
export function localDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    readFileSync(new URL("../../../fixtures/schema-v27-test.sql", import.meta.url), "utf8"),
  );
  const db: D1Database = {
    prepare: (sql: string) => new Statement(sqlite, sql),
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      sqlite.exec("BEGIN");
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run<T>());
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    async exec() {
      throw new Error("exec is not supported by the local rules test database");
    },
    async dump() {
      throw new Error("dump is not supported by the local rules test database");
    },
    withSession() {
      return { prepare: db.prepare, batch: db.batch, getBookmark: () => null };
    },
  };
  return { db, sqlite };
}
