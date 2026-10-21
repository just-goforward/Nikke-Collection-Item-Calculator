/**
 * Closed registry of every error code our Workers raise, log, or persist, and the ONE
 * sanitizer that maps a thrown value to a code that is safe for a log sink, a D1 column,
 * or a Discord ops alert.
 *
 * Scope: the Worker entries of cloudflare/, forecast-collector/, forecast-dispatcher/,
 * forecast-interactions/, forecast-admin/, site-worker/, usage-guard/ and stats-observer/,
 * plus every shared/ module in their relative value-import closure. The closure walk in
 * `scripts/error-codes.spec.ts` stops at `shared/certifiedSupply.ts` (legacy solver
 * internals) and `shared/generated/`. Deliberately outside the registry:
 *   - personal-data/, which keeps its own fixed log vocabulary (`personal-data/src/log.ts`);
 *   - codes written as SQL literals (`error_code='publication_delivery_exhausted'`; the
 *     `RAISE(ABORT,'…')` tokens of forecast-collector/migrations are mirrored in
 *     `D1_TRIGGER_CODES`) and status strings composed from literals or sanitizer output
 *     (`discord_http_<status>`, `stale_row`, `lease_lost`, `retry_after_*`);
 *   - forecast-collector v2 ingest reason codes, which are dynamic families the collector
 *     persists, not thrown messages (only the literal codes its Worker entry throws are
 *     registered).
 *
 * Contract: `errorCode` output is ALWAYS one of
 *   - a code registered below (`AppErrorCode`),
 *   - a fixed runtime error name from `SAFE_ERROR_NAMES`, or
 *   - a fixed category (`D1_ERROR`, `unexpected`);
 * `persistedErrorCode` additionally replaces a runtime error name with the policy's
 * registered fallback, so a D1 column only ever holds a registered code or `D1_ERROR`.
 * A string's shape (snake_case, a known prefix, a matching regex) grants it no trust, a
 * class identity grants its message no trust, and no captured message fragment is ever
 * emitted. `scripts/error-codes.spec.ts` walks every Worker's import closure and fails
 * when a thrown literal is not registered here (or explicitly classified there).
 */

/** Codes raised by D1 triggers (forecast-collector/migrations `RAISE(ABORT,'<code>')`). The
 * driver surfaces them as `D1_ERROR: <code>: SQLITE_CONSTRAINT[ (extended: …)]`; that exact
 * shape is the only place a token is read out of a driver message, and only these tokens
 * are accepted. */
export const D1_TRIGGER_CODES = [
  "calendar_revision_conflict",
  "calendar_version_conflict",
  "decision_result_immutable",
  "forecast_grant_immutable",
  "grant_revision_conflict",
  "runtime_activation_stale",
  "runtime_activation_unapproved",
  "runtime_approval_immutable",
  "runtime_approval_ineligible",
  "runtime_approval_invalid",
  "runtime_approved_candidate_immutable",
  "runtime_approved_source_immutable",
  "runtime_candidate_sealed",
  "runtime_command_immutable",
  "runtime_command_not_changed",
  "runtime_history_immutable",
  "runtime_ingestion_evidence_immutable",
  "runtime_ingestion_lease_expired",
  "runtime_ingestion_source_conflict",
  "runtime_notice_budget_immutable",
  "runtime_outbox_immutable",
  "runtime_pointer_direct_write",
  "runtime_pointer_invalid",
  "runtime_pointer_not_changed",
  "runtime_review_hash",
  "runtime_review_immutable",
  "runtime_review_stale",
  "runtime_rollback_unapproved",
  "runtime_version_immutable",
  "runtime_version_invalid",
  "source_evidence_immutable",
  "source_poll_recovery_evidence_immutable",
  "source_processor_evidence_immutable",
] as const;

export type D1TriggerCode = (typeof D1_TRIGGER_CODES)[number];

