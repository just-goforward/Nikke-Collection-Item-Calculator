import {
  D1_SCHEMA_CONTRACT_VERSION,
  type D1SchemaRow,
  REQUIRED_D1_SCHEMA,
  validateD1SchemaRows,
} from "../../shared/d1SchemaContract";
import type { WorkerEnv } from "./env";
import { isAllowedOrigin, jsonResponse } from "./http";
import { HttpError } from "./http-error";
import { assertQuotaAllows } from "./quota-guard";

export async function handleSchemaHealth(request: Request, env: WorkerEnv) {
  if (!isAllowedOrigin(request, env)) throw new HttpError(403, "origin_not_allowed");
  if (!env.DB) throw new HttpError(500, "database_not_configured");
  await assertQuotaAllows(env, "admin_read");

  const tables = Object.keys(REQUIRED_D1_SCHEMA);
  const probes = tables.map((table) =>
    env.DB.prepare(
      `SELECT name AS column_name, pk AS primary_key_position FROM pragma_table_info('${table}')`,
    ),
  );
  try {
    const results = await env.DB.batch<D1SchemaRow>(probes);
    const rows = results.flatMap((result, index) => {
      const table = tables[index];
      return (result.results || []).map((row) => ({ ...row, table_name: table }));
    });
    if (validateD1SchemaRows(rows).length > 0) {
      throw new Error("D1 schema contract mismatch");
    }
  } catch (error) {
    void error;
    throw new HttpError(503, "database_schema_not_ready", true);
  }

  return jsonResponse(request, env, {
    ok: true,
    schemaContractVersion: D1_SCHEMA_CONTRACT_VERSION,
  });
}
