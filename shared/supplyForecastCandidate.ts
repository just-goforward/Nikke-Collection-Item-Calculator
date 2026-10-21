import { z } from "zod/mini";
import { type CertifiedSupplySnapshot, isCertifiedSupplySnapshot } from "./certifiedSupply.ts";
import { assertCandidateLedger } from "./certifiedSupplyCandidateLedger.ts";
import { isCoherentSnapshot } from "./certifiedSupplyCoherence.ts";
import {
  type CURRENT_CERTIFIED_SNAPSHOT_VERSION,
  CURRENT_FORECAST_PAYLOAD_VERSION,
  type CURRENT_FORECAST_RULES_VERSION,
  certifiedVersionPolicy,
  FORECAST_RULES_VERSIONS,
  forecastVersionsForSnapshot,
  isForecastVersionPair,
  isLegacyForecastRules,
  usesLedgerForecast,
} from "./certifiedVersionPolicy.ts";
import {
  grantSchema,
  offsetTimestampSchema,
  scheduledPeriodSchema,
} from "./supplyForecastCandidateSchemas.ts";
import {
  assertLedgerForecastProfiles,
  buildScheduleForecastProfiles,
  withForecastProjectionCache,
} from "./supplyForecastProjection.ts";

export type SupplyForecastGrant = z.infer<typeof grantSchema>;
export type SupplyForecastSoloPeriod = z.infer<typeof scheduledPeriodSchema>;

const gainSchema = z.object({
  blue: z.number().check(z.minimum(0)),
  purple: z.number().check(z.minimum(0)),
  yellow: z.number().check(z.minimum(0)),
});

const periodSchema = z.object({
  effectiveFrom: offsetTimestampSchema,
  effectiveUntil: offsetTimestampSchema,
});

export const SUPPLY_FORECAST_CANDIDATE_PAYLOAD_VERSION = CURRENT_FORECAST_PAYLOAD_VERSION;

const candidateSchema = z.object({
  payloadVersion: z.union([
    z.literal(3),
    z.literal(4),
    z.literal(SUPPLY_FORECAST_CANDIDATE_PAYLOAD_VERSION),
  ]),
  candidateId: z.string().check(z.regex(/^forecast-[a-z0-9-]{8,120}$/)),
  forecastId: z.string().check(z.regex(/^supply-\d{4}-\d{2}-\d{2}-v\d+$/)),
  rulesVersion: z.enum(FORECAST_RULES_VERSIONS),
  dispatchPolicyId: z.literal("dispatch-policy-v1"),
  generatedAt: offsetTimestampSchema,
  sourceStatus: z.enum(["crosschecked", "x_unavailable", "conflict"]),
  schedule: z.object({
    status: z.enum(["confirmed", "estimated"]),
    cadenceDays: z.nullable(z.number().check(z.minimum(21), z.maximum(35))),
    soloStart: offsetTimestampSchema,
    soloEnd: offsetTimestampSchema,
    soloPeriods: z.array(scheduledPeriodSchema).check(z.minLength(3), z.maxLength(12)),
    collaborationPeriods: z.array(periodSchema).check(z.maxLength(20)),
  }),
  sourceEvidence: z
    .array(
      z.object({
        source: z.enum(["naver-board-11", "naver-board-48", "naver-board-56", "x-nikke-kr"]),
        itemId: z.string().check(z.minLength(1), z.maxLength(160)),
        url: z.url(),
        publishedAt: offsetTimestampSchema,
        excerpt: z.string().check(z.minLength(1), z.maxLength(600)),
        contentHash: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
      }),
    )
    .check(z.minLength(1), z.maxLength(40)),
  profiles: z
    .array(
      z.object({
        id: z.string().check(z.minLength(1), z.maxLength(200)),
        effectiveFrom: offsetTimestampSchema,
        effectiveUntil: z.nullable(offsetTimestampSchema),
        scheduleStatus: z.enum(["confirmed", "estimated"]),
        expectedGain: gainSchema,
        referenceFrom: z.optional(offsetTimestampSchema),
        referenceUntil: z.optional(offsetTimestampSchema),
        referenceDays: z.optional(z.number().check(z.minimum(1))),
      }),
    )
    .check(z.maxLength(80)),
  warnings: z.array(z.string().check(z.minLength(1), z.maxLength(300))).check(z.maxLength(20)),
  certifiedSnapshot: z.optional(
    z.custom<CertifiedSupplySnapshot>(
      (value) => isCoherentSnapshot(value) || isCertifiedSupplySnapshot(value),
    ),
  ),
  grants: z.optional(z.array(grantSchema)),
});

/**
 * Candidate and certified validators signal expected rejection with plain Error.
 * Error subclasses and non-Error throws signal unavailable validation, not invalid
 * input. Classify by exact constructor, never by potentially sensitive messages.
 */
