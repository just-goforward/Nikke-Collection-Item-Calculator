import { z } from "zod/mini";

export const D1_FREE_LIMITS = {
  rowsRead: 5_000_000,
  rowsWritten: 100_000,
} as const;

export const D1_CANARY_THRESHOLDS = {
  maximumProjectedRowsRead: 3_000_000,
  maximumProjectedRowsWritten: 60_000,
  maximumCanaryRowsRead: 250_000,
  maximumCanaryRowsWritten: 10_000,
  minimumStatsRowsReadReserve: 1_000_000,
  minimumStatsRowsWrittenReserve: 30_000,
  statsP95ReserveMultiplier: 3,
  burnInMinutes: 30,
} as const;

export const D1_DATABASE_IDS = {
  statsProduction: "3e18385a-af83-4c67-83a0-ab889149692c",
  statsStaging: "95f4029b-669a-4e1e-a192-5c094e659e33",
  forecastProduction: "2d58bcc0-a7b5-43f3-8f42-34e1bf1ff853",
  forecastStaging: "49b5dc06-37ae-4245-896c-daea98562ed8",
} as const;

const timestampSchema = z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/));
const dateSchema = z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/));
const countSchema = z.number().check(z.int(), z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER));
const roleSchema = z.enum([
  "stats-production",
  "stats-staging",
  "forecast-production",
  "forecast-staging",
  "other",
]);

const databaseEvidenceSchema = z.object({
  databaseId: z.string().check(z.minLength(1), z.maxLength(80)),
  databaseName: z.string().check(z.minLength(1), z.maxLength(128)),
  role: roleSchema,
  rowsReadObserved: countSchema,
  rowsWrittenObserved: countSchema,
  rowsReadP95: countSchema,
  rowsWrittenP95: countSchema,
  rowsReadProjected: countSchema,
  rowsWrittenProjected: countSchema,
});

export const d1QuotaEvidenceSchema = z.object({
  version: z.literal(1),
  source: z.literal("cloudflare-graphql-d1-analytics-v1"),
  billingDay: dateSchema,
  observedAt: timestampSchema,
  burnIn: z.object({
    startedAt: timestampSchema,
    endedAt: timestampSchema,
    durationMinutes: z.number().check(z.minimum(D1_CANARY_THRESHOLDS.burnInMinutes)),
  }),
  limits: z.object({
    rowsRead: z.literal(D1_FREE_LIMITS.rowsRead),
    rowsWritten: z.literal(D1_FREE_LIMITS.rowsWritten),
  }),
  thresholds: z.object({
    maximumProjectedRowsRead: z.literal(D1_CANARY_THRESHOLDS.maximumProjectedRowsRead),
    maximumProjectedRowsWritten: z.literal(D1_CANARY_THRESHOLDS.maximumProjectedRowsWritten),
    maximumCanaryRowsRead: z.literal(D1_CANARY_THRESHOLDS.maximumCanaryRowsRead),
    maximumCanaryRowsWritten: z.literal(D1_CANARY_THRESHOLDS.maximumCanaryRowsWritten),
    minimumStatsRowsReadReserve: z.literal(D1_CANARY_THRESHOLDS.minimumStatsRowsReadReserve),
    minimumStatsRowsWrittenReserve: z.literal(D1_CANARY_THRESHOLDS.minimumStatsRowsWrittenReserve),
    statsP95ReserveMultiplier: z.literal(D1_CANARY_THRESHOLDS.statsP95ReserveMultiplier),
    burnInMinutes: z.literal(D1_CANARY_THRESHOLDS.burnInMinutes),
  }),
  account: z.object({
    rowsReadObserved: countSchema,
    rowsWrittenObserved: countSchema,
    rowsReadProjected: countSchema,
    rowsWrittenProjected: countSchema,
  }),
  canary: z.object({
    databaseId: z.literal(D1_DATABASE_IDS.forecastStaging),
    rowsReadBurnIn: countSchema,
    rowsWrittenBurnIn: countSchema,
    rowsReadProjected: countSchema,
    rowsWrittenProjected: countSchema,
  }),
  statsProduction: z.object({
    databaseId: z.literal(D1_DATABASE_IDS.statsProduction),
    rowsReadP95: countSchema,
    rowsWrittenP95: countSchema,
    rowsReadReserve: countSchema,
    rowsWrittenReserve: countSchema,
  }),
  databases: z.array(databaseEvidenceSchema).check(z.minLength(4), z.maxLength(100)),
  passed: z.literal(true),
});

export type D1QuotaEvidence = z.infer<typeof d1QuotaEvidenceSchema>;
export type D1DatabaseEvidence = D1QuotaEvidence["databases"][number];

export function assertD1QuotaEvidence(value: unknown): D1QuotaEvidence {
  const evidence = d1QuotaEvidenceSchema.parse(value);
  assertEvidenceTime(evidence);
  assertDatabaseIdentity(evidence);
  assertAccountTotals(evidence);
  assertStatsReserve(evidence);
  assertProjectedUsage(evidence);
  return evidence;
}

