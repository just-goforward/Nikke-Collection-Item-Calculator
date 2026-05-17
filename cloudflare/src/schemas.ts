import z from "zod/v4";

const GradeSchema = z.enum(["R", "SR"]);
const KitSchema = z.enum(["blue", "purple", "yellow"]);

const CollectionStateSchema = z
  .object({
    grade: GradeSchema,
    level: z.number(),
    exp: z.number(),
  })
  .passthrough();

const StockSchema = z
  .object({
    blue: z.number(),
    purple: z.number(),
    yellow: z.number(),
  })
  .passthrough();

const KitResultEventSchema = z
  .object({
    kind: z.literal("kit_result"),
    start: CollectionStateSchema,
    kit: KitSchema,
    recommendedUses: z.number(),
    outcome: z.enum(["great_success", "no_great_success"]),
    successAttempt: z.number().nullable().optional(),
    stockBefore: StockSchema,
    stockAfter: StockSchema,
    resultState: CollectionStateSchema,
  })
  .passthrough();

export const EventSubmissionSchema = z
  .object({
    version: z.literal(1),
    eventId: z.string(),
    clientTime: z.string().optional(),
    sourceHost: z.string().optional(),
    turnstileToken: z.string(),
    event: KitResultEventSchema,
  })
  .passthrough();
