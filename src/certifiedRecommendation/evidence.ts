import { cmp, ONE, q, type Q, ZERO } from "../../shared/certifiedRational";

/** Identities come from the trusted request owner, not from an untrusted result. */
export interface RecommendationContext {
  readonly requestId: string;
  readonly inputFingerprint: string;
  readonly modelFingerprint: string;
  readonly stateFingerprint: string;
  readonly asOf: string;
  readonly horizonDays: 14;
  readonly engineFingerprint: string;
}

export interface ExactProbabilityRecord {
  readonly context: RecommendationContext;
  readonly day: number;
  readonly probability: Q;
}

export type RecommendationEvidenceErrorCode =
  | "invalid_input"
  | "corrupt_evidence"
  | "binding_mismatch"
  | "unverified_certificate";

/** Validation failures are never numerical INCOMPLETE results. */
export class RecommendationEvidenceError extends Error {
  constructor(
    readonly code: RecommendationEvidenceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RecommendationEvidenceError";
  }
}

export interface ExistingFUpperAttainmentClaim {
  readonly context: RecommendationContext;
  /** Existing F producer's exact upper bound on every P(d), d = 0..14. */
  readonly upperProbability: Q;
  /** An actual exact record at this day must attain upperProbability. */
  readonly attainedDay: number;
}

/**
 * Code authority, NOT a caller-supplied proof flag or a wire-data interface.
 * A trusted integration must authenticate the existing F producer and verify
 * applicability to the complete request before returning its mathematical claim.
 * No production adapter is installed by this standalone module.
 */
export interface ExistingFUpperAttainmentAdapter {
  verify(
    candidate: Readonly<Record<string, unknown>>,
    expectedContext: Readonly<RecommendationContext>,
  ): ExistingFUpperAttainmentClaim | null;
}

class FUpperAttainmentCapability {
  readonly #claim: ExistingFUpperAttainmentClaim;

  constructor(claim: ExistingFUpperAttainmentClaim) {
    this.#claim = claim;
    Object.freeze(this);
  }

  claim(): ExistingFUpperAttainmentClaim {
    return this.#claim;
  }
}

/** Opaque, in-process capability; JSON, tags and boolean flags cannot recreate it. */
export type ExistingFUpperAttainment = FUpperAttainmentCapability;

export interface RecommendationEvidence {
  /** Actual completed expectations, including D0; never boundary/support witnesses. */
  readonly probabilities: readonly ExactProbabilityRecord[];
  readonly upperAttainment?: ExistingFUpperAttainment | null;
}

const CONTEXT_KEYS = [
  "requestId",
  "inputFingerprint",
  "modelFingerprint",
  "stateFingerprint",
  "asOf",
  "engineFingerprint",
] as const;

function object(
  value: unknown,
  code: RecommendationEvidenceErrorCode,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new RecommendationEvidenceError(code, `${label} must be an object.`);
  return value as Record<string, unknown>;
}

function context(
  value: unknown,
  code: RecommendationEvidenceErrorCode,
): Readonly<RecommendationContext> {
  const raw = object(value, code, "Context");
  for (const key of CONTEXT_KEYS) {
    if (typeof raw[key] !== "string" || raw[key].trim().length === 0)
      throw new RecommendationEvidenceError(code, `Context ${key} is missing.`);
  }
  if (raw["horizonDays"] !== 14)
    throw new RecommendationEvidenceError(code, "Context horizonDays must be 14.");
  return Object.freeze({
    requestId: raw["requestId"] as string,
    inputFingerprint: raw["inputFingerprint"] as string,
    modelFingerprint: raw["modelFingerprint"] as string,
    stateFingerprint: raw["stateFingerprint"] as string,
    asOf: raw["asOf"] as string,
    horizonDays: 14,
    engineFingerprint: raw["engineFingerprint"] as string,
  });
}

function boundContext(
  value: unknown,
  expected: RecommendationContext,
): Readonly<RecommendationContext> {
  const actual = context(value, "corrupt_evidence");
  if (CONTEXT_KEYS.some((key) => actual[key] !== expected[key]))
    throw new RecommendationEvidenceError("binding_mismatch", "Evidence context does not match.");
  return actual;
}

function probability(value: unknown): Q {
  const raw = object(value, "corrupt_evidence", "Probability");
  const n = raw["n"];
  const d = raw["d"];
  if (typeof n !== "bigint" || typeof d !== "bigint" || d <= 0n)
    throw new RecommendationEvidenceError(
      "corrupt_evidence",
      "Probability requires BigInt numerator and positive BigInt denominator.",
    );
  const normalized = q(n, d);
  if (cmp(normalized, ZERO) < 0 || cmp(normalized, ONE) > 0)
    throw new RecommendationEvidenceError("corrupt_evidence", "Probability is outside [0, 1].");
  return Object.freeze(normalized);
}

