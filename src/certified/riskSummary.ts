import { add, cmp, fromWire, q, type WireQ } from "../../shared/certifiedRational.ts";
import type { CertifiedEvidenceBudget, CertifiedRiskSummaries, CompletedDate } from "./types.ts";

/** Decode consistency, not producer authentication or an actual renewed-WAIT probability. */
export function decodeRiskSummaries(
  raw: unknown,
  requested: boolean,
  completed: readonly CompletedDate[],
  budget: CertifiedEvidenceBudget,
): CertifiedRiskSummaries | undefined {
  if (raw === undefined) {
    if (requested) throw new Error("risk_summaries_missing");
    return undefined;
  }
  if (!requested) throw new Error("unrequested_risk_summaries");
  budget.check();
  const fail = (): never => { throw new Error("risk_summaries_protocol"); };
  const keys = (value: object, expected: readonly string[]) => {
    const actual = Reflect.ownKeys(value);
    if (actual.length !== expected.length || actual.some(key => typeof key !== "string" || !expected.includes(key)))
      fail();
  };
  if (!raw || typeof raw !== "object") return fail();
  const envelope = raw as CertifiedRiskSummaries;
  keys(envelope, ["schemaVersion", "policyVersion", "horizonDays", "records"]);
  if (envelope.schemaVersion !== 1 ||
    envelope.policyVersion !== "experimental-w-selector-v1" || envelope.horizonDays !== 14 ||
    !Array.isArray(envelope.records) || envelope.records.length < 1 ||
    envelope.records.length > 15 || envelope.records.length !== completed.length) return fail();
  let reserved = 0;
  const mass = (wire: WireQ) => {
    budget.check();
    if (!wire || typeof wire !== "object" ||
      typeof wire.numerator !== "string" || typeof wire.denominator !== "string" ||
      !/^\d+$/.test(wire.numerator) || !/^[1-9]\d*$/.test(wire.denominator)) return fail();
    keys(wire, ["numerator", "denominator"]);
    const bytes = 128 + 8 * (wire.numerator.length + wire.denominator.length);
    reserved += bytes;
    budget.reserve(bytes);
    const value = fromWire(wire);
    if (cmp(value, q(0)) < 0 || cmp(value, q(1)) > 0) return fail();
    return value;
  };
  try {
    let previous = -1;
    for (const record of envelope.records) {
      budget.check();
      if (!record || !Number.isInteger(record.day) || record.day <= previous ||
        record.day < 0 || record.day > 14) return fail();
      keys(record, ["day", "meanSuccessP", "insufficientGainMass",
        "noFurtherWaitCertifiedMass", "renewedWaitUpperBound"]);
      previous = record.day;
      const exact = completed.find(date => date.day === record.day);
      if (!exact) return fail();
      const mean = mass(record.meanSuccessP);
      mass(record.insufficientGainMass);
      const noWait = mass(record.noFurtherWaitCertifiedMass);
      const renewed = mass(record.renewedWaitUpperBound);
      if (cmp(mean, mass(exact.value.successP)) !== 0 ||
        cmp(add(noWait, renewed), q(1)) !== 0) return fail();
    }
    budget.check();
    return envelope;
  } finally {
    budget.release(reserved);
  }
}