/** Manually reviewed codes, grouped by the module that raises them. */
const REGISTERED_ERROR_CODES = [
  ...D1_TRIGGER_CODES,

  // Sanitizer fallbacks (one per policy; see ERROR_CODE_POLICIES).
  "usage_guard_unknown_error",
  "observer_internal_error",
  "publication_operation_failed",
  "v2_delivery_failed",
  "alert_delivery_failed",
  "record_failed",
  "runtime_telemetry_invalid",

  // shared/usageGuard.ts
  "telemetry_budget_disabled",

  // shared/boundedHttp.ts callers (readBoundedJson also derives `<code>_encoding`/`<code>_json`).
  "discord_response_too_large",
  "discord_interaction_body_too_large",
  "v2_reconcile_too_large",
  "publication_discord_response_too_large",
  "jwks_too_large",
  "jwks_too_large_encoding",
  "jwks_too_large_json",
  "cloudflare_api_response_too_large",
  "cloudflare_api_response_too_large_encoding",
  "cloudflare_api_response_too_large_json",

  // cloudflare/src (HttpError codes; also the public response body).
  "origin_not_allowed",
  "database_not_configured",
  "database_schema_not_ready",
  "database_schema_mismatch",
  "not_found",
  "admin_forbidden",
  "diagnostic_query_incomplete",
  "diagnostic_locale_missing",
  "rejection_storage_unavailable",
  "storage_unavailable",
  "invalid_payload",
  "invalid_json",
  "json_required",
  "payload_too_large",
  "rate_limited",
  "unexpected_query",
  "unsupported_recovery_version",
  "unsupported_recovery_policy",
  "unsupported_solver_version",
  "invalid_state_level",
  "invalid_state_exp",
  "invalid_state_exp_step",
  "invalid_level_15_exp",
  "invalid_supply_forecast_profile",
  "invalid_supply_forecast",
  "invalid_recovery_v2_identity",
  "unexpected_stock_change",
  "invalid_stock_delta",
  "attempts_cross_level_boundary",
  "invalid_success_attempt",
  "stock_delta_does_not_match_success_attempt",
  "invalid_success_result_state",
  "unexpected_success_attempt",
  "stock_delta_does_not_match_recommended_uses",
  "invalid_fail_result_state",
  "turnstile_not_configured",
  "turnstile_hostnames_not_configured",
  "turnstile_token_required",
  "turnstile_unavailable",
  "turnstile_action_mismatch",
  "turnstile_hostname_mismatch",
  "turnstile_failed",

  // forecast-admin/src (AccessError, CalendarDataError).
  "invalid_token",
  "jwks_unavailable",
  "day_payload_json",
  "day_payload_shape",
  "day_payload_kits",
  "day_payload_items",
  "provenance_json",
  "provenance_shape",
  "provenance_days",
  "provenance_instant",
  "revision_shape",
  "too_many_rows",
  "snapshot_shape",
  "day_shape",
  "revision_missing",
  "revision_conflict",

  // site-worker/src/forecast.ts
  "forecast_pointer_missing",
  "forecast_pointer_mismatch",
  "forecast_artifact_missing",
  "forecast_invalid_off",
  "forecast_hash_mismatch",
  "forecast_expired",

  // usage-guard/src/worker.ts
  "usage_guard_evidence_missing",
  "usage_guard_snapshot_hash_mismatch",

  // stats-observer/src
  "observer_source_overflow",
  "observer_invalid_count",
  "discord_alert_channel_invalid",
  "discord_bot_token_missing",
  "discord_message_id_missing",
  "discord_response_invalid",
  "discord_timeout",
  "discord_network",
  "discord_http",

  // forecast-dispatcher/src
  "unsupported_cadence",
  "awaiting_evidence_panel",
  /** An older candidate replaced by a newer one that already asks for the same sequence. */
  "publication_review_superseded",
  "publication_admission_lease_lost",
  "publication_delivery_lease_lost",
  "publication_result_missing",
  "empty_ops_value",
  "discord_create_message_http",
  "discord_response_invalid_json",
  "discord_response_message_id_missing",
  "discord_approval_channel_id_invalid",
  "discord_activity_channel_id_invalid",
  "discord_alert_channel_id_invalid",
  "v2_payload_hash",
  "v2_decision_missing",
  "v2_delivery_exhausted",
  "v2_lease_lost",
  "v2_reconcile_invalid",
  "v2_reconcile_http",

  // forecast-interactions/src
  "invalid_time",
  "invalid_field",
  "invalid_action",
  "invalid_range",
  "invalid_request",
  "invalid_type",
  "unauthorized",
  "environment",
  "source_changed",
  "publication_review_missing",
  "publication_message_id",
  "publication_discord_response_failed",

  // shared/forecast-publication/store.ts
  "publication_environment_mismatch",
  "publication_candidate_missing",
  "publication_candidate_hash",
  "publication_candidate_unsealed",
  "publication_review_binding",
  "publication_command_conflict",
  "publication_command_missing",
  "publication_review_expired",
  "publication_review_stale",
  "publication_key_id",
  "publication_sequence_exhausted",
  "publication_affected_rows",
  "publication_rollback_key",
  "publication_unsupported_cadence",
  "publication_evidence_uncovered",

  // shared/forecastPublication.ts, shared/forecastPublicationBytes.ts
  "publication_not_json",
  "publication_unsupported_rules",
  "publication_forecast_id",
  "publication_conflicting_sources",
  "publication_unknown_fields",
  "publication_invalid_minimum_sequence",
  "publication_invalid_off",
  "publication_invalid_mode",
  "publication_invalid_pointer",
  "publication_invalid_object",
  "publication_invalid_fields",
  "publication_invalid_signature",
  "publication_invalid_base64",
  "publication_artifact_mismatch",

  // shared/forecastV2Notifications.ts
  "v2_custom_id_invalid",
  "v2_payload_invalid",
  "v2_idempotency_key_invalid",

  // shared/cloudflareD1Catalog.ts
  "cloudflare_d1_list_schema_invalid",
  "cloudflare_d1_list_item_invalid",
  "cloudflare_d1_list_pagination_invalid",
  "cloudflare_d1_list_pagination_inconsistent",
  "cloudflare_d1_list_pagination_incomplete",
  "cloudflare_d1_list_page_limit_reached",
  "cloudflare_d1_list_duplicate_database",
  "cloudflare_d1_list_total_mismatch",
  "cloudflare_d1_list_http",

  // shared/cloudflarePaidUsage.ts, shared/cloudflareWorkerRuntimeWindow.ts
  "cloudflare_d1_database_missing",
  "cloudflare_account_id_invalid",
  "cloudflare_analytics_token_missing",
  "cloudflare_billing_token_missing",
  "cloudflare_paid_governing_metric_missing",
  "cloudflare_paid_counter_regression",
  "cloudflare_paid_snapshot_version_invalid",
  "cloudflare_paid_snapshot_account_invalid",
  "cloudflare_paid_snapshot_plan_invalid",
  "cloudflare_paid_snapshot_database_count_invalid",
  "cloudflare_paid_snapshot_metric_invalid",
  "cloudflare_paid_snapshot_order_invalid",
  "cloudflare_paid_worker_runtime_window_invalid",
  "cloudflare_paid_account_mismatch",
  "cloudflare_paid_billing_period_changed",
  "cloudflare_subscription_http",
  "cloudflare_subscription_schema_invalid",
  "cloudflare_workers_paid_subscription_count",
  "cloudflare_workers_paid_subscription_missing",
  "cloudflare_workers_paid_rate_plan_missing",
  "cloudflare_workers_paid_period_invalid",
  "cloudflare_paid_graphql",
  "cloudflare_paid_graphql_http",
  "cloudflare_paid_graphql_error",
  "cloudflare_paid_graphql_account_count_invalid",
  "cloudflare_paid_graphql_account_missing",
  "cloudflare_paid_time_invalid",
  "cloudflare_paid_sum_field_invalid",
  "cloudflare_paid_metric_out_of_range",
  "cloudflare_string_invalid",
  "cloudflare_timestamp_invalid",
  "cloudflare_metric_invalid",
  "cloudflare_paid_runtime_window_pair_required",
  "cloudflare_paid_runtime_window_invalid",

  // shared/d1QuotaEvidence.ts
  "cloudflare_paid_quota_database_missing",
  "cloudflare_paid_quota_duplicate",
  "cloudflare_paid_quota_period_invalid",
  "cloudflare_paid_quota_worker_runtime_invalid",
  "cloudflare_paid_quota_worker_metrics_invalid",
  "cloudflare_paid_quota_metrics_mismatch",
  "cloudflare_paid_quota_governing_metric_missing",
  "cloudflare_paid_quota_utilization_mismatch",
  "cloudflare_paid_quota_action_mismatch",
  "cloudflare_paid_quota_passed_mismatch",
  "cloudflare_paid_quota_d1_reads_mismatch",
  "cloudflare_paid_quota_d1_storage_mismatch",
  "cloudflare_paid_quota_d1_writes_mismatch",
  "cloudflare_paid_quota_worker_cpu_mismatch",
  "cloudflare_paid_quota_worker_requests_mismatch",
  "cloudflare_paid_burn_in_too_short",
  "cloudflare_paid_recent_window_too_long",
  "cloudflare_paid_runtime_window_too_long",
  "cloudflare_paid_runtime_window_too_short",

  // shared/forecastCanaryRuntime.ts, shared/forecastCanaryRuntimeEvidence.ts
  "runtime_telemetry_not_object",
  "runtime_telemetry_version_invalid",
  "runtime_canary_id_invalid",
  "runtime_deployment_sha_invalid",
  "runtime_collector_script_version_invalid",
  "runtime_dispatcher_script_version_invalid",
  "runtime_collector_version_id_invalid",
  "runtime_dispatcher_version_id_invalid",
  "runtime_started_at_invalid",
  "runtime_ended_at_invalid",
  "runtime_observed_at_invalid",
  "runtime_window_invalid",
  "runtime_workers_invalid",
  "runtime_workers_duplicate",
  "runtime_collection_errors_invalid",
  "runtime_collection_error_invalid",
  "runtime_worker_invalid",
  "runtime_component_invalid",
  "runtime_limit_invalid",
  "runtime_sampling_rate_invalid",
  "runtime_samples_invalid",
  "runtime_script_name_invalid",
  "runtime_sample_invalid",
  "runtime_event_type_invalid",
  "runtime_request_hash_invalid",
  "runtime_script_tag_invalid",
  "runtime_script_version_id_invalid",
  "runtime_identity_source_invalid",
  "runtime_slot_invalid",
  "runtime_mode_invalid",
  "runtime_admission_invalid",
  "runtime_summary_partial",
  "runtime_cpu_invalid",
  "runtime_outcome_invalid",
  "runtime_baseline_not_object",
  "runtime_baseline_id_invalid",
  "runtime_baseline_worker_invalid",
  "runtime_baseline_distribution_invalid",
  "runtime_baseline_average_invalid",
  "runtime_baseline_p95_invalid",

  // shared/soloRaidCadence.ts
  "solo_raid_history_round_gap",
  "solo_raid_prediction_time_invalid",
  "solo_raid_prediction_anchor_invalid",
  "solo_raid_cadence_invalid",
  "solo_raid_estimate_count_invalid",
  "solo_raid_delay_invalid",
  "solo_raid_history_too_short",
  "solo_raid_history_not_strictly_increasing",
  "solo_raid_interval_invalid",
  "solo_raid_game_date_invalid",

  // shared/supplyForecastCandidate.ts, shared/supplyForecastProjection.ts
  "unsupported_forecast_version",
  "forecast_candidate_schema_invalid",
  "v3_forecast_requires_certified_snapshot",
  "certified_snapshot_required",
  "forecast_profiles_do_not_match_ledger",

  // shared/certifiedVersionPolicy.ts, shared/certifiedSupplyBuild.ts
  "certified_snapshot_version_or_provenance_invalid",
  "certified_coverage_horizon_invalid",
  "certified_supply_provenance_invalid",
  "certified_solo_period_inverted",
  "certified_solo_round_duplicate",
  "certified_solo_segments_required",
  "certified_median_anchor_period_required",
  "certified_supply_rules_overlap",
  "certified_collaboration_period_inverted",
  "certified_solo_segment_reward_rule_missing",
  "certified_grant_rule_missing",

  // shared/certifiedSupplyCandidateLedger.ts
  "forecast_segment_ledger_mismatch",
  "forecast_segment_ledger_missing",
  "forecast_grant_duplicate",
  "forecast_grant_ledger_missing",
  "forecast_grant_ledger_mismatch",

  // shared/certifiedSupplyCoherence.ts, shared/certifiedSupplyLaws.ts, shared/certifiedSupplyModel.ts
  "certified_grant_invalid",
  "certified_solo_segments_invalid",
  "certified_solo_segments_round_invalid",
  "certified_solo_event_segment_invalid",
  "certified_solo_event_segment_missing",
  "certified_dispatch_mass_not_one",
  "certified_dispatch_cohort_invalid",
  "certified_dispatch_not_terminated",
  "certified_supply_support_limit",
  "certified_law_unknown",
  "certified_law_negative_mass",
  "certified_law_mass_not_one",
  "certified_law_raw_pieces_invalid",
  "certified_law_count_invalid",
  "certified_timestamp_offset_required",
  "certified_timestamp_invalid",
  "certified_game_date_invalid",
  "certified_solo_round_invalid",
  "certified_solo_announcement_unlinked",
  "certified_solo_delay_invalid",
  "certified_json_graph_invalid",

  // shared/certifiedSupplyValidation.ts (`certified_snapshot_<reason>` via snapshotError).
  "certified_v3_weekly_event_invalid",
  "certified_v3_builtin_laws_required",
  "certified_v3_weekly_rule_invalid",
  "certified_v3_law_reference_invalid",
  "certified_v3_weekly_event_missing",
  "certified_snapshot_unknown_field",
  "certified_snapshot_sparse_array_invalid",
  "certified_snapshot_object_required",
  "certified_snapshot_future_law_semantics_unsupported",
  "certified_snapshot_metadata_invalid",
  "certified_snapshot_structure_invalid",
  "certified_snapshot_provenance_list_invalid",
  "certified_snapshot_collections_invalid",
  "certified_snapshot_query_window_invalid",
  "certified_snapshot_complete_outside_authority",
  "certified_snapshot_coverage_invalid",
  "certified_snapshot_cadence_invalid",
  "certified_snapshot_cadence_provenance_invalid",
  "certified_snapshot_cadence_period_invalid",
  "certified_snapshot_cadence_median_invalid",
  "certified_snapshot_cadence_summary_invalid",
  "certified_snapshot_cadence_source_status_invalid",
  "certified_snapshot_delay_state_invalid",
  "certified_snapshot_delay_anchor_invalid",
  "certified_snapshot_law_reference_invalid",
  "certified_snapshot_law_references_invalid",
  "certified_snapshot_law_pieces_invalid",
  "certified_snapshot_law_probability_invalid",
  "certified_snapshot_finite_law_invalid",
  "certified_snapshot_law_mass_not_one",
  "certified_snapshot_cohort_law_invalid",
  "certified_snapshot_law_invalid",
  "certified_snapshot_builtin_law_version_invalid",
  "certified_snapshot_rule_invalid",
  "certified_snapshot_rule_period_invalid",
  "certified_snapshot_rules_overlap",
  "certified_snapshot_solo_round_invalid",
  "certified_snapshot_solo_duration_invalid",
  "certified_snapshot_unverified_duration_fabricated",
  "certified_snapshot_event_identity_invalid",
  "certified_snapshot_recurring_identity_invalid",
  "certified_snapshot_solo_identity_invalid",
  "certified_snapshot_solo_number_invalid",
  "certified_snapshot_event_date_invalid",
  "certified_snapshot_event_effective_rule_invalid",
  "certified_snapshot_event_cancelled_invalid",
  "certified_snapshot_event_sources_invalid",
  "certified_snapshot_event_expiry_invalid",
  "certified_snapshot_authority_identity_duplicate",

  // forecast-collector/src (ingest reason codes are dynamic families; these are the
  // literal codes its Worker entry raises, persisted or rendered by the admin API).
  "calendar_days_empty",
  "calendar_coop_invalid",
  "rules_environment_not_configured",
  "post_version_metadata_missing",
  "maintenance_dependency_period_invalid",
  "maintenance_collision_environment_required",
  "grant_decision_option_invalid",
  "grant_decision_observation_missing",
  "grant_decision_date_missing",
  "grant_correction_target_ambiguous",
  "schedule_decision_option_invalid",
  "schedule_decision_option_unsupported",
  "decision_schedule_missing",
  "oversize",
  "oversize_encoding",
  "oversize_json",
  "solo_segment_conflict",
  "solo_initial_segment_missing",
  "confirmed_solo_cadence_out_of_range",
  "forecast_snapshot_version",
  "forecast_primary_period_missing",
  "candidate_source_content_hash_conflict",
  "legacy_queue_disabled",
  "board11_schema_required",
  "candidate_revision_conflict",
  "candidate_game_day_mismatch",
  "candidate_source_url_allowlist",
  "candidate_payload_hash",
  "candidate_schedule_event_missing",
  "source_queue_processed_payload",
  "source_queue_event_mismatch",
  "source_queue_item_mismatch",
  "source_queue_url_allowlist",
  "source_queue_content_hash",
  "manual_review_source_url_invalid",
  "canary_final_evidence_body",
  "canary_final_evidence_body_encoding",
  "canary_final_evidence_body_json",
  "canary_final_evidence_body_invalid",
  "canary_final_evidence_contract_invalid",
  "canary_id_invalid",
  "canary_quota_evidence_period_or_action_mismatch",
  "canary_start_body",
  "canary_start_body_encoding",
  "canary_start_body_json",
  "canary_start_body_invalid",
  "canary_start_contract_invalid",
  "canary_run_conflict",
  "canary_run_overlap",
  "canary_run_missing_after_insert",
  "canary_deployment_sha_invalid",
  "canary_cron_contract_invalid",
  "canary_collector_version_id_invalid",
  "canary_dispatcher_version_id_invalid",
  "d1_quota_evidence_hash_mismatch",
  "cloudflare_paid_runtime_guard_required",
  "cloudflare_paid_final_evidence_required",
  "cloudflare_paid_guard_action_mismatch",
  "cloudflare_paid_runtime_window_mismatch",
  "canary_crosses_cloudflare_billing_period",
  "cloudflare_paid_canary_start_runtime_invalid",
  "cloudflare_paid_quota_evidence_stale",
  "cloudflare_paid_quota_not_normal",

  // forecast-collector/src/admin-routes-canary.ts (`cloudflare_paid_guard_${action}` for
  // a non-normal guard action; the closed set is QUOTA_ACTIONS minus "normal").
  "cloudflare_paid_guard_warning",
  "cloudflare_paid_guard_disable_staging",
  "cloudflare_paid_guard_disable_forecast_production",
  "cloudflare_paid_guard_disable_statistics_writes",
  "cloudflare_paid_guard_hard_stop",

  // forecast-collector/src/ops.ts (options alert codes that are not a thrown message).
  "forecast_ops_unknown_error",
  "forecast_ops_unknown_code",
] as const;