function day(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 14)
    throw new RecommendationEvidenceError("corrupt_evidence", "Day must be an integer in 0..14.");
  return value;
}

/**
 * Explicit trust boundary. The adapter, not a string in candidate.evidence, owns
 * authentication and the F upper-bound theorem. This function checks its shape
 * and request binding, then freezes a non-serializable capability.
 * No adapter, or an adapter returning null, means unsupported proof, not verified
 * evidence. Pass that null to selection: missing unexcluded dates stay INCOMPLETE.
 */
export function verifyExistingFUpperAttainment(
  candidate: unknown,
  expectedContext: RecommendationContext,
  adapter?: ExistingFUpperAttainmentAdapter,
): ExistingFUpperAttainment | null {
  const expected = context(expectedContext, "invalid_input");
  const raw = object(candidate, "unverified_certificate", "F certificate candidate");
  if (adapter === undefined) return null;
  if (!adapter || typeof adapter.verify !== "function")
    throw new RecommendationEvidenceError("invalid_input", "A trusted F adapter is required.");
  let verified: unknown;
  try {
    verified = adapter.verify(raw, expected);
  } catch (cause) {
    throw new RecommendationEvidenceError(
      "unverified_certificate",
      "The trusted F adapter rejected the certificate.",
      { cause },
    );
  }
  if (verified === null) return null;
  const claim = object(verified, "unverified_certificate", "Verified F claim");
  return new FUpperAttainmentCapability(
    Object.freeze({
      context: boundContext(claim["context"], expected),
      upperProbability: probability(claim["upperProbability"]),
      attainedDay: day(claim["attainedDay"]),
    }),
  );
}

export interface ValidatedRecommendationEvidence {
  readonly probabilities: ReadonlyMap<number, Q>;
  readonly upperAttainment: ExistingFUpperAttainmentClaim | null;
}

/** Validate every supplied record/certificate, including evidence not needed to win. */
export function validateRecommendationEvidence(
  expectedContext: RecommendationContext,
  evidence: RecommendationEvidence,
): ValidatedRecommendationEvidence {
  const expected = context(expectedContext, "invalid_input");
  const raw = object(evidence, "invalid_input", "Recommendation evidence");
  const records = raw["probabilities"];
  if (!Array.isArray(records))
    throw new RecommendationEvidenceError("invalid_input", "Exact probability records are required.");
  if (records.length > 15)
    throw new RecommendationEvidenceError("corrupt_evidence", "Only the 15 dates 0..14 exist.");
  const probabilities = new Map<number, Q>();
  for (const value of records) {
    const record = object(value, "corrupt_evidence", "Exact date record");
    boundContext(record["context"], expected);
    const d = day(record["day"]);
    if (probabilities.has(d))
      throw new RecommendationEvidenceError("corrupt_evidence", "Duplicate exact date record.");
    probabilities.set(d, probability(record["probability"]));
  }
  let upperAttainment: ExistingFUpperAttainmentClaim | null = null;
  if (raw["upperAttainment"] !== undefined && raw["upperAttainment"] !== null) {
    const capability = raw["upperAttainment"];
    if (!(capability instanceof FUpperAttainmentCapability))
      throw new RecommendationEvidenceError(
        "unverified_certificate",
        "F upper attainment requires a verified in-process capability.",
      );
    try {
      // Invoke the genuine method; an object with only a forged prototype has no private field.
      upperAttainment = FUpperAttainmentCapability.prototype.claim.call(capability);
    } catch (cause) {
      throw new RecommendationEvidenceError(
        "unverified_certificate",
        "Invalid F upper-attainment capability.",
        { cause },
      );
    }
    boundContext(upperAttainment.context, expected);
    for (const p of probabilities.values()) {
      if (cmp(p, upperAttainment.upperProbability) > 0)
        throw new RecommendationEvidenceError("corrupt_evidence", "An exact record exceeds the F bound.");
    }
    const attained = probabilities.get(upperAttainment.attainedDay);
    if (attained !== undefined && cmp(attained, upperAttainment.upperProbability) !== 0)
      throw new RecommendationEvidenceError("corrupt_evidence", "The exact record does not attain the F bound.");
  }
  return { probabilities, upperAttainment };
}
