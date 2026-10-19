import { z } from "zod";

// Public evidence omits internal run IDs and any unrecognized database fields.
export const monitorProgressProjection = z.object({
  valid: z.boolean(),
  identityBinding: z.literal("telemetry-only"),
  observedAt: z.iso.datetime({ offset: true }),
  failureCodes: z.array(
    z
      .string()
      .regex(
        /^v2_monitor_(?:(?:definition_count_mismatch|evidence_unavailable|evidence_missing)|(?:definition_mismatch|progress_missing|run_stale_or_invalid|heartbeat_stale_or_invalid):(?:A|B|C-open|C-reopen|D|E|F|G))$/,
      ),
  ),
  streams: z.array(
    z.object({
      stream_id: z.enum(["A", "B", "C-open", "C-reopen", "D", "E", "F", "G"]),
      interval_seconds: z.number().int().positive(),
      on_demand: z.union([z.literal(0), z.literal(1)]),
      heartbeat_at: z.iso.datetime({ offset: true }).nullable(),
      status: z.enum(["running", "held", "completed", "failed"]).nullable(),
      started_at: z.iso.datetime({ offset: true }).nullable(),
      finished_at: z.iso.datetime({ offset: true }).nullable(),
    }),
  ),
});
