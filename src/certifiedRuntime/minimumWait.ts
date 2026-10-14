import { cmp, eq, fromWire, ONE, q, toWire } from "../../shared/certifiedRational";
import type { CertifiedCurrent, CertifiedInput, CertifiedMinimumWait } from "../certified/types";

const MINIMUM_WAIT_VERSION = "certified-minimum-wait-v1" as const;
type PendingStatus = "unknown" | "not_applicable" | "not_requested";

export function minimumWaitBase(
  current: CertifiedCurrent | null,
  status: PendingStatus,
  reason: string | null,
): CertifiedMinimumWait {
  return {
    version: MINIMUM_WAIT_VERSION,
    status,
    kit: current?.kit ?? null,
    uses: current?.uses ?? 0,
    pieces: current?.pieces ?? 0,
    thresholdDays: toWire(ONE),
    horizonDays: 7,
    minimumDays: null,
    earliestPossibleDay: status === "unknown" && current?.kit ? 1 : null,
    latestPossibleDay: null,
    evaluatedDays: [],
    mixedDailyRate: null,
    reason,
    evidence: [],
  };
}

function invalid(): never {
  throw new Error("minimum_wait_binding_mismatch");
}
function day(value: unknown, maximum = 7): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= maximum;
}
function intervalBounds(value: CertifiedMinimumWait): void {
  if (value.earliestPossibleDay !== null && !day(value.earliestPossibleDay, 8)) invalid();
  if (value.latestPossibleDay !== null && !day(value.latestPossibleDay)) invalid();
  if (
    value.latestPossibleDay !== null &&
    (value.earliestPossibleDay === null || value.earliestPossibleDay > value.latestPossibleDay)
  )
    invalid();
}
function certifiedBounds(value: CertifiedMinimumWait): void {
  if (
    !day(value.minimumDays) ||
    value.earliestPossibleDay !== value.minimumDays ||
    value.latestPossibleDay !== value.minimumDays ||
    !value.evaluatedDays.includes(value.minimumDays)
  )
    invalid();
}
function proofBounds(value: CertifiedMinimumWait): void {
  intervalBounds(value);
  if (value.status === "certified") {
    certifiedBounds(value);
    return;
  }
  if (value.minimumDays !== null) invalid();
  if (value.status === "beyond_horizon") {
    if (
      value.earliestPossibleDay !== 8 ||
      value.latestPossibleDay !== null ||
      (value.evaluatedDays.length !== 7 &&
        !value.evidence.includes("batch_settlement_bound_theta_rate_ge_10n"))
    )
      invalid();
  } else if (value.status === "unknown") {
    if (!value.reason || (value.earliestPossibleDay ?? 1) > value.evaluatedDays.length + 1)
      invalid();
  } else if (!["not_applicable", "not_requested"].includes(value.status)) invalid();
}
function settlementProof(value: CertifiedMinimumWait): void {
  if (!value.evidence.includes("batch_settlement_bound_theta_rate_ge_10n")) return;
  const index = ["blue", "purple", "yellow"].indexOf(value.kit ?? "");
  const rate = value.mixedDailyRate?.[index];
  if (!rate || cmp(fromWire(rate), q(value.pieces)) < 0) invalid();
}
function proofFields(value: CertifiedMinimumWait): void {
  if (
    value.version !== MINIMUM_WAIT_VERSION ||
    value.horizonDays !== 7 ||
    !Array.isArray(value.evaluatedDays) ||
    !value.evaluatedDays.every((value, index) => value === index + 1 && day(value)) ||
    !Array.isArray(value.evidence) ||
    !value.evidence.every((entry) => typeof entry === "string") ||
    !(value.reason === null || typeof value.reason === "string")
  )
    invalid();
  if (!eq(fromWire(value.thresholdDays), ONE)) invalid();
  rateFields(value);
  settlementProof(value);
}
function rateFields(value: CertifiedMinimumWait): void {
  if (value.mixedDailyRate !== null) {
    if (!Array.isArray(value.mixedDailyRate) || value.mixedDailyRate.length !== 3) invalid();
    if (value.mixedDailyRate.some((rate) => fromWire(rate).n < 0n)) invalid();
  }
  if (
    (["certified", "beyond_horizon"].includes(value.status) || value.evaluatedDays.length > 0) &&
    value.mixedDailyRate === null
  )
    invalid();
  if (["certified", "beyond_horizon"].includes(value.status) && value.kit === null) invalid();
}

/** This version binds the certificate to the whole selected batch, not just a kit. */
export function assertMinimumWaitBinding(
  value: unknown,
  current: CertifiedCurrent | null,
): asserts value is CertifiedMinimumWait {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const result = value as CertifiedMinimumWait;
  if (
    result.kit !== (current?.kit ?? null) ||
    result.uses !== (current?.uses ?? 0) ||
    result.pieces !== (current?.pieces ?? 0) ||
    result.pieces !== result.uses * 10
  )
    return invalid();
  try {
    proofFields(result);
    proofBounds(result);
  } catch {
    return invalid();
  }
}

/** No approximate P-only tie can replace a P/B/C recommendation. */
export function assertMinimumWaitTie(
  previous: CertifiedCurrent,
  selected: CertifiedCurrent,
  input: CertifiedInput,
): void {
  if (
    previous.status !== selected.status ||
    previous.optimalActionMask !== selected.optimalActionMask
  )
    invalid();
  for (const key of [
    "successP",
    "weightedExpectedConsumptionB",
    "expectedTotalConsumptionC",
  ] as const)
    if (!eq(fromWire(previous.value[key]), fromWire(selected.value[key]))) invalid();
  if (selected.kit === null) {
    if (selected.uses !== 0 || selected.pieces !== 0) invalid();
    return;
  }
  selectedBatch(selected, input);
}
function selectedBatch(selected: CertifiedCurrent, input: CertifiedInput): void {
  const index = ["blue", "purple", "yellow"].indexOf(selected.kit ?? "");
  if (
    index < 0 ||
    !(selected.optimalActionMask & (1 << index)) ||
    !Number.isInteger(selected.uses) ||
    selected.uses < 1 ||
    selected.uses > (input.batchLimit ?? 10) ||
    selected.uses > Math.floor((input.stock[index] ?? 0) / 10) ||
    selected.pieces !== selected.uses * 10
  )
    invalid();
}
