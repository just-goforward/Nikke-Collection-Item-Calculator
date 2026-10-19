import {
  assertForecastCandidateInvariants,
  supplyForecastCandidateSchema,
} from "../../shared/supplyForecastCandidate";
import { sha256Hex, stableJson } from "./crypto";
import { streams } from "./v2/ingest/schedule";

type MonitorRow = {
  stream_id: string;
  interval_seconds: number;
  on_demand: number;
  heartbeat_at: string | null;
  run_id: string | null;
  status: string | null;
  started_at: string | null;
  finished_at: string | null;
};

export type MonitorProgress = {
  valid: boolean;
  identityBinding: "telemetry-only";
  observedAt: string;
  failureCodes: string[];
  streams: MonitorRow[];
};

export async function readV2MonitorProgress(
  db: D1Database,
  startedAt: string,
  nowMs: number,
): Promise<MonitorProgress> {
  // These existing tables have no deployment/version column. D1 proves current
  // monitor progress only; deployed-version identity comes exclusively from
  // independently validated Cloudflare scheduled telemetry, never invented slots.
  const base = {
    identityBinding: "telemetry-only" as const,
    observedAt: new Date(nowMs).toISOString(),
  };
  try {
    const { results } = await db
      .prepare(`SELECT m.stream_id,m.interval_seconds,m.on_demand,
        strftime('%Y-%m-%dT%H:%M:%fZ',s.updated_at) AS heartbeat_at,
        r.run_id,r.status,
        strftime('%Y-%m-%dT%H:%M:%fZ',r.started_at) AS started_at,
        strftime('%Y-%m-%dT%H:%M:%fZ',r.finished_at) AS finished_at
        FROM forecast_v2_monitors m
        LEFT JOIN forecast_v2_monitor_state s USING(stream_id)
        LEFT JOIN forecast_v2_monitor_runs r ON r.run_id=(
          SELECT run_id FROM forecast_v2_monitor_runs
          WHERE stream_id=m.stream_id ORDER BY generation DESC,kind DESC LIMIT 1
        ) ORDER BY m.stream_id`)
      .all<MonitorRow>();
    const failureCodes = monitorFailures(results, Date.parse(startedAt), nowMs);
    return { ...base, valid: failureCodes.length === 0, failureCodes, streams: results };
  } catch {
    return {
      ...base,
      valid: false,
      failureCodes: ["v2_monitor_evidence_unavailable"],
      streams: [],
    };
  }
}

function monitorFailures(rows: MonitorRow[], startedMs: number, nowMs: number) {
  const failures: string[] = [];
  if (rows.length !== Object.keys(streams).length)
    failures.push("v2_monitor_definition_count_mismatch");
  for (const id of Object.keys(streams)) {
    const row = rows.find((entry) => entry.stream_id === id);
    const interval = id === "G" ? 1800 : 3600;
    if (!row || row.interval_seconds !== interval || row.on_demand !== (id === "E" ? 1 : 0)) {
      failures.push(`v2_monitor_definition_mismatch:${id}`);
      continue;
    }
    // Freshness/completed-run requirements apply only to periodic streams.
    // On-demand E requires an existing non-future heartbeat, not completed follow-ups.
    if (id === "E") {
      if (!row.heartbeat_at || Date.parse(row.heartbeat_at) > nowMs)
        failures.push("v2_monitor_heartbeat_stale_or_invalid:E");
      continue;
    }
    failures.push(...progressFailures(row, startedMs, nowMs));
  }
  return failures;
}

function progressFailures(row: MonitorRow, startedMs: number, nowMs: number) {
  // One configured monitor interval plus one three-minute collector Cron slot.
  const maxAge = row.interval_seconds * 1000 + 180_000;
  return [
    row.status === "failed" ? `v2_monitor_run_failed:${row.stream_id}` : null,
    !row.run_id || row.status !== "completed"
      ? `v2_monitor_progress_missing:${row.stream_id}`
      : null,
    invalidRun(row, startedMs, nowMs, maxAge)
      ? `v2_monitor_run_stale_or_invalid:${row.stream_id}`
      : null,
    invalidHeartbeat(row, nowMs, maxAge)
      ? `v2_monitor_heartbeat_stale_or_invalid:${row.stream_id}`
      : null,
  ].filter((value): value is string => value !== null);
}

function invalidRun(row: MonitorRow, startedMs: number, nowMs: number, maxAge: number) {
  const began = Date.parse(row.started_at ?? "");
  const finished = Date.parse(row.finished_at ?? "");
  return (
    !Number.isFinite(began) ||
    !Number.isFinite(finished) ||
    began < startedMs ||
    finished < began ||
    finished > nowMs ||
    nowMs - finished > maxAge
  );
}

function invalidHeartbeat(row: MonitorRow, nowMs: number, maxAge: number) {
  const heartbeat = Date.parse(row.heartbeat_at ?? "");
  return (
    !Number.isFinite(heartbeat) ||
    heartbeat < Date.parse(row.finished_at ?? "") ||
    heartbeat > nowMs ||
    nowMs - heartbeat > maxAge
  );
}

export async function readV2CandidateIntegrity(db: D1Database) {
  const rows = await db
    .prepare(`SELECT payload_json,payload_hash FROM forecast_candidates
      WHERE state NOT IN ('approved','rejected','superseded')`)
    .all<{ payload_json: string; payload_hash: string }>();
  let candidates = 0;
  for (const row of rows.results) {
    try {
      const candidate = supplyForecastCandidateSchema.parse(JSON.parse(row.payload_json));
      assertForecastCandidateInvariants(candidate);
      if ((await sha256Hex(stableJson(candidate))) !== row.payload_hash) candidates += 1;
    } catch {
      candidates += 1;
    }
  }
  return { candidates, totalInvalid: candidates };
}