function assertEvidenceTime(evidence: D1QuotaEvidence) {
  const startedAt = Date.parse(evidence.burnIn.startedAt);
  const endedAt = Date.parse(evidence.burnIn.endedAt);
  const observedAt = Date.parse(evidence.observedAt);
  if (!(startedAt < endedAt && endedAt <= observedAt)) {
    throw new Error("d1_quota_evidence_time_order_invalid");
  }
  const durationMinutes = (endedAt - startedAt) / 60_000;
  if (Math.abs(durationMinutes - evidence.burnIn.durationMinutes) > 1 / 60) {
    throw new Error("d1_quota_evidence_duration_invalid");
  }
  if (
    utcDate(startedAt) !== evidence.billingDay ||
    utcDate(endedAt) !== evidence.billingDay ||
    utcDate(observedAt) !== evidence.billingDay
  ) {
    throw new Error("d1_quota_evidence_billing_day_invalid");
  }
}

function assertDatabaseIdentity(evidence: D1QuotaEvidence) {
  const ids = new Set(evidence.databases.map((database) => database.databaseId));
  if (ids.size !== evidence.databases.length) {
    throw new Error("d1_quota_evidence_duplicate_database");
  }
  for (const role of Object.keys(D1_DATABASE_IDS) as Array<keyof typeof D1_DATABASE_IDS>) {
    const databaseId = D1_DATABASE_IDS[role];
    const normalizedRole = camelRoleToKebab(role);
    const matches = evidence.databases.filter(
      (database) => database.databaseId === databaseId && database.role === normalizedRole,
    );
    if (matches.length !== 1) throw new Error(`d1_quota_evidence_${normalizedRole}_missing`);
  }
}

function assertAccountTotals(evidence: D1QuotaEvidence) {
  assertEqual(
    evidence.account.rowsReadObserved,
    sum(evidence.databases, "rowsReadObserved"),
    "d1_quota_evidence_observed_reads_mismatch",
  );
  assertEqual(
    evidence.account.rowsWrittenObserved,
    sum(evidence.databases, "rowsWrittenObserved"),
    "d1_quota_evidence_observed_writes_mismatch",
  );
  assertEqual(
    evidence.account.rowsReadProjected,
    sum(evidence.databases, "rowsReadProjected"),
    "d1_quota_evidence_projected_reads_mismatch",
  );
  assertEqual(
    evidence.account.rowsWrittenProjected,
    sum(evidence.databases, "rowsWrittenProjected"),
    "d1_quota_evidence_projected_writes_mismatch",
  );
}

function assertStatsReserve(evidence: D1QuotaEvidence) {
  const stats = evidence.databases.find(
    (database) => database.databaseId === D1_DATABASE_IDS.statsProduction,
  );
  if (!stats) throw new Error("d1_quota_evidence_stats_production_missing");
  assertEqual(
    evidence.statsProduction.rowsReadP95,
    stats.rowsReadP95,
    "d1_quota_evidence_stats_read_p95_mismatch",
  );
  assertEqual(
    evidence.statsProduction.rowsWrittenP95,
    stats.rowsWrittenP95,
    "d1_quota_evidence_stats_write_p95_mismatch",
  );

  const requiredReadReserve = Math.max(
    evidence.thresholds.minimumStatsRowsReadReserve,
    evidence.statsProduction.rowsReadP95 * evidence.thresholds.statsP95ReserveMultiplier,
  );
  const requiredWriteReserve = Math.max(
    evidence.thresholds.minimumStatsRowsWrittenReserve,
    evidence.statsProduction.rowsWrittenP95 * evidence.thresholds.statsP95ReserveMultiplier,
  );
  if (evidence.statsProduction.rowsReadReserve < requiredReadReserve) {
    throw new Error("d1_quota_evidence_stats_read_reserve_insufficient");
  }
  if (evidence.statsProduction.rowsWrittenReserve < requiredWriteReserve) {
    throw new Error("d1_quota_evidence_stats_write_reserve_insufficient");
  }
}

function assertProjectedUsage(evidence: D1QuotaEvidence) {
  if (
    evidence.account.rowsReadProjected > evidence.thresholds.maximumProjectedRowsRead ||
    evidence.account.rowsWrittenProjected > evidence.thresholds.maximumProjectedRowsWritten
  ) {
    throw new Error("d1_quota_evidence_account_projection_exceeded");
  }
  if (
    evidence.canary.rowsReadProjected > evidence.thresholds.maximumCanaryRowsRead ||
    evidence.canary.rowsWrittenProjected > evidence.thresholds.maximumCanaryRowsWritten
  ) {
    throw new Error("d1_quota_evidence_canary_projection_exceeded");
  }
  if (
    evidence.limits.rowsRead - evidence.account.rowsReadProjected <
      evidence.statsProduction.rowsReadReserve ||
    evidence.limits.rowsWritten - evidence.account.rowsWrittenProjected <
      evidence.statsProduction.rowsWrittenReserve
  ) {
    throw new Error("d1_quota_evidence_stats_reserve_not_preserved");
  }
}

function utcDate(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function camelRoleToKebab(role: keyof typeof D1_DATABASE_IDS): D1DatabaseEvidence["role"] {
  return role.replace(/[A-Z]/g, (value) => `-${value.toLowerCase()}`) as D1DatabaseEvidence["role"];
}

function sum(
  databases: D1DatabaseEvidence[],
  field: "rowsReadObserved" | "rowsWrittenObserved" | "rowsReadProjected" | "rowsWrittenProjected",
) {
  return databases.reduce((total, database) => total + database[field], 0);
}

function assertEqual(actual: number, expected: number, code: string) {
  if (actual !== expected) throw new Error(code);
}