type RegisteredErrorCode = (typeof REGISTERED_ERROR_CODES)[number];

/** Every registered code, for registry audits (the sanitizer uses the set below). */
export const APP_ERROR_CODES: readonly RegisteredErrorCode[] = REGISTERED_ERROR_CODES;

/** HTTP statuses our transports report as `<family><status>`; any other status collapses
 * to the family's fixed code (never the number read from the response). */
export const HTTP_STATUSES = [
  400, 401, 403, 404, 405, 408, 409, 410, 413, 415, 422, 429, 500, 501, 502, 503, 504,
] as const;

/** `<prefix><status>` message families and the fixed code for a non-enumerated status. */
export const HTTP_STATUS_FAMILIES = {
  cloudflare_d1_list_http_: "cloudflare_d1_list_http",
  cloudflare_paid_graphql_http_: "cloudflare_paid_graphql_http",
  cloudflare_subscription_http_: "cloudflare_subscription_http",
  discord_: "discord_http",
  discord_create_message_: "discord_create_message_http",
  v2_reconcile_: "v2_reconcile_http",
} as const satisfies Record<string, RegisteredErrorCode>;

type HttpStatusErrorCode = `${keyof typeof HTTP_STATUS_FAMILIES}${(typeof HTTP_STATUSES)[number]}`;