export function isExpectedCandidateRejection(error: unknown): error is Error {
  return error instanceof Error && error.constructor === Error;
}

/** Admission reports expected assertion rejections as false, but propagates
 * unexpected validator failures; the assertions remain the source of the rule. */
function admitsCandidate(candidate: z.infer<typeof candidateSchema>): boolean {
  if (!isForecastVersionPair(candidate.payloadVersion, candidate.rulesVersion)) return false;
  try {
    // Ledger fields exist exactly when the snapshot version policy defines them.
    const segmented =
      !isLegacyForecastRules(candidate.rulesVersion) &&
      candidate.certifiedSnapshot !== undefined &&
      certifiedVersionPolicy(candidate.certifiedSnapshot.version).segmentsAndGrants;
    if (
      (candidate.grants !== undefined) !== segmented ||
      candidate.schedule.soloPeriods.some(
        (period) =>
          (period.round !== undefined) !== segmented ||
          (period.segment !== undefined) !== segmented,
      )
    )
      return false;
    if (isLegacyForecastRules(candidate.rulesVersion)) return candidate.profiles.length > 0;
    if (!candidate.certifiedSnapshot) return false;
    if (
      forecastVersionsForSnapshot(candidate.certifiedSnapshot.version).rulesVersion !==
      candidate.rulesVersion
    )
      return false;
    if (certifiedVersionPolicy(candidate.certifiedSnapshot.version).segmentsAndGrants)
      assertCandidateLedger(
        candidate.certifiedSnapshot,
        candidate.schedule.soloPeriods,
        candidate.grants ?? [],
      );
    assertLedgerForecastProfiles(
      candidate.forecastId,
      candidate.certifiedSnapshot,
      candidate.profiles,
    );
    return true;
  } catch (error) {
    if (!isExpectedCandidateRejection(error)) throw error;
    return false;
  }
}

export const supplyForecastCandidateSchema = candidateSchema.check(
  z.refine((candidate) => admitsCandidate(candidate)),
);

export type SupplyForecastCandidate = z.infer<typeof supplyForecastCandidateSchema>;
export type SupplyForecastV5SoloPeriod = SupplyForecastSoloPeriod & {
  round: number;
  segment: number;
};
export type SupplyForecastV5Candidate = Omit<
  SupplyForecastCandidate,
  "payloadVersion" | "rulesVersion" | "schedule" | "grants" | "certifiedSnapshot"
> & {
  payloadVersion: typeof CURRENT_FORECAST_PAYLOAD_VERSION;
  rulesVersion: typeof CURRENT_FORECAST_RULES_VERSION;
  schedule: Omit<SupplyForecastCandidate["schedule"], "soloPeriods"> & {
    soloPeriods: SupplyForecastV5SoloPeriod[];
  };
  grants: SupplyForecastGrant[];
  certifiedSnapshot: CertifiedSupplySnapshot & {
    version: typeof CURRENT_CERTIFIED_SNAPSHOT_VERSION;
  };
};
export type SupplyForecastV5BuildInput = Omit<
  SupplyForecastV5Candidate,
  "payloadVersion" | "rulesVersion" | "profiles"
>;

/** New-writer entrypoint; historical reconstruction remains version preserving. */
export function buildSupplyForecastCandidate(
  input: SupplyForecastV5BuildInput,
): SupplyForecastV5Candidate {
  if (!certifiedVersionPolicy(input.certifiedSnapshot.version).segmentsAndGrants)
    throw new Error("unsupported_forecast_version");
  return buildV3SupplyForecastCandidate(input) as SupplyForecastV5Candidate;
}

export const supplyForecastCandidateEnvelopeSchema = z.object({
  payloadHash: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
  candidate: supplyForecastCandidateSchema,
});

export type SupplyForecastCandidateEnvelope = z.infer<typeof supplyForecastCandidateEnvelopeSchema>;

export const FORECAST_SOURCE_HOSTS = new Set(["game.naver.com", "x.com"]);

/** Construct profiles inside the trust boundary, rather than recomputing them to admit them. */
export function buildV3SupplyForecastCandidate(
  input: Record<string, unknown> & {
    forecastId: string;
    certifiedSnapshot: CertifiedSupplySnapshot;
  },
): SupplyForecastCandidate {
  return withForecastProjectionCache(() => buildCandidate(input));
}

