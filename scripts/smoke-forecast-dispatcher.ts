import { readFileSync } from "node:fs";
import { parseWranglerJson } from "./apply-forecast-d1-migrations.ts";

const [rawBaseUrl, outboxPath] = process.argv.slice(2);
if (!rawBaseUrl || !outboxPath)
  throw new Error("Usage: smoke-forecast-dispatcher <collector-url> <staging-outbox-json>");
const baseUrl = rawBaseUrl.replace(/\/$/, "");
const health = await requestJson(`${baseUrl}/health`);
if (
  !isRecord(health) ||
  health["status"] !== "ok" ||
  !isRecord(health["operations"]) ||
  !isRecord(health["operations"]["dispatcher"])
)
  throw new Error("Dispatcher storage health contract is invalid.");

const query = parseWranglerJson(readFileSync(outboxPath, "utf8"));
if (
  !Array.isArray(query) ||
  query.length !== 1 ||
  !isRecord(query[0]) ||
  query[0]["success"] !== true ||
  !Array.isArray(query[0]["results"])
)
  throw new Error("Staging outbox query failed.");
const rows: unknown[] = query[0]["results"];
if (rows.length !== 2) throw new Error("Staging outbox query is incomplete.");
const queues = new Set<string>();
for (const row of rows) {
  if (
    !isRecord(row) ||
    !["publication", "v2"].includes(String(row["queue"])) ||
    row["environment"] !== "staging" ||
    (row["state"] !== null &&
      !["pending", "sending", "sent", "dead"].includes(String(row["state"])))
  )
    throw new Error("Staging outbox query contract is invalid.");
  queues.add(String(row["queue"]));
}
if (queues.size !== 2) throw new Error("Staging outbox query contains duplicate queues.");
// This proves storage readiness, not message delivery. Scheduled execution and
// delivery remain covered by the workflow's live Observability/canary gates.
console.log(JSON.stringify({ status: "ok", environment: "staging", outboxTablesReadable: true }));

async function requestJson(url: string) {
  const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Dispatcher smoke endpoint returned ${response.status}.`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > 32_768)
    throw new Error("Smoke response is too large.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 32_768) throw new Error("Smoke response is too large.");
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
