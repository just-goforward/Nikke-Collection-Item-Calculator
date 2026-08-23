import { z } from "zod/mini";

const gainSchema = z.object({
  blue: z.number().check(z.minimum(0)),
  purple: z.number().check(z.minimum(0)),
  yellow: z.number().check(z.minimum(0)),
});

const offsetTimestampSchema = z
  .string()
  .check(z.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/));

export const supplyForecastCandidateSchema = z.object({
  payloadVersion: z.literal(2),
  candidateId: z.string().check(z.regex(/^forecast-[a-z0-9-]{8,120}$/)),
  forecastId: z.string().check(z.regex(/^supply-\d{4}-\d{2}-\d{2}-v\d+$/)),
  rulesVersion: z.literal("schedule-kit-v1"),
  dispatchPolicyId: z.literal("dispatch-policy-v1"),
  generatedAt: offsetTimestampSchema,
  sourceStatus: z.enum(["crosschecked", "x_unavailable", "conflict"]),
  schedule: z.object({
    status: z.enum(["confirmed", "estimated"]),
    cadenceDays: z.nullable(z.number().check(z.minimum(21), z.maximum(35))),
    soloStart: offsetTimestampSchema,
    soloEnd: offsetTimestampSchema,
    collaborationPeriods: z.array(
      z.object({
        effectiveFrom: offsetTimestampSchema,
        effectiveUntil: offsetTimestampSchema,
      }),
    ),
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
    .check(z.minLength(1), z.maxLength(20)),
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

  assertSourceEvidence(candidate.sourceEvidence);
  assertProfileSequence(candidate);
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
    if (!next) continue;
    for (const kit of ["blue", "purple", "yellow"] as const) {
      if (next.expectedGain[kit] > current.expectedGain[kit] + 1e-9) {
        throw new Error(`Forecast gain increases at ${next.id}.`);
      }
    }
  }
}
