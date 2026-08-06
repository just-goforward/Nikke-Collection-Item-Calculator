import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { SOLVER_DIAGNOSTIC_VERSION } from "../shared/statsContract.ts";
import type { D1HpSnapshot, D1HpStratum, D1StockBucket } from "./min-ef-hp-d1.ts";
import { envValue } from "./runner-utils.ts";

const execute = promisify(execFile);
const DATABASE = envValue("HP_STUDY_D1_DATABASE") ?? "collection-kit-stats";
const QUERY_SINCE = envValue("HP_STUDY_D1_SINCE") ?? "0000-01-01";
const OUTPUT_FILE = new URL("./results/min-ef-hp-d1-snapshot.json", import.meta.url);
const SQL = `SELECT grade, level, exp_bucket, stock_bucket_blue, stock_bucket_purple, stock_bucket_yellow, SUM(events) AS events, MIN(date_key) AS first_date, MAX(date_key) AS last_date FROM solver_diagnostic_aggregates WHERE diagnostic_version = ${SOLVER_DIAGNOSTIC_VERSION} AND strategy = 'supply' AND date_key >= '${QUERY_SINCE.replaceAll("'", "''")}' GROUP BY grade, level, exp_bucket, stock_bucket_blue, stock_bucket_purple, stock_bucket_yellow ORDER BY events DESC`;

const wranglerEntry = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const { stdout } = await execute(
  process.execPath,
  [
    wranglerEntry,
    "d1",
    "execute",
    DATABASE,
    "--remote",
    "--config",
    "cloudflare/wrangler.toml",
    "--command",
    SQL,
    "--json",
  ],
  { cwd: process.cwd(), maxBuffer: 20 * 1024 * 1024 },
);
const payload = JSON.parse(stdout) as Array<{ results?: RawD1Row[] }>;
const rows = (payload[0]?.results ?? []).map(parseRow);
const normalizedRows = [...rows].sort((left, right) => right.events - left.events);
const resultJson = JSON.stringify(normalizedRows);
const snapshot: D1HpSnapshot = {
  kind: "min-ef-hp-d1-snapshot",
  version: 1,
  generatedAt: new Date().toISOString(),
  database: DATABASE,
  diagnosticVersion: SOLVER_DIAGNOSTIC_VERSION,
  querySince: QUERY_SINCE,
  sql: SQL,
  sqlHash: sha256(SQL),
  eventCount: normalizedRows.reduce((sum, row) => sum + row.events, 0),
  firstDate: normalizedRows.map((row) => row.firstDate).sort()[0] ?? null,
  lastDate:
    normalizedRows
      .map((row) => row.lastDate)
      .sort()
      .at(-1) ?? null,
  rows: normalizedRows,
  resultHash: sha256(resultJson),
};
await mkdir(new URL("./results/", import.meta.url), { recursive: true });
await writeFile(OUTPUT_FILE, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    {
      database: snapshot.database,
      diagnosticVersion: snapshot.diagnosticVersion,
      eventCount: snapshot.eventCount,
      rows: snapshot.rows.length,
      period: [snapshot.firstDate, snapshot.lastDate],
      sqlHash: snapshot.sqlHash,
      resultHash: snapshot.resultHash,
      output: OUTPUT_FILE.pathname,
    },
    null,
    2,
  ),
);

type RawD1Row = {
  grade?: unknown;
  level?: unknown;
  exp_bucket?: unknown;
  stock_bucket_blue?: unknown;
  stock_bucket_purple?: unknown;
  stock_bucket_yellow?: unknown;
  events?: unknown;
  first_date?: unknown;
  last_date?: unknown;
};

function parseRow(row: RawD1Row): D1HpStratum {
  if (row.grade !== "R" && row.grade !== "SR") {
    throw new Error("D1 snapshot has invalid grade.");
  }
  return {
    grade: row.grade,
    level: finiteInteger(row.level, "level"),
    expBucket: finiteInteger(row.exp_bucket, "exp_bucket"),
    stockBuckets: {
      blue: stockBucket(row.stock_bucket_blue),
      purple: stockBucket(row.stock_bucket_purple),
      yellow: stockBucket(row.stock_bucket_yellow),
    },
    events: finiteInteger(row.events, "events"),
    firstDate: String(row.first_date ?? ""),
    lastDate: String(row.last_date ?? ""),
  };
}

function finiteInteger(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`D1 snapshot has invalid ${name}.`);
  }
  return parsed;
}

function stockBucket(value: unknown): D1StockBucket {
  const bucket = String(value) as D1StockBucket;
  const allowed = new Set<D1StockBucket>([
    "0",
    "1_49",
    "50_99",
    "100_149",
    "150_199",
    "200_249",
    "250_299",
    "300_349",
    "350_399",
    "400_449",
    "450_499",
    "500_plus",
  ]);
  if (!allowed.has(bucket)) throw new Error(`D1 snapshot has invalid stock bucket ${bucket}.`);
  return bucket;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
