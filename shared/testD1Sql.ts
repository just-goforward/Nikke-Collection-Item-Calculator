type TestSqlDatabase = {
  prepare(sql: string): { run(): Promise<unknown> };
};

type TestSqlMigration = {
  name: string;
  queries: string[];
};

export async function executeTestSql<Database extends TestSqlDatabase>(
  db: Database,
  sql: string,
  applyMigrations: (
    db: Database,
    migrations: TestSqlMigration[],
    migrationTableName: string,
  ) => Promise<void>,
): Promise<void> {
  // Let D1 parse the complete script, including semicolons inside trigger bodies.
  // Keep the plugin's bookkeeping separate from the SQL's own migration ledger.
  await applyMigrations(db, [{ name: "test.sql", queries: [sql] }], "__test_sql_migrations");
  await db.prepare("DROP TABLE __test_sql_migrations").run();
}
