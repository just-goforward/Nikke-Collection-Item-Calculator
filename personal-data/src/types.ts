/** Structural subset of the D1 binding, also usable by the local test runtime. */
interface SqlResult<T = Record<string, unknown>> {
  results: T[];
  meta: { changes: number };
  success: boolean;
}
export interface SqlStatement {
  bind(...values: (string | number | null)[]): SqlStatement;
  run<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  batch<T = Record<string, unknown>>(statements: SqlStatement[]): Promise<SqlResult<T>[]>;
  exec(sql: string): Promise<unknown>;
}
export interface PersonalEnv {
  PERSONAL_DB: SqlDatabase;
  PRIVACY_CONTROL_DB: SqlDatabase;
  PUBLIC_AGGREGATE_DB: SqlDatabase;
  SITE_ORIGIN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  PUBLICATION_ENABLED?: string;
}