export type AppErrorCode = RegisteredErrorCode | HttpStatusErrorCode;

/** Messages that carry data after a fixed family prefix (an id, a field, a count, a
 * component). Only the family code is ever emitted; the suffix is discarded. */
export const SUFFIX_FAMILIES = [
  ["cloudflare_d1_database_missing:", "cloudflare_d1_database_missing"],
  ["cloudflare_paid_counter_regression:", "cloudflare_paid_counter_regression"],
  ["cloudflare_workers_paid_subscription_count:", "cloudflare_workers_paid_subscription_count"],
  ["cloudflare_paid_quota_required_database_missing:", "cloudflare_paid_quota_database_missing"],
  ["cloudflare_paid_quota_duplicate_", "cloudflare_paid_quota_duplicate"],
  ["cloudflare_paid_graphql_", "cloudflare_paid_graphql"],
  ["runtime_baseline_worker_invalid:", "runtime_baseline_worker_invalid"],
  ["runtime_baseline_distribution_invalid:", "runtime_baseline_distribution_invalid"],
  ["runtime_baseline_average_invalid:", "runtime_baseline_average_invalid"],
  ["runtime_baseline_p95_invalid:", "runtime_baseline_p95_invalid"],
  ["certified_law_unknown:", "certified_law_unknown"],
  ["certified_snapshot_unknown_field:", "certified_snapshot_unknown_field"],
] as const satisfies ReadonlyArray<readonly [string, RegisteredErrorCode]>;

