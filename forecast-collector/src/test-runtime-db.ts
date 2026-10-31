import type { DatabaseSync, SQLInputValue } from "node:sqlite";

/** Local SQLite adapter: execute the collector's actual transactional SQL. */
export function runtimeTestDb(database: DatabaseSync): D1Database {
  const prepare = (sql: string, bindings: unknown[] = []): D1PreparedStatement => {
    const query = <T>(): D1Result<T> => {
      const statement = database.prepare(sql);
      const values = bindings as SQLInputValue[];
      const results = statement.columns().length ? statement.all(...values) : [];
      const changes = statement.columns().length ? 0 : Number(statement.run(...values).changes);
      return {
        results: results as T[],
        success: true,
        meta: {
          changes,
          changed_db: changes > 0,
          rows_read: results.length,
          rows_written: changes,
          duration: 0,
          size_after: 0,
          last_row_id: 0,
        },
      };
    };
    return {
      bind: (...values: unknown[]) => prepare(sql, values),
      all: async <T>() => query<T>(),
      first: async <T>(column?: string): Promise<T | null> => {
        const row = query<Record<string, unknown>>().results[0] ?? null;
        return (column && row ? row[column] : row) as T | null;
      },
      run: async <T>() => query<T>(),
      raw: async () => unsupportedOperation("raw"),
    };
  };
  return {
    prepare,
    batch: async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
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
    exec: async () => unsupportedOperation("exec"),
    dump: async () => unsupportedOperation("dump"),
    withSession: () => unsupportedOperation("withSession"),
  };
}

function unsupportedOperation(operation: string): never {
  throw new Error(`runtime_test_db_unsupported_${operation}`);
}
