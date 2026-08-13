import { D1_SCHEMA_CONTRACT_VERSION, REQUIRED_D1_SCHEMA } from "../../shared/d1SchemaContract";
import type { WorkerEnv } from "./env";
import { isAllowedOrigin, jsonResponse } from "./http";
import { HttpError } from "./http-error";

export async function handleSchemaHealth(request: Request, env: WorkerEnv) {
  if (!isAllowedOrigin(request, env)) throw new HttpError(403, "origin_not_allowed");
  if (!env.DB) throw new HttpError(500, "database_not_configured");

  const probes = Object.entries(REQUIRED_D1_SCHEMA).map(([table, columns]) =>
    env.DB.prepare(`SELECT ${columns.join(", ")} FROM ${table} LIMIT 0`),
  );
  try {
    await env.DB.batch(probes);
  } catch (error) {
    void error;
    throw new HttpError(503, "database_schema_not_ready", true);
  }

  return jsonResponse(request, env, {
    ok: true,
    schemaContractVersion: D1_SCHEMA_CONTRACT_VERSION,
  });
}
