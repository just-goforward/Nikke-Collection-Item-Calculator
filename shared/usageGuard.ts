import {
  assertD1QuotaEvidence,
  type CloudflareQuotaAction,
  type D1QuotaEvidence,
} from "./d1QuotaEvidence";

export type UsageGuardOperation =
  | "staging_automation"
  | "production_forecast_automation"
  | "statistics_write"
  | "statistics_read"
  | "admin_read"
  | "admin_write";

export type UsageGuardState = {
  action: CloudflareQuotaAction;
  observedAt: string;
  periodStart: string;
  periodEnd: string;
  evidenceHash: string;
};

export type UsageGuardEvidence = UsageGuardState & {
  evidence: D1QuotaEvidence;
};

type UsageGuardDatabase = {
  prepare(query: string): {
    first<T>(): Promise<T | null>;
  };
};

export class UsageGuardError extends Error {
  readonly code = "telemetry_budget_disabled";
  readonly retryable = false;

  constructor(readonly action: CloudflareQuotaAction) {
    super("telemetry_budget_disabled");
  }
}

export async function readUsageGuardState(db: UsageGuardDatabase): Promise<UsageGuardState> {
  const row = await db
    .prepare(
      `SELECT action, observed_at, period_start, period_end, evidence_hash
       FROM usage_guard_state WHERE singleton_id = 1`,
    )
    .first<Record<string, unknown>>();
  if (!row) throw new UsageGuardError("hard_stop");
  const action = String(row["action"] ?? "") as CloudflareQuotaAction;
  if (!isQuotaAction(action)) throw new UsageGuardError("hard_stop");
  const observedAt = requiredTimestamp(row["observed_at"]);
  const periodStart = requiredTimestamp(row["period_start"]);
  const periodEnd = requiredTimestamp(row["period_end"]);
  const evidenceHash = String(row["evidence_hash"] ?? "");
  if (!/^[0-9a-f]{64}$/.test(evidenceHash)) throw new UsageGuardError("hard_stop");
  return { action, observedAt, periodStart, periodEnd, evidenceHash };
}

export async function readUsageGuardEvidence(db: UsageGuardDatabase): Promise<UsageGuardEvidence> {
  const row = await db
    .prepare(
      `SELECT action, observed_at, period_start, period_end, evidence_hash, evidence_json
       FROM usage_guard_state WHERE singleton_id = 1`,
    )
    .first<Record<string, unknown>>();
  if (!row) throw new UsageGuardError("hard_stop");
  const action = String(row["action"] ?? "") as CloudflareQuotaAction;
  if (!isQuotaAction(action)) throw new UsageGuardError("hard_stop");
  const observedAt = requiredTimestamp(row["observed_at"]);
  const periodStart = requiredTimestamp(row["period_start"]);
  const periodEnd = requiredTimestamp(row["period_end"]);
  const evidenceHash = String(row["evidence_hash"] ?? "");
  const evidenceJson = String(row["evidence_json"] ?? "");
  if (!/^[0-9a-f]{64}$/.test(evidenceHash) || !evidenceJson) {
    throw new UsageGuardError("hard_stop");
  }
  const actualHash = await sha256Hex(evidenceJson);
  if (actualHash !== evidenceHash) throw new UsageGuardError("hard_stop");
  const evidence = assertD1QuotaEvidence(JSON.parse(evidenceJson));
  if (
    evidence.observedAt !== observedAt ||
    evidence.plan.periodStart !== periodStart ||
    evidence.plan.periodEnd !== periodEnd
  ) {
    throw new UsageGuardError("hard_stop");
  }
  return { action, observedAt, periodStart, periodEnd, evidenceHash, evidence };
}

export async function assertUsageAllowed(
  db: UsageGuardDatabase,
  operation: UsageGuardOperation,
  nowMs = Date.now(),
) {
  const state = await readUsageGuardState(db);
  const effectiveAction = effectiveUsageGuardAction(state, nowMs);
  if (!operationAllowed(effectiveAction, operation)) throw new UsageGuardError(effectiveAction);
  return { ...state, action: effectiveAction };
}

export function effectiveUsageGuardAction(
  state: UsageGuardState,
  nowMs: number,
): CloudflareQuotaAction {
  const observedAt = Date.parse(state.observedAt);
  const periodStart = Date.parse(state.periodStart);
  const periodEnd = Date.parse(state.periodEnd);
  const timeContractInvalid =
    !Number.isFinite(nowMs) ||
    !Number.isFinite(observedAt) ||
    !Number.isFinite(periodStart) ||
    !Number.isFinite(periodEnd) ||
    periodStart >= periodEnd ||
    nowMs < periodStart ||
    nowMs >= periodEnd ||
    observedAt > nowMs + 60_000;
  if (timeContractInvalid) return "hard_stop";
  const ageMinutes = (nowMs - observedAt) / 60_000;
  if (ageMinutes >= 120) return "hard_stop";
  if (ageMinutes >= 45 && actionRank(state.action) < actionRank("disable_forecast_production")) {
    return "disable_forecast_production";
  }
  return state.action;
}

export function operationAllowed(action: CloudflareQuotaAction, operation: UsageGuardOperation) {
  if (action === "hard_stop") return false;
  if (action === "disable_statistics_writes") {
    return operation === "statistics_read" || operation === "admin_read";
  }
  if (action === "disable_forecast_production") {
    return (
      operation === "statistics_write" ||
      operation === "statistics_read" ||
      operation === "admin_read"
    );
  }
  if (action === "disable_staging") return operation !== "staging_automation";
  return true;
}

function actionRank(action: CloudflareQuotaAction) {
  return [
    "normal",
    "warning",
    "disable_staging",
    "disable_forecast_production",
    "disable_statistics_writes",
    "hard_stop",
  ].indexOf(action);
}

function isQuotaAction(value: string): value is CloudflareQuotaAction {
  return [
    "normal",
    "warning",
    "disable_staging",
    "disable_forecast_production",
    "disable_statistics_writes",
    "hard_stop",
  ].includes(value);
}

function requiredTimestamp(value: unknown) {
  const timestamp = String(value ?? "");
  if (!Number.isFinite(Date.parse(timestamp))) throw new UsageGuardError("hard_stop");
  return timestamp;
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
