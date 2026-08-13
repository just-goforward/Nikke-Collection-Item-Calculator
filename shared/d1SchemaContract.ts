export const D1_SCHEMA_CONTRACT_VERSION = 1 as const;

export const REQUIRED_D1_SCHEMA = {
  event_ids: ["id", "created_at"],
  rate_limits: ["key", "count", "expires_at"],
  event_aggregates: ["date_key", "events", "attempts", "great_successes", "last_seen"],
  referrer_aggregates: ["date_key", "source_host", "events", "last_seen"],
  client_env_aggregates: ["browser", "os", "device_type", "events", "last_seen"],
  solver_diagnostic_aggregates: ["diagnostic_version", "legacy_supply_cost_bucket", "events"],
  solver_runtime_aggregates: [
    "memory_strategy",
    "min_ef_memo_tier",
    "phase2_memo_tier",
    "phase2_memo_retried",
    "attempted_node_count_bucket",
    "solve_ms_bucket",
  ],
  solver_cache_aggregates: ["requested_backend", "terminal_backend", "execution_kind"],
  calculation_locale_aggregates: ["locale", "requested_backend", "terminal_backend"],
  solver_recovery_rung_aggregates: ["rung_backend", "rung_exit", "memo_tier", "device_type"],
  solver_recovery_terminal_aggregates: [
    "min_ef_exit",
    "phase2_exit",
    "js_exit",
    "terminal_outcome",
  ],
  runtime_invariant_aggregates: ["invariant_code", "component", "lane", "device_type"],
} as const;
