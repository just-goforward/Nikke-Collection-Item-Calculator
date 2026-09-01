import { createHash } from "node:crypto";

const baseUrl = required("FORECAST_COLLECTOR_URL").replace(/\/$/, "");
const token = required("FORECAST_COLLECTOR_ADMIN_TOKEN");
const reviewId = required("FORECAST_MANUAL_REVIEW_ID");
const decision = required("FORECAST_MANUAL_REVIEW_DECISION");
const reason = required("FORECAST_MANUAL_REVIEW_REASON");
const runId = Number(required("GITHUB_RUN_ID"));

if (!/^mr-[0-9a-f]{32}$/.test(reviewId)) throw new Error("Invalid manual review ID.");
if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error("Invalid GitHub run ID.");
if (decision !== "requeue" && decision !== "ignore" && decision !== "manual_event") {
  throw new Error("Invalid manual review decision.");
}
if (reason.length < 1 || reason.length > 240) throw new Error("Invalid manual review reason.");

const event =
  decision === "manual_event"
    ? {
        eventType: required("FORECAST_MANUAL_EVENT_TYPE"),
        startsAtKst: required("FORECAST_MANUAL_STARTS_AT_KST"),
        endsAtKst: optional("FORECAST_MANUAL_ENDS_AT_KST"),
        scheduleStatus: required("FORECAST_MANUAL_SCHEDULE_STATUS"),
      }
    : null;
const identity = JSON.stringify({ reviewId, decision, reason, event, runId });
const requestId = `mrq-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
const requestUrl = `${baseUrl}/admin/manual-reviews/${reviewId}/decision`;
const requestInit = {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    accept: "application/json",
    "content-type": "application/json",
  },
  body: JSON.stringify({ requestId, decision, reason, runId, event }),
} satisfies RequestInit;
const response = await postWithRetry(requestUrl, requestInit);
const text = await response.text();
if (!response.ok) {
  throw new Error(`Manual review decision failed with ${response.status}: ${text.slice(0, 240)}`);
}
let parsed: unknown;
try {
  parsed = JSON.parse(text) as unknown;
} catch {
  throw new Error("Manual review endpoint returned invalid JSON.");
}
console.log(JSON.stringify(parsed, null, 2));

async function postWithRetry(url: string, init: RequestInit) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
      if (response.status !== 429 && response.status < 500) return response;
      if (attempt === 2) return response;
      await response.body?.cancel();
    } catch (error) {
      lastError = error;
      if (attempt === 2) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
  }
  throw lastError instanceof Error ? lastError : new Error("Manual review request failed.");
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function optional(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : null;
}
