import { z } from "zod";
export const role = z.enum(["collector", "dispatcher"]);
export const roleEvidence = z.object({
  collector: z.enum(["provided", "missing", "invalid", "incomplete"]),
  dispatcher: z.enum(["provided", "missing", "invalid", "incomplete"]),
});
export const snapshotSchema = z.object({
  registry: z.unknown().optional(),
  errors: z.partialRecord(role, z.string()),
  epochComparison: z.enum(["unavailable", "compared"]),
  budgetStop: z.boolean(),
  priorRequestEvidence: roleEvidence,
  evidenceIssues: z.partialRecord(role, z.string()).optional(),
  epochIssue: z.string().optional(),
  epochBaseline: z.number().int().positive().optional(),
  snapshotMissing: z.boolean().optional(),
});
export const resultSchema = z.object({
  role,
  state: z.enum(["verified", "idle", "failed", "unknown"]),
  requestResolved: z.boolean(),
  currentVerified: z.boolean(),
  evidence: z.enum(["preserved", "missing", "not_requested"]),
  reason: z.string(),
  requestId: z.uuid().optional(),
  corrected: z.boolean().optional(),
  purpose: z.enum(["budget", "hold", "readonly"]).optional(),
  historyTrusted: z.boolean().optional(),
  priorUnresolved: z.boolean().optional(),
  registry: z.unknown().optional(),
  epochComparison: z.enum(["unavailable", "compared"]).optional(),
  snapshotMissing: z.boolean().optional(),
  diagnostics: z.array(z.string()).optional(),
});
