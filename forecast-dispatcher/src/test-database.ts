import type { DatabaseSync, SQLInputValue } from "node:sqlite";

/** Minimal D1 adapter over node:sqlite; `changes` counts real changes, triggers included. */
export function localDatabase(database: DatabaseSync): D1Database {
  const query = (sql: string, bindings: unknown[]): D1Result<unknown> => {
    const statement = database.prepare(sql);
    const values = bindings as SQLInputValue[];
    const columns = statement.columns().length;
    const results = columns ? statement.all(...values) : [];
    const changes = columns ? 0 : Number(statement.run(...values).changes);
    return {
      results,
      success: true,
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: results.length,
        rows_written: changes,
        last_row_id: 0,
        changed_db: changes > 0,
        changes,
      },
    };
  };
  const prepare = (sql: string): D1PreparedStatement => {
    const statement = (bindings: unknown[]): D1PreparedStatement => ({
      bind: (...values: unknown[]) => statement(values),
      first: async <T>(column?: string) => {
        const row = query(sql, bindings).results[0] as Record<string, unknown> | undefined;
        return (column && row ? row[column] : row) as T | null;
      },
      run: async <T>() => query(sql, bindings) as D1Result<T>,
      all: async <T>() => query(sql, bindings) as D1Result<T>,
      raw: async () => {
        throw new Error("runtime_test_db_unsupported_raw");
      },
    });
    return statement([]);
  };
  return {
    prepare,
    batch: async <T>(statements: D1PreparedStatement[]) => {
      database.exec("BEGIN");
      try {
        const results: D1Result<T>[] = [];
        for (const statement of statements) results.push(await statement.all<T>());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    exec: async () => {
      throw new Error("runtime_test_db_unsupported_exec");
    },
    dump: async () => {
      throw new Error("runtime_test_db_unsupported_dump");
    },
    withSession: () => {
      throw new Error("runtime_test_db_unsupported_withSession");
    },
  };
}
