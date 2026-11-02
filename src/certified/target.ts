import { cmp, fromWire, toWire, type WireQ } from "../../shared/certifiedRational";
import { CertifiedLimit, type WorkBudget } from "./budget";
import type { CertifiedInput, CertifiedTarget, CertifiedValue, CompletedDate } from "./types";

export function targetConfig(input: CertifiedInput): CertifiedTarget | undefined {
  const target = input.target;
  if (target === undefined) return undefined;
  const fail = () => { throw new CertifiedLimit("invalid_target"); };
  if (!target || target.version !== "target-v1" || !target.alpha) return fail();
  const { numerator, denominator } = target.alpha;
  if (typeof numerator !== "string" || typeof denominator !== "string" ||
      !/^[0-9]{1,128}$/.test(numerator) || !/^[0-9]{1,128}$/.test(denominator)) return fail();
  const n = BigInt(numerator), d = BigInt(denominator);
  if (d === 0n || n > d) return fail();
  const maxDays = target.maxDays === undefined ? 14 : target.maxDays;
  if (!Number.isSafeInteger(maxDays) || maxDays < 0 || maxDays > 14) return fail();
  return { version: "target-v1", alpha: toWire(fromWire(target.alpha)), maxDays,
    status: "unresolved", minimumDays: null, probabilities: [], value: null,
    earliestNotRuledOutDay: null, attainedByDay: null, completedThroughDay: null,
    reason: "target_in_progress" };
}

/** No monotonicity or waiting recommendation inference is permitted here. */
export function selectTarget(
  config: CertifiedTarget,
  current: CertifiedValue,
  records: readonly CompletedDate[],
  claimRequired: boolean,
  check: () => void = () => {},
  reserve: (bytes: number) => void = () => {},
): CertifiedTarget {
  const result: CertifiedTarget = { ...config, probabilities: [], value: null,
    minimumDays: null, earliestNotRuledOutDay: null, attainedByDay: null,
    completedThroughDay: null, status: "unresolved", reason: "missing_exact_dates" };
  const fail = () => { throw new CertifiedLimit("target_completed_dates_protocol"); };
  validateTargetValue(current, check, reserve);
  if (!Array.isArray(records) || records.length > 15) fail();
  reserve(2048);
  let previous = -1;
  for (const record of records) {
    check();
    if (!record || !record.value) fail();
    validateTargetValue(record.value, check, reserve);
    if (!Number.isInteger(record.day) || record.day < 0 || record.day > 14 || record.day <= previous) fail();
    previous = record.day;
    assertCompletedCurrent(current, record);
  }
  if (claimRequired) return { ...result, status: "claim_required", reason: "current_claimable_unreceived" };
  const dates = new Map(records.filter(r => r.day <= config.maxDays).map(r => [r.day, r.value]));
  dates.set(0, current);
  result.probabilities = [...dates].sort(([a], [b]) => a - b).map(([day, value]) => ({ day, successP: value.successP }));
  for (const { day, successP } of result.probabilities) {
    check();
    if (cmp(fromWire(successP), fromWire(config.alpha)) >= 0) {
      result.attainedByDay = day;
      break;
    }
  }
  const completed = new Set(records.map(record => record.day));
  completed.add(0);
  result.completedThroughDay = 0;
  while (result.completedThroughDay < 14 && completed.has(result.completedThroughDay + 1))
    result.completedThroughDay++;
  for (let day = 0; day <= config.maxDays; day++) {
    check();
    const value = dates.get(day);
    if (!value) return { ...result, earliestNotRuledOutDay: day };
    if (cmp(fromWire(value.successP), fromWire(config.alpha)) >= 0)
      return { ...result, status: "certified", earliestNotRuledOutDay: day, minimumDays: day, value, reason: null };
  }
  return { ...result, status: "not_reached_within_limit", reason: null };
}

function protocol(): never {
  throw new CertifiedLimit("target_completed_dates_protocol");
}

/** Day zero may differ in tied colors, but never in the exact P/B/C objective. */
export function assertCompletedCurrent(current: CertifiedValue, record: CompletedDate): void {
  if (record.day === 0 && (
    cmp(fromWire(record.value.successP), fromWire(current.successP)) ||
    cmp(fromWire(record.value.weightedExpectedConsumptionB), fromWire(current.weightedExpectedConsumptionB)) ||
    cmp(fromWire(record.value.expectedTotalConsumptionC), fromWire(current.expectedTotalConsumptionC))
  )) protocol();
}

/** No digit ceiling on solver-produced rationals; admission precedes BigInt/GCD. */
function exact(wire: WireQ, check: () => void, reserve: (bytes: number) => void) {
  check();
  if (!wire || typeof wire.numerator !== "string" || typeof wire.denominator !== "string")
    return protocol();
  reserve(128 + (wire.numerator.length + wire.denominator.length) * 8);
  if (!/^[0-9]+$/.test(wire.numerator) || !/^[0-9]+$/.test(wire.denominator) ||
      !/[1-9]/.test(wire.denominator)) return protocol();
  const result = fromWire(wire);
  check();
  return result;
}

export function validateTargetValue(
  value: CertifiedValue, check: () => void, reserve: (bytes: number) => void,
): void {
  if (!value || !Array.isArray(value.expectedConsumed) || value.expectedConsumed.length !== 3)
    protocol();
  const p = exact(value.successP, check, reserve);
  if (p.n > p.d) protocol();
  exact(value.weightedExpectedConsumptionB, check, reserve);
  const c = exact(value.expectedTotalConsumptionC, check, reserve);
  const consumed = value.expectedConsumed.map(w => exact(w, check, reserve));
  let n = 0n, d = 1n;
  for (const part of consumed) { n = n * part.d + part.n * d; d *= part.d; }
  if (n * c.d !== c.n * d) protocol();
  check();
}

export function decodeCompletedDates(
  envelope: unknown,
  budget: Pick<WorkBudget, "check" | "reserve">,
  decode: (wire: { p: WireQ; b: WireQ; c: WireQ; consumed: [WireQ, WireQ, WireQ]; mask: number }) => CertifiedValue,
): CompletedDate[] {
  const data = envelope as { schemaVersion?: unknown; records?: unknown };
  if (!data || data.schemaVersion !== 1 || !Array.isArray(data.records) || data.records.length > 15)
    return protocol();
  budget.reserve(2048);
  let previous = -1;
  return data.records.map(record => {
    budget.check();
    if (!record || !Number.isInteger(record.day) || record.day < 0 || record.day > 14 ||
        record.day <= previous || !record.value) return protocol();
    previous = record.day;
    const wire = record.value;
    if (!Number.isSafeInteger(wire.mask) || wire.mask < 0 || wire.mask > 7) return protocol();
    validateTargetValue({
      successP: wire.p, weightedExpectedConsumptionB: wire.b, expectedTotalConsumptionC: wire.c,
      expectedConsumed: wire.consumed,
    } as CertifiedValue, budget.check, bytes => budget.reserve(bytes));
    const value = decode(wire);
    budget.check();
    return { day: record.day, value };
  });
}
