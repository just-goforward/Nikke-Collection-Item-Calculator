import { z } from "zod/mini";
import { supplyForecastCandidateEnvelopeSchema } from "../../shared/supplyForecastCandidate";
import { sha256Hex } from "./crypto";
import { isConstructedNoticeCandidate } from "./notice-processing";

const timestampSchema = z.string().check(z.iso.datetime({ offset: true }));
const sourceSchema = z.enum(["naver-board-11", "naver-board-48", "naver-board-56"]);
const itemSchema = z.object({
  source: sourceSchema,
  itemId: z.string().check(z.regex(/^\d{1,20}$/)),
  url: z.url(),
  title: z.string().check(z.minLength(1), z.maxLength(300)),
  excerpt: z.string().check(z.minLength(1), z.maxLength(600)),
  normalizedText: z.string().check(z.minLength(1), z.maxLength(100_000)),
  publishedAt: timestampSchema,
  contentHash: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
  structured: z.literal(true),
  official: z.boolean(),
});
const eventSchema = z.object({
  segment: z.optional(
    z.object({
      round: z.number().check(z.int(), z.minimum(1)),
      segment: z.number().check(z.int(), z.minimum(1)),
      kind: z.enum(["initial", "suspend", "reopen"]),
      effectiveFrom: timestampSchema,
      effectiveUntil: timestampSchema,
    }),
  ),
  eventId: z.string().check(z.minLength(1), z.maxLength(260)),
  eventType: z.enum(["solo", "cooperation", "collaboration", "schedule_change", "reward", "grant"]),
  sourceItem: itemSchema,
  startsAt: z.nullable(timestampSchema),
  endsAt: z.nullable(timestampSchema),
  scheduleStatus: z.enum(["confirmed", "estimated"]),
  manualReview: z.boolean(),
  reason: z.nullable(z.string().check(z.maxLength(160))),
});
const resultSchema = z.object({
  source: sourceSchema,
  itemId: z.string().check(z.regex(/^\d{1,20}$/)),
  outcome: z.enum(["processed", "ignored", "manual_review", "retry"]),
  errorCode: z.optional(z.string().check(z.maxLength(80))),
  item: z.optional(itemSchema),
  event: z.optional(eventSchema),
  events: z.optional(z.array(eventSchema).check(z.maxLength(8))),
});
const sourceQueueProcessSchema = z.object({
  mode: z.enum(["queue", "bootstrap"]),
  results: z.array(resultSchema).check(z.maxLength(40)),
  candidate: z.optional(
    z.object({
      eventId: z.string().check(z.minLength(1), z.maxLength(260)),
      gameDay: z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/)),
      revision: z.number().check(z.int(), z.minimum(1)),
      envelope: supplyForecastCandidateEnvelopeSchema,
    }),
  ),
});

export type SourceQueueProcessResult = z.infer<typeof resultSchema>;

export function parseSourceQueueProcess(raw: unknown) {
  // The authenticated external route still validates the complete untrusted
  // envelope. The local constructor already derived/validated the profiles;
  // only its deep-frozen, non-serializable proof avoids deriving them twice more.
  return typeof raw === "object" &&
    raw !== null &&
    "candidate" in raw &&
    isConstructedNoticeCandidate(raw.candidate)
    ? {
        ...sourceQueueProcessSchema.parse({ ...raw, candidate: undefined }),
        candidate: raw.candidate,
      }
    : sourceQueueProcessSchema.parse(raw);
}

export async function validateSourceQueueResult(result: SourceQueueProcessResult) {
  validateEventBindings(result);
  await validateItemContent(result);
  if (result.outcome === "processed" && (!result.item || !result.event)) {
    throw new Error("source_queue_processed_payload");
  }
}

function validateEventBindings(result: SourceQueueProcessResult) {
  for (const event of result.events ?? []) {
    if (
      !result.item ||
      event.sourceItem.itemId !== result.itemId ||
      event.sourceItem.source !== result.source
    ) {
      throw new Error("source_queue_event_mismatch");
    }
  }
  if (
    result.item &&
    (result.item.source !== result.source || result.item.itemId !== result.itemId)
  ) {
    throw new Error("source_queue_item_mismatch");
  }
  if (result.event && (!result.item || result.event.sourceItem.itemId !== result.itemId)) {
    throw new Error("source_queue_event_mismatch");
  }
}

async function validateItemContent(result: SourceQueueProcessResult) {
  if (result.item) {
    const url = new URL(result.item.url);
    if (url.protocol !== "https:" || url.hostname !== "game.naver.com") {
      throw new Error("source_queue_url_allowlist");
    }
    if ((await sha256Hex(result.item.normalizedText)) !== result.item.contentHash) {
      throw new Error("source_queue_content_hash");
    }
  }
}