/** Runtime error names that are a fixed vocabulary rather than text. A plain `Error`
 * with an unregistered message is not ours and takes the policy fallback instead. */
export const SAFE_ERROR_NAMES = [
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "NotSupportedError",
  "OperationError",
  "DataError",
  "DOMException",
] as const;

/** Fixed categories for values that are not ours: the D1 driver prefix (table and column
 * text after it is dropped) and the generic unknown. */
export const ERROR_CATEGORIES = ["D1_ERROR", "unexpected"] as const;

type SafeErrorName = (typeof SAFE_ERROR_NAMES)[number];
type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export type SafeErrorCode = AppErrorCode | SafeErrorName | ErrorCategory;

/** What a D1 column may hold: a registered code or a fixed category (`unexpected` only
 * for a policy the registry does not know, which the policy type rules out). A runtime
 * error name is log vocabulary and never a persisted value. */
export type PersistedErrorCode = AppErrorCode | ErrorCategory;

/** Per-caller fallback for a value the registry does not know. Closed identifiers, so a
 * caller can never smuggle text in through the fallback. */
export const ERROR_CODE_POLICIES = {
  /** Log lines of request/scheduled handlers. */
  default: "unexpected",
  /** usage_guard_runs.error_code, alert status, and Usage Guard logs. */
  usage_guard: "usage_guard_unknown_error",
  /** observer_runs.error_code, observer_alerts.last_send_error, and Observer logs. */
  stats_observer: "observer_internal_error",
  /** forecast_runtime_* error_code columns and publication review logs/messages. */
  publication: "publication_operation_failed",
  /** forecast_v2_notification_outbox.error_code. */
  v2_delivery: "v2_delivery_failed",
  /** forecast_ops_alerts.last_send_error. */
  ops_alert_delivery: "alert_delivery_failed",
  /** A failed bookkeeping write reported next to an ops alert key. */
  ops_record: "record_failed",
  /** forecast_ops_alerts.error_code and collector admin error responses. A value the
   * registry does not know is reported as this fixed code, never as its message. */
  forecast_ops: "forecast_ops_unknown_error",
  /** Canary runtime evidence errors. */
  canary_runtime: "runtime_telemetry_invalid",
} as const satisfies Record<string, RegisteredErrorCode | "unexpected">;

