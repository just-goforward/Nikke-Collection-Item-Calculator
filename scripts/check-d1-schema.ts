import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { REQUIRED_D1_SCHEMA } from "../shared/d1SchemaContract.ts";

type SchemaRow = { column_name?: unknown; table_name?: unknown };

export function validateD1SchemaRows(rows: SchemaRow[]) {
  const actual = new Map<string, Set<string>>();
  for (const row of rows) {
    if (typeof row.table_name !== "string" || typeof row.column_name !== "string") continue;
    const columns = actual.get(row.table_name) ?? new Set<string>();
    columns.add(row.column_name);
    actual.set(row.table_name, columns);
  }

  const failures: string[] = [];
  for (const [table, requiredColumns] of Object.entries(REQUIRED_D1_SCHEMA)) {
    const columns = actual.get(table);
    if (!columns) {
      failures.push(`missing table: ${table}`);
      continue;
    }
    for (const column of requiredColumns) {
      if (!columns.has(column)) failures.push(`missing column: ${table}.${column}`);
    }
  }
  return failures;
}

function schemaQuery() {
  const tables = Object.keys(REQUIRED_D1_SCHEMA)
    .map((table) => `'${table}'`)
    .join(", ");
  return `SELECT m.name AS table_name, p.name AS column_name
FROM sqlite_master AS m
JOIN pragma_table_info(m.name) AS p
WHERE m.type = 'table' AND m.name IN (${tables})
ORDER BY m.name, p.cid`;
}

function readRows(output: string): SchemaRow[] {
  const payload = JSON.parse(output) as Array<{ results?: unknown }>;
  const rows = payload[0]?.results;
  if (!Array.isArray(rows)) throw new Error("Wrangler did not return D1 schema rows.");
  return rows as SchemaRow[];
}

function run() {
  const args = process.argv.slice(2);
  const database = args.shift();
  if (!database) {
    throw new Error("Usage: npm run check:d1-schema -- <database-name> [staging] [local]");
  }
  const local = args.includes("local") || args.includes("--local");
  const envIndex = args.indexOf("--env");
  const positionalEnvironment = args.find((value) => value !== "local" && value !== "--local");
  const environment = envIndex >= 0 ? args[envIndex + 1] : positionalEnvironment;
  if (envIndex >= 0 && !environment) throw new Error("--env requires a value.");

  const command = process.execPath;
  const wranglerArgs = [
    "node_modules/wrangler/bin/wrangler.js",
    "d1",
    "execute",
    database,
    local ? "--local" : "--remote",
    "--json",
    "--config",
    "cloudflare/wrangler.toml",
    "--env",
    environment ?? "",
    "--command",
    schemaQuery(),
  ];
  const result = spawnSync(command, wranglerArgs, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "Wrangler D1 schema query failed.");
  }
  const failures = validateD1SchemaRows(readRows(result.stdout));
  if (failures.length > 0) {
    throw new Error(`D1 schema contract failed:\n- ${failures.join("\n- ")}`);
  }
  console.log(`D1 schema contract passed for ${database}${local ? " (local)" : " (remote)"}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
