export const D1_SCHEMA_CONTRACT_VERSION = 4 as const;

type D1TableContract = {
  columns: readonly string[];
  primaryKey: readonly string[];
};

export const REQUIRED_D1_SCHEMA = {
  forecast_profile_aggregates: {
    columns: [
      "date_key",
      "event_kind",
      "event_version",
      "forecast_id",
      "forecast_profile_id",
      "solver_backend",
      "events",
      "last_seen",
    ],
    primaryKey: [
      "date_key",
      "event_kind",
      "event_version",
      "forecast_id",
      "forecast_profile_id",
      "solver_backend",
    ],
  },
  event_ids: {
    columns: ["id", "created_at"],
    primaryKey: ["id"],
  },
  rate_limits: {
    columns: ["key", "count", "expires_at"],
    primaryKey: ["key"],
  },
  event_aggregates: {
    columns: [
      "date_key",
      "grade",
      "level",
      "exp_bucket",
      "kit",
      "recommended_uses",
      "outcome",
      "success_attempt",
      "events",
      "attempts",
      "great_successes",
      "last_seen",
    ],
    primaryKey: [
      "date_key",
      "grade",
      "level",
      "exp_bucket",
      "kit",
      "recommended_uses",
      "outcome",
      "success_attempt",
    ],
  },
  referrer_aggregates: {
    columns: ["date_key", "source_host", "events", "last_seen"],
    primaryKey: ["date_key", "source_host"],
  },
  client_env_aggregates: {
    columns: [
      "date_key",
      "browser",
      "browser_major",
      "os",
      "os_major",
      "device_type",
      "events",
      "last_seen",
    ],
    primaryKey: ["date_key", "browser", "browser_major", "os", "os_major", "device_type"],
  },
  solver_diagnostic_aggregates: {
    columns: [
      "date_key",
      "diagnostic_version",
      "forecast_id",
      "solver_version",
      "solver_phase",
      "grade",
      "level",
      "exp_bucket",
      "strategy",
      "stock_bucket_blue",
      "stock_bucket_purple",
      "stock_bucket_yellow",
      "recommended_kit",
      "recommended_uses_bucket",
      "candidate_count_bucket",
      "probability_gap_bucket",
      "resource_cost_bucket",
      "legacy_supply_cost_bucket",
      "total_expected_cost_bucket",
      "blue_share_bucket",
      "min_autonomy_days_bucket",
      "changed_from_single",
      "changed_from_legacy_supply",
      "legacy_private_stats_available",
      "legacy_event_aggregate_matchable",
      "events",
      "last_seen",
    ],
    primaryKey: [
      "date_key",
      "diagnostic_version",
      "forecast_id",
      "solver_version",
      "solver_phase",
      "grade",
      "level",
      "exp_bucket",
      "strategy",
      "stock_bucket_blue",
      "stock_bucket_purple",
      "stock_bucket_yellow",
      "recommended_kit",
      "recommended_uses_bucket",
      "candidate_count_bucket",
      "probability_gap_bucket",
      "resource_cost_bucket",
      "legacy_supply_cost_bucket",
      "total_expected_cost_bucket",
      "blue_share_bucket",
      "min_autonomy_days_bucket",
      "changed_from_single",
      "changed_from_legacy_supply",
      "legacy_private_stats_available",
      "legacy_event_aggregate_matchable",
    ],
  },
  solver_runtime_aggregates: {
    columns: [
      "date_key",
      "diagnostic_version",
      "forecast_id",
      "solver_version",
      "solver_phase",
      "solver_backend",
      "fallback_from",
      "fallback_reason",
      "memory_strategy",
      "min_ef_memo_tier",
      "phase2_memo_tier",
      "phase2_memo_retried",
      "grade",
      "level",
      "exp_bucket",
      "stock_bucket_blue",
      "stock_bucket_purple",
      "stock_bucket_yellow",
      "node_count_bucket",
      "attempted_node_count_bucket",
      "solve_ms_bucket",
      "events",
      "last_seen",
    ],
    primaryKey: [
      "date_key",
      "diagnostic_version",
      "forecast_id",
      "solver_version",
      "solver_phase",
      "solver_backend",
      "fallback_from",
      "fallback_reason",
      "memory_strategy",
      "min_ef_memo_tier",
      "phase2_memo_tier",
      "phase2_memo_retried",
      "grade",
      "level",
      "exp_bucket",
      "stock_bucket_blue",
      "stock_bucket_purple",
      "stock_bucket_yellow",
      "node_count_bucket",
      "attempted_node_count_bucket",
      "solve_ms_bucket",
    ],
  },
  solver_cache_aggregates: {
    columns: [
      "date_key",
      "diagnostic_version",
      "forecast_id",
      "requested_backend",
      "terminal_backend",
      "execution_kind",
      "grade",
      "level",
      "exp_bucket",
      "stock_bucket_blue",
      "stock_bucket_purple",
      "stock_bucket_yellow",
      "events",
      "last_seen",
    ],
    primaryKey: [
      "date_key",
      "diagnostic_version",
      "forecast_id",
      "requested_backend",
      "terminal_backend",
      "execution_kind",
      "grade",
      "level",
      "exp_bucket",
      "stock_bucket_blue",
      "stock_bucket_purple",
      "stock_bucket_yellow",
    ],
  },
  calculation_locale_aggregates: {
    columns: [
      "date_key",
      "diagnostic_version",
      "forecast_id",
      "locale",
      "requested_backend",
      "terminal_backend",
      "execution_kind",
      "events",
      "last_seen",
    ],
    primaryKey: [
      "date_key",
      "diagnostic_version",
      "forecast_id",
      "locale",
      "requested_backend",
      "terminal_backend",
      "execution_kind",
    ],
  },
  solver_recovery_rung_aggregates: {
    columns: [
      "date_key",
      "recovery_version",
      "forecast_id",
      "policy_version",
      "requested_backend",
      "rung_backend",
      "rung_exit",
      "memo_tier",
      "grade",
      "level",
      "exp_bucket",
      "stock_bucket_blue",
      "stock_bucket_purple",
      "stock_bucket_yellow",
      "device_type",
      "events",
      "last_seen",
    ],
    primaryKey: [
      "date_key",
      "recovery_version",
      "forecast_id",
      "policy_version",
      "requested_backend",
      "rung_backend",
      "rung_exit",
      "memo_tier",
      "grade",
      "level",
      "exp_bucket",
      "stock_bucket_blue",
      "stock_bucket_purple",
      "stock_bucket_yellow",
      "device_type",
    ],
  },
  solver_recovery_terminal_aggregates: {
    columns: [
      "date_key",
      "recovery_version",
      "forecast_id",
      "policy_version",
      "requested_backend",
      "min_ef_exit",
      "phase2_exit",
      "js_exit",
      "terminal_backend",
      "terminal_outcome",
      "grade",
      "level",
      "exp_bucket",
      "stock_bucket_blue",
      "stock_bucket_purple",
      "stock_bucket_yellow",
      "device_type",
      "events",
      "last_seen",
    ],
    primaryKey: [
      "date_key",
      "recovery_version",
      "forecast_id",
      "policy_version",
      "requested_backend",
      "min_ef_exit",
      "phase2_exit",
      "js_exit",
      "terminal_backend",
      "terminal_outcome",
      "grade",
      "level",
      "exp_bucket",
      "stock_bucket_blue",
      "stock_bucket_purple",
      "stock_bucket_yellow",
      "device_type",
    ],
  },
  runtime_invariant_aggregates: {
    columns: [
      "date_key",
      "invariant_version",
      "invariant_code",
      "component",
      "lane",
      "device_type",
      "events",
      "last_seen",
    ],
    primaryKey: [
      "date_key",
      "invariant_version",
      "invariant_code",
      "component",
      "lane",
      "device_type",
    ],
  },
} as const satisfies Record<string, D1TableContract>;