export type ErrorCodePolicy = keyof typeof ERROR_CODE_POLICIES;
/** Policies whose fallback is a registered code: the only ones a D1 column may use. */
export type PersistedErrorCodePolicy = Exclude<ErrorCodePolicy, "default">;

const D1_ERROR_PREFIX = "D1_ERROR:";
/** A trigger abort as the driver reports it, with or without the extended result code the
 * local runtime appends (`D1_ERROR: <code>: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)`). */
const D1_TRIGGER_MESSAGE =
  /^D1_ERROR: ([a-z0-9_]{1,80}): SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_[A-Z]+\))?$/;
const HTTP_STATUS_MESSAGES = Object.entries(HTTP_STATUS_FAMILIES).map(
  ([prefix, family]) =>
    [new RegExp(`^${prefix}(\\d{3})$`), prefix, family] as const satisfies readonly [
      RegExp,
      string,
      RegisteredErrorCode,
    ],
);

const APP_ERROR_CODE_SET: ReadonlySet<string> = new Set<string>([
  ...REGISTERED_ERROR_CODES,
  ...Object.keys(HTTP_STATUS_FAMILIES).flatMap((prefix) =>
    HTTP_STATUSES.map((status) => `${prefix}${status}`),
  ),
]);
const D1_TRIGGER_CODE_SET: ReadonlySet<string> = new Set<string>(D1_TRIGGER_CODES);
const SAFE_ERROR_NAME_SET: ReadonlySet<string> = new Set<string>(SAFE_ERROR_NAMES);

