/** Binding capabilities, not authentication headers. Only the operator gateway
 * receives StatsRawReader; Site and Observer must never receive that binding.
 */
export type FailureAggregateRow = {
  recovery_version: number;
  policy_version: string;
  app_revision: string;
  ingest_revision: string;
  forecast_id: string;
  forecast_profile_id: string;
  rust_min_ef_solver_version: string;
  rust_phase2_solver_version: string;
  js_phase2_solver_version: string;
  requested_backend: string;
  min_ef_exit: string;
  phase2_exit: string;
  js_exit: string;
  terminal_backend: string;
  grade: string;
  level: number;
  exp_bucket: number;
  stock_bucket_blue: string;
  stock_bucket_purple: string;
  stock_bucket_yellow: string;
  browser: string;
  browser_major: string;
  os: string;
  os_major: string;
  device_type: string;
  events: number;
  first_seen: number;
  last_seen: number;
};

export type RejectionAggregateRow = {
  rejection_code: string;
  event_kind: string;
  recovery_version: string;
  policy_version: string;
  app_revision: string;
  events: number;
  first_seen: number;
  last_seen: number;
};

export type DeliveryAggregateRow = {
  outcome: string;
  event_kind: string;
  attempts_bucket: string;
  age_bucket: string;
  last_failure_class: string;
  app_revision: string;
  events: number;
  first_seen: number;
  last_seen: number;
};

export type DiagnosticObservations = {
  failures: FailureAggregateRow[];
  rejections: RejectionAggregateRow[];
  delivery: DeliveryAggregateRow[];
};

// Proposed technical ceilings only; backend AND gateway require explicit runtime
// budgets. These constants are not CPU-fit measurements or deployed allowances.
export const RAW_READER_MAX_ROWS = 100;
export const RAW_READER_MAX_BYTES = 65_536;
export const RAW_READER_MAX_SUPPLY_DAYS = 31;

export type RawCalculationRequest = {
  /** Administrative alias for the permanent cryptorandom reportId, not a user ID. */
  calculationId: string;
  maxBytes?: number;
};
export type RawCalculationQuery = {
  /** Inclusive/exclusive public supply game dates; never report/receipt dates. */
  fromGameDate: string;
  untilGameDate: string;
  publicationContentHash?: string;
  slotId?: string;
  afterCalculationId?: string;
  maxRows?: number;
  maxBytes?: number;
};
export type RawCalculationRead = { calculation: Record<string, unknown> | null };
export type RawCalculationPage = { calculations: Record<string, unknown>[]; nextCursor: string | null };

export interface StatsRawReader {
  readCalculation(input: RawCalculationRequest): Promise<RawCalculationRead>;
  queryCalculations(input: RawCalculationQuery): Promise<RawCalculationPage>;
}
export interface StatsDiagnostics {
  readObservations(input: { cutoff: number }): Promise<DiagnosticObservations>;
}
export interface StatsIngest {
  fetch(request: Request): Promise<Response>;
}
export interface StatsPublic {
  fetch(request: Request): Promise<Response>;
}