function buildCandidate(
  input: Record<string, unknown> & {
    forecastId: string;
    certifiedSnapshot: CertifiedSupplySnapshot;
  },
): SupplyForecastCandidate {
  const profiles = buildScheduleForecastProfiles({
    forecastId: input.forecastId,
    effectiveFrom: input.certifiedSnapshot.asOf,
    certifiedSnapshot: input.certifiedSnapshot,
  });
  const candidate = supplyForecastCandidateSchema.parse({
    ...input,
    ...forecastVersionsForSnapshot(input.certifiedSnapshot.version),
    profiles,
  });
  assertCandidateContent(candidate);
  return candidate;
}

export function assertForecastCandidateInvariants(candidate: SupplyForecastCandidate) {
  if (!supplyForecastCandidateSchema.safeParse(candidate).success)
    throw new Error("forecast_candidate_schema_invalid");
  if (!isForecastVersionPair(candidate.payloadVersion, candidate.rulesVersion))
    throw new Error("unsupported_forecast_version");
  if (usesLedgerForecast(candidate.rulesVersion)) {
    if (!candidate.certifiedSnapshot) throw new Error("v3_forecast_requires_certified_snapshot");
    if (
      forecastVersionsForSnapshot(candidate.certifiedSnapshot.version).rulesVersion !==
      candidate.rulesVersion
    )
      throw new Error("unsupported_forecast_version");
    assertLedgerForecastProfiles(
      candidate.forecastId,
      candidate.certifiedSnapshot,
      candidate.profiles,
    );
  }
  assertCandidateContent(candidate);
}

function assertCandidateContent(candidate: SupplyForecastCandidate) {
  const soloStart = Date.parse(candidate.schedule.soloStart);
  const soloEnd = Date.parse(candidate.schedule.soloEnd);
  if (!(soloEnd > soloStart)) throw new Error("Solo Raid schedule is inverted.");
  if (
    candidate.schedule.cadenceDays !== null &&
    !Number.isInteger(candidate.schedule.cadenceDays)
  ) {
    throw new Error("Solo Raid cadence must be a whole number of game days.");
  }
  assertPeriods(candidate.schedule.soloPeriods, "Solo Raid", true);
  assertPeriods(candidate.schedule.collaborationPeriods, "Collaboration", false);
  if (
    !candidate.schedule.soloPeriods.some(
      (period) =>
        Date.parse(period.effectiveFrom) === soloStart &&
        Date.parse(period.effectiveUntil) === soloEnd,
    )
  ) {
    throw new Error("Primary Solo Raid schedule is missing from its period ledger.");
  }

  assertSourceEvidence(candidate.sourceEvidence);
  assertProfileSequence(candidate);
}

function assertPeriods(
  periods: readonly { effectiveFrom: string; effectiveUntil: string }[],
  label: string,
  requireOrdered: boolean,
) {
  const identities = new Set<string>();
  for (let index = 0; index < periods.length; index += 1) {
    const period = periods[index];
    if (!period) continue;
    const start = Date.parse(period.effectiveFrom);
    const end = Date.parse(period.effectiveUntil);
    if (!(end > start)) throw new Error(`${label} period is inverted.`);
    const identity = `${period.effectiveFrom}|${period.effectiveUntil}`;
    if (identities.has(identity)) throw new Error(`${label} period is duplicated.`);
    identities.add(identity);
    const previous = periods[index - 1];
    if (requireOrdered && previous && start < Date.parse(previous.effectiveUntil)) {
      throw new Error(`${label} periods must be ordered and non-overlapping.`);
    }
  }
}

function assertSourceEvidence(sourceEvidence: SupplyForecastCandidate["sourceEvidence"]) {
  for (const evidence of sourceEvidence) {
    const url = new URL(evidence.url);
    if (url.protocol !== "https:" || !FORECAST_SOURCE_HOSTS.has(url.hostname)) {
      throw new Error(`Source URL is not allowlisted: ${evidence.url}`);
    }
  }
}

function assertProfileSequence(candidate: SupplyForecastCandidate) {
  for (let index = 0; index < candidate.profiles.length; index += 1) {
    const current = candidate.profiles[index];
    if (!current) continue;
    if (!current.id.startsWith(`${candidate.forecastId}@`)) {
      throw new Error(`Profile does not belong to ${candidate.forecastId}.`);
    }
    const next = candidate.profiles[index + 1];
    if (
      next &&
      isLegacyForecastRules(candidate.rulesVersion) &&
      current.effectiveUntil !== next.effectiveFrom
    ) {
      throw new Error("Forecast profiles are not contiguous.");
    }
    if (!next && isLegacyForecastRules(candidate.rulesVersion) && current.effectiveUntil !== null) {
      throw new Error("Final forecast profile must be open-ended.");
    }
    for (const kit of ["blue", "purple", "yellow"] as const) {
      if (!Number.isFinite(current.expectedGain[kit]) || current.expectedGain[kit] < 0) {
        throw new Error(`Forecast gain is invalid at ${current.id}.`);
      }
    }
  }
}
