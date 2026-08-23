import { describe, expect, it } from "vitest";

import { REQUIRED_D1_SCHEMA, validateD1SchemaRows } from "../shared/d1SchemaContract";

function completeRows() {
  return Object.entries(REQUIRED_D1_SCHEMA).flatMap(([table_name, contract]) => {
    const primaryKey: readonly string[] = contract.primaryKey;
    return contract.columns.map((column_name) => ({
      column_name,
      primary_key_position: primaryKey.indexOf(column_name) + 1,
      table_name,
    }));
  });
}

describe("validateD1SchemaRows", () => {
  it("accepts the required deployment schema", () => {
    expect(validateD1SchemaRows(completeRows())).toEqual([]);
  });

  it("reports missing tables and migration-sensitive columns", () => {
    const rows = completeRows().filter(
      (row) =>
        row.table_name !== "runtime_invariant_aggregates" &&
        !(row.table_name === "solver_runtime_aggregates" && row.column_name === "solve_ms_bucket"),
    );

    expect(validateD1SchemaRows(rows)).toEqual([
      "missing column: solver_runtime_aggregates.solve_ms_bucket",
      expect.stringContaining("primary key mismatch: solver_runtime_aggregates"),
      "missing table: runtime_invariant_aggregates",
    ]);
  });

  it("reports primary key order mismatches that would break upserts", () => {
    const rows = completeRows().map((row) =>
      row.table_name === "calculation_locale_aggregates" && row.column_name === "execution_kind"
        ? { ...row, primary_key_position: 0 }
        : row,
    );

    expect(validateD1SchemaRows(rows)).toEqual([
      "primary key mismatch: calculation_locale_aggregates (expected date_key, diagnostic_version, forecast_id, locale, requested_backend, terminal_backend, execution_kind; received date_key, diagnostic_version, forecast_id, locale, requested_backend, terminal_backend)",
    ]);
  });
});
