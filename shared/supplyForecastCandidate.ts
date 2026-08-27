import { z } from "zod/mini";

const gainSchema = z.object({
  blue: z.number().check(z.minimum(0)),
  purple: z.number().check(z.minimum(0)),
  yellow: z.number().check(z.minimum(0)),
});

const offsetTimestampSchema = z
  .string()
  .check(z.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/));

const periodSchema = z.object({
  effectiveFrom: offsetTimestampSchema,
  effectiveUntil: offsetTimestampSchema,
});

const scheduledPeriodSchema = z.object({
  effectiveFrom: offsetTimestampSchema,
  effectiveUntil: offsetTimestampSchema,
  scheduleStatus: z.enum(["confirmed", "estimated"]),
});

export const supplyForecastCandidateSchema = z.object({
  payloadVersion: z.literal(3),
  candidateId: z.string().check(z.regex(/^forecast-[a-z0-9-]{8,120}$/)),
  forecastId: z.string().check(z.regex(/^supply-\d{4}-\d{2}-\d{2}-v\d+$/)),
  rulesVersion: z.literal("schedule-kit-v2"),
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
        source: z.enum(["naver-board-48", "naver-board-56", "x-nikke-kr"]),
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
      }),
    )
    .check(z.minLength(1), z.maxLength(80)),
  warnings: z.array(z.string().check(z.minLength(1), z.maxLength(300))).check(z.maxLength(20)),
});

export type SupplyForecastCandidate = z.infer<typeof supplyForecastCandidateSchema>;

export const supplyForecastCandidateEnvelopeSchema = z.object({
  payloadHash: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
  candidate: supplyForecastCandidateSchema,
});

export type SupplyForecastCandidateEnvelope = z.infer<typeof supplyForecastCandidateEnvelopeSchema>;

export const FORECAST_SOURCE_HOSTS = new Set(["game.naver.com", "x.com"]);

export function assertForecastCandidateInvariants(candidate: SupplyForecastCandidate) {
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
    if (next && current.effectiveUntil !== next.effectiveFrom) {
      throw new Error("Forecast profiles are not contiguous.");
    }
    if (!next && current.effectiveUntil !== null) {
      throw new Error("Final forecast profile must be open-ended.");
    }
    for (const kit of ["blue", "purple", "yellow"] as const) {
      if (!Number.isFinite(current.expectedGain[kit]) || current.expectedGain[kit] < 0) {
        throw new Error(`Forecast gain is invalid at ${current.id}.`);
      }
    }
  }
}
