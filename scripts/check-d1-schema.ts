import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  type D1SchemaRow,
  REQUIRED_D1_SCHEMA,
  validateD1SchemaRows,
} from "../shared/d1SchemaContract.ts";

function schemaQuery() {
  const tables = Object.keys(REQUIRED_D1_SCHEMA)
    .map((table) => `'${table}'`)
    .join(", ");
  return `SELECT m.name AS table_name, p.name AS column_name,
       p.pk AS primary_key_position
FROM sqlite_master AS m
JOIN pragma_table_info(m.name) AS p
WHERE m.type = 'table' AND m.name IN (${tables})
ORDER BY m.name, p.cid`;
}

function readRows(output: string): D1SchemaRow[] {
  const payload = JSON.parse(output) as Array<{ results?: unknown }>;
  const rows = payload[0]?.results;
  if (!Array.isArray(rows)) throw new Error("Wrangler did not return D1 schema rows.");
  return rows as D1SchemaRow[];
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
