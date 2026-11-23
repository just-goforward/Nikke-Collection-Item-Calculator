import { z } from "zod/mini";
import { offsetTimestampSchema } from "./supplyForecastCandidateSchemas";

const text = z.string().check(z.minLength(1), z.maxLength(500));
const hash = z.string().check(z.regex(/^[a-f0-9]{64}$/));
const integer = z.number().check(z.int(), z.minimum(1));
const window = z.strictObject({ from: offsetTimestampSchema, until: offsetTimestampSchema });
const source = z.strictObject({ feedId: integer, versionId: text, contentHash: hash });
const schema = z.strictObject({
  version: z.literal(1),
  window,
  history: window,
  futureProjection: z.literal("known_inputs_and_adopted_model_not_future_source_completeness"),
  observedAt: offsetTimestampSchema,
  freshUntil: offsetTimestampSchema,
  census: z.strictObject({
    from: offsetTimestampSchema,
    until: offsetTimestampSchema,
    boards: z.array(z.union([z.literal(11), z.literal(48), z.literal(56)])).check(z.minLength(3), z.maxLength(3)),
    sources: z.array(z.strictObject({
      ...source.shape,
      bodyHash: hash,
      imageReview: z.enum(["reviewed", "no_images"]),
      imageReferences: z.array(z.strictObject({
        artifactId: text, url: text, contentHash: hash, capturedAt: offsetTimestampSchema,
      })).check(z.maxLength(100)),
      disposition: z.enum(["calendar", "grant", "no_automatic_supply", "conditional_excluded"]),
      rationale: text,
    })).check(z.minLength(1), z.maxLength(500)),
    semanticAttestation: z.literal("operator_reviewed_complete_source_census"),
  }),
  categories: z.strictObject({ raidDurations: window, collaborationPeriods: window, rewardRules: window }),
  negativeGrants: z.strictObject({ ...window.shape, attestation: z.literal("no_other_automatic_supply_in_reviewed_census") }),
  grants: z.array(z.strictObject({
    occurrenceId: text, revision: integer, grantGameDate: z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/)),
    scheduledAt: offsetTimestampSchema,
    iiQty: z.number().check(z.int(), z.minimum(0)), boxQty: z.number().check(z.int(), z.minimum(0)),
    observationIds: z.array(text).check(z.minLength(1), z.maxLength(100)),
    claimUntil: z.nullable(offsetTimestampSchema), claimWindowAssumed: z.boolean(),
    claimEvidence: text,
  })).check(z.maxLength(500)),
  model: z.strictObject({
    ...window.shape,
    digest: hash,
    policy: z.literal("declared_model_assumptions_not_official_probabilities"),
    acceptance: z.literal("explicitly_adopted"),
  }),
});
export type HistoryCoverageManifest = z.infer<typeof schema>;
export function parseHistoryCoverageManifest(value: unknown): HistoryCoverageManifest {
  return schema.parse(value);
}

/** Public, bounded authority; semantic completeness is a human attestation. */
export type ForecastSourceAuthority = {
  manifestDigest: string;
  decisionId: string;
  approvedAt: string;
  observedAt: string;
  freshUntil: string;
  from: string;
  until: string;
  historyUntil: string;
  futureProjection: "known_inputs_and_adopted_model_not_future_source_completeness";
  modelDigest: string;
  modelPolicy: "declared_model_assumptions_not_official_probabilities";
  semanticAttestation: "operator_reviewed_complete_source_census";
};