export function isAppErrorCode(value: unknown): value is AppErrorCode {
  return typeof value === "string" && APP_ERROR_CODE_SET.has(value);
}

function isSafeErrorName(value: string): value is SafeErrorName {
  return SAFE_ERROR_NAME_SET.has(value);
}

function policyFallback(policy: ErrorCodePolicy) {
  return Object.hasOwn(ERROR_CODE_POLICIES, policy)
    ? ERROR_CODE_POLICIES[policy]
    : ERROR_CODE_POLICIES.default;
}

function familyCode(message: string): AppErrorCode | null {
  for (const [pattern, prefix, family] of HTTP_STATUS_MESSAGES) {
    const status = pattern.exec(message)?.[1];
    if (status === undefined) continue;
    const enumerated = `${prefix}${status}`;
    return isAppErrorCode(enumerated) ? enumerated : family;
  }
  for (const [prefix, family] of SUFFIX_FAMILIES) {
    if (message.startsWith(prefix)) return family;
  }
  return null;
}

function d1Code(message: string): SafeErrorCode {
  const raised = D1_TRIGGER_MESSAGE.exec(message)?.[1];
  return raised !== undefined && D1_TRIGGER_CODE_SET.has(raised)
    ? (raised as AppErrorCode)
    : "D1_ERROR";
}