export type D1SchemaRow = {
  column_name?: unknown;
  primary_key_position?: unknown;
  table_name?: unknown;
};

export function validateD1SchemaRows(rows: readonly D1SchemaRow[]) {
  const actual = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (typeof row.table_name !== "string" || typeof row.column_name !== "string") continue;
    const columns = actual.get(row.table_name) ?? new Map<string, number>();
    const primaryKeyPosition = Number(row.primary_key_position ?? 0);
    columns.set(
      row.column_name,
      Number.isInteger(primaryKeyPosition) && primaryKeyPosition > 0 ? primaryKeyPosition : 0,
    );
    actual.set(row.table_name, columns);
  }

  const failures: string[] = [];
  for (const [table, contract] of Object.entries(REQUIRED_D1_SCHEMA)) {
    const columns = actual.get(table);
    if (!columns) {
      failures.push(`missing table: ${table}`);
      continue;
    }
    for (const column of contract.columns) {
      if (!columns.has(column)) failures.push(`missing column: ${table}.${column}`);
    }
    const actualPrimaryKey = [...columns.entries()]
      .filter((entry) => entry[1] > 0)
      .sort((a, b) => a[1] - b[1])
      .map((entry) => entry[0]);
    if (actualPrimaryKey.join("\0") !== contract.primaryKey.join("\0")) {
      failures.push(
        `primary key mismatch: ${table} (expected ${contract.primaryKey.join(", ")}; received ${actualPrimaryKey.join(", ") || "none"})`,
      );
    }
  }
  return failures;
}
