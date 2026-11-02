import { z } from "zod/mini";

export const offsetTimestampSchema = z
  .string()
  .check(z.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/));

export const scheduledPeriodSchema = z.object({
  effectiveFrom: offsetTimestampSchema,
  effectiveUntil: offsetTimestampSchema,
  scheduleStatus: z.enum(["confirmed", "estimated"]),
  round: z.optional(z.number().check(z.int(), z.minimum(1))),
  segment: z.optional(z.number().check(z.int(), z.minimum(1))),
});

export const grantSchema = z.object({
  id: z.string().check(z.regex(/^grant:[a-z0-9-]+:[A-Za-z0-9_-]+:\d{4}-\d{2}-\d{2}:[1-9]\d*$/)),
  grantGameDate: z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/)),
  refs: z
    .array(
      z.object({
        lawId: z.string().check(z.minLength(1)),
        count: z.number().check(z.int(), z.minimum(1), z.maximum(64)),
      }),
    )
    .check(z.minLength(1)),
  claimUntil: z.optional(offsetTimestampSchema),
  claimWindowAssumed: z.boolean(),
  sourceIds: z.array(z.string().check(z.minLength(1))).check(z.minLength(1)),
  restatementOf: z.array(z.string().check(z.minLength(1))),
});

export type SupplyForecastGrant = z.infer<typeof grantSchema>;
export type SupplyForecastSoloPeriod = z.infer<typeof scheduledPeriodSchema>;
