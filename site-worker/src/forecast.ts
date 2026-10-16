import { publicationWire } from "../../shared/forecast-publication/consumer-wire";
import { ARTIFACT_DOMAIN, type PublicationEnvelope } from "../../shared/forecastPublication";
import { type PublicationBytes, publicationBytesHash } from "../../shared/forecastPublicationBytes";
import {
  assertUsageAllowed,
  effectiveUsageGuardAction,
  operationAllowed,
  type UsageGuardState,
} from "../../shared/usageGuard";

// Consumer capabilities deliberately exclude run/batch/exec and SQL parameters.
// These bindings are not database-level read-only grants.
type Reader = { prepare(sql: string): { first<T>(): Promise<T | null> } };
type Database = { withSession(constraint: "first-primary"): Reader };
export type ForecastEnv = {
  SITE_ENV?: string;
  FORECAST_RUNTIME_MODE?: string;
  FORECAST_DB?: Database;
  USAGE_GUARD_DB?: Database;
  FORECAST_RATE_LIMITER?: { limit(input: { key: string }): Promise<{ success: boolean }> };
};

// One singleton read joins the immutable approval and sealed candidate consistently.
// No request field (including query parameters) can become SQL.
const ACTIVE_SQL = `SELECT p.environment,p.sequence,p.signed_pointer_json,
  a.candidate_id,a.payload_hash,a.key_id,a.artifact_signature,
  c.payload_json,v.payload_hash AS sealed_hash
  FROM forecast_runtime_active p
  LEFT JOIN forecast_runtime_approvals a
    ON a.candidate_id=p.candidate_id AND a.environment=p.environment
  LEFT JOIN forecast_candidates c ON c.candidate_id=a.candidate_id
  LEFT JOIN forecast_runtime_versions v ON v.candidate_id=a.candidate_id
  WHERE p.singleton=1 LIMIT 1`;
type Active = {
  environment: string;
  sequence: number;
  signed_pointer_json: string | null;
  candidate_id: string | null;
  payload_hash: string | null;
  key_id: string | null;
  artifact_signature: string | null;
  payload_json: string | null;
  sealed_hash: string | null;
};
type Entry = { expiresAt: number } & (
  | { wire: PublicationBytes; guard: UsageGuardState }
  | { wire: null; guard: null }
);

/** At most one publication per binding/isolate; no stale-while-revalidate.
 * The guard and pointer share the SAME non-sliding 60-second primary-read deadline.
 * New stops/approvals/rollbacks become observable within that deadline; no browser
 * or CDN cache is allowed to extend it. Guard age/period are rechecked on cache hits.
 */
export function createForecastEndpoint(now = Date.now) {
  const cache = new WeakMap<
    Database,
    { guardDb: Database; value?: Entry; pending?: Promise<Entry> }
  >();
  async function load(db: Database, guardDb: Database): Promise<Entry> {
    const expiresAt = now() + 60_000;
    const guard = await assertUsageAllowed(
      guardDb.withSession("first-primary"),
      "staging_automation",
      now(),
    );
    const row = await db.withSession("first-primary").prepare(ACTIVE_SQL).first<Active>();
    if (!row || row.environment !== "staging" || !row.sequence || !row.signed_pointer_json)
      throw new Error("forecast_pointer_missing");
    const pointer: PublicationEnvelope["pointer"] = JSON.parse(row.signed_pointer_json);
    if (pointer.statement.environment !== "staging" || pointer.statement.sequence !== row.sequence)
      throw new Error("forecast_pointer_mismatch");
    let artifact: PublicationEnvelope["artifact"] = null;
    if (pointer.statement.mode === "active") {
      if (
        !row.payload_json ||
        !row.candidate_id ||
        !row.key_id ||
        !row.artifact_signature ||
        !row.payload_hash ||
        row.payload_hash !== row.sealed_hash ||
        row.payload_hash !== pointer.statement.contentHash ||
        row.candidate_id !== pointer.statement.candidateId
      )
        throw new Error("forecast_artifact_missing");
      artifact = {
        candidate: JSON.parse(row.payload_json),
        authorization: {
          statement: {
            domain: ARTIFACT_DOMAIN,
            environment: "staging",
            keyId: row.key_id,
            candidateId: row.candidate_id,
            contentHash: row.payload_hash,
          },
          signature: row.artifact_signature,
        },
      };
    } else if (
      pointer.statement.mode !== "off" ||
      pointer.statement.candidateId !== null ||
      pointer.statement.contentHash !== null
    )
      throw new Error("forecast_invalid_off");
    const wire = publicationWire({ pointer, artifact });
    if (wire.artifact && (await publicationBytesHash(wire.artifact.candidate)) !== row.payload_hash)
      throw new Error("forecast_hash_mismatch");
    if (now() >= expiresAt) throw new Error("forecast_expired");
    return { expiresAt, wire, guard };
  }

  return async (request: Request, env: ForecastEnv): Promise<Response> => {
    const respond = (body: unknown, status = 200) =>
      Response.json(body, {
        status,
        headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
      });
    if (request.method !== "GET") return respond({ error: "method_not_allowed" }, 405);
    const db = env.FORECAST_DB;
    const guardDb = env.USAGE_GUARD_DB;
    if (
      env.SITE_ENV !== "staging" ||
      env.FORECAST_RUNTIME_MODE !== "enabled" ||
      !db ||
      !guardDb ||
      !env.FORECAST_RATE_LIMITER
    )
      return respond({ error: "forecast_disabled" }, 503);
    try {
      const ip = request.headers.get("CF-Connecting-IP");
      if (!ip || !(await env.FORECAST_RATE_LIMITER.limit({ key: ip })).success)
        return respond({ error: "forecast_rate_limited" }, 429);
      let cell = cache.get(db);
      if (!cell || cell.guardDb !== guardDb) {
        cell = { guardDb };
        cache.set(db, cell);
      }
      if (!cell.value || now() >= cell.value.expiresAt) {
        delete cell.value;
        const target = cell;
        const expiresAt = now() + 60_000;
        target.pending ??= load(db, guardDb)
          .catch((): Entry => ({ expiresAt, wire: null, guard: null }))
          .then((entry) => {
            target.value = entry;
            return entry;
          })
          .finally(() => {
            delete target.pending;
          });
        await target.pending;
      }
      const entry = cell.value;
      if (
        !entry ||
        entry.guard === null ||
        now() >= entry.expiresAt ||
        !operationAllowed(effectiveUsageGuardAction(entry.guard, now()), "staging_automation")
      )
        throw new Error("forecast_unavailable");
      return respond({
        pointer: entry.wire.pointer,
        ...(new URL(request.url).pathname === "/api/forecast"
          ? { artifact: entry.wire.artifact }
          : {}),
        remainingMs: entry.expiresAt - now(),
      });
    } catch {
      return respond({ error: "forecast_unavailable" }, 503);
    }
  };
}
