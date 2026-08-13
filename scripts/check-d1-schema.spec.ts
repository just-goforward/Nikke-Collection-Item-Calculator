import { describe, expect, it } from "vitest";

import { REQUIRED_D1_SCHEMA } from "../shared/d1SchemaContract";
import { validateD1SchemaRows } from "./check-d1-schema";

function completeRows() {
  return Object.entries(REQUIRED_D1_SCHEMA).flatMap(([table_name, columns]) =>
    columns.map((column_name) => ({ column_name, table_name })),
  );
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
      "missing table: runtime_invariant_aggregates",
    ]);
  });
});