/**
 * Maps a thrown value to a code that is safe to log, persist, and render.
 *
 * Order: a registered `code` property or message is kept verbatim; a message in an
 * enumerated status or suffix family drops to its family code; a driver message keeps
 * only the `D1_ERROR` token (or the registered trigger code it raised); a fixed runtime
 * error name is kept; everything else is the policy's fixed fallback. The output never
 * contains text copied from an unregistered message.
 */
export function errorCode(error: unknown, policy: ErrorCodePolicy = "default"): SafeErrorCode {
  const fallback = policyFallback(policy);
  if (!(error instanceof Error)) return fallback;
  const code = Reflect.get(error, "code");
  if (isAppErrorCode(code)) return code;
  const message = error.message;
  if (isAppErrorCode(message)) return message;
  const family = familyCode(message);
  if (family !== null) return family;
  if (message.startsWith(D1_ERROR_PREFIX)) return d1Code(message);
  if (isSafeErrorName(error.name)) return error.name;
  return fallback;
}

/**
 * `errorCode` for a value written to a D1 column (and later rendered in an ops alert or
 * to an approver). A runtime error name (`TypeError`, `SyntaxError`, …) is log vocabulary;
 * a persisted failure keeps the policy's registered fallback so the column stays in the
 * closed set the ops tooling and migrations know.
 */
export function persistedErrorCode(
  error: unknown,
  policy: PersistedErrorCodePolicy,
): PersistedErrorCode {
  const code = errorCode(error, policy);
  return isSafeErrorName(code) ? policyFallback(policy) : code;
}

/**
 * Whether a thrown value is the D1 trigger abort `code`, for a branch decision only. The
 * driver's message layout is not ours to depend on, so the registered token is compared as
 * a whole word anywhere in the message: a prefix, an extended result code or an extra
 * suffix still routes to the same branch. Nothing is read out of the message; what gets
 * logged or persisted remains `errorCode`'s output.
 */
export function isD1TriggerAbort(error: unknown, code: D1TriggerCode): boolean {
  if (!(error instanceof Error)) return false;
  return new RegExp(`(?:^|[^A-Za-z0-9_])${code}(?:$|[^A-Za-z0-9_])`).test(error.message);
}
