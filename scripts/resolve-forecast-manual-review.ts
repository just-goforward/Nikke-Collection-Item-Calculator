import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod/mini";

// CLI boundary mirrors the collector contract without importing Worker-only D1 modules.
const positive = z.number().check(z.int(), z.minimum(1));
const instant = z.string().check(z.iso.datetime({ offset: true }));
const hash = z.string().check(z.regex(/^[a-f0-9]{64}$/));
const binding = z.object({
  generation: z.number().check(z.int(), z.minimum(0)),
  sourceRevision: positive,
  contentHash: hash,
  revisionHash: hash,
  contextHash: hash,
});
const resolutionSchema = z.union([
  z.object({ kind: z.literal("suspend"), round: positive, cutoff: instant, binding }),
  z.object({ kind: z.literal("reopen"), round: positive, from: instant, until: instant, binding }),
  z.object({
    kind: z.literal("grant"),
    grantGameDate: z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/)),
    kits: z
      .array(
        z.object({
          law: z.enum(["box-ii-v1", "regular-box-v1"]),
          count: positive,
        }),
      )
      .check(z.minLength(1)),
    claimUntil: z.nullable(instant),
    binding,
  }),
  z.object({
    kind: z.literal("restatement"),
    targetGrantId: z.string().check(z.minLength(1)),
    binding,
  }),
]);

export function buildManualReviewRequest(env: NodeJS.ProcessEnv) {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing ${name}.`);
    return value;
  };
  const reviewId = required("FORECAST_MANUAL_REVIEW_ID");
  const decision = required("FORECAST_MANUAL_REVIEW_DECISION");
  const reason = required("FORECAST_MANUAL_REVIEW_REASON");
  const runId = Number(required("GITHUB_RUN_ID"));
  if (!/^mr-[0-9a-f]{32}$/.test(reviewId)) throw new Error("Invalid manual review ID.");
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error("Invalid GitHub run ID.");
  if (!["requeue", "ignore", "manual_event"].includes(decision))
    throw new Error("Invalid manual review decision.");
  if (reason.length > 240) throw new Error("Invalid manual review reason.");
  const resolution = parseTypedResolution(env, decision);
  const event =
    decision === "manual_event" && !resolution
      ? {
          eventType: required("FORECAST_MANUAL_EVENT_TYPE"),
          startsAtKst: required("FORECAST_MANUAL_STARTS_AT_KST"),
          endsAtKst: env["FORECAST_MANUAL_ENDS_AT_KST"]?.trim() || null,
          scheduleStatus: required("FORECAST_MANUAL_SCHEDULE_STATUS"),
        }
      : null;
  const typed = resolution ? { resolution } : {};
  const identity = JSON.stringify({ reviewId, decision, reason, event, runId, ...typed });
  const requestId = `mrq-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
  return { reviewId, body: { requestId, decision, reason, runId, event, ...typed } };
}

function parseTypedResolution(env: NodeJS.ProcessEnv, decision: string) {
  const raw = env["FORECAST_MANUAL_TYPED_RESOLUTION"]?.trim();
  let resolution: z.infer<typeof resolutionSchema> | undefined;
  if (raw) {
    if (decision !== "manual_event") throw new Error("Typed resolution requires manual_event.");
    try {
      resolution = resolutionSchema.parse(JSON.parse(raw));
      if (
        resolution.kind === "reopen" &&
        Date.parse(resolution.until) <= Date.parse(resolution.from)
      )
        throw new Error("range");
      if (resolution.kind === "grant") {
        const date = Date.parse(`${resolution.grantGameDate}T00:00:00Z`);
        if (
          !Number.isFinite(date) ||
          new Date(date).toISOString().slice(0, 10) !== resolution.grantGameDate
        )
          throw new Error("date");
      }
    } catch {
      throw new Error("Invalid typed manual review resolution.");
    }
  }
  return resolution;
}

function collectorConnection(env: NodeJS.ProcessEnv, reviewId: string) {
  const base = env["FORECAST_COLLECTOR_URL"]?.trim();
  const token = env["FORECAST_COLLECTOR_ADMIN_TOKEN"]?.trim();
  if (!base || !token) throw new Error("Missing collector connection settings.");
  let url: URL;
  try {
    url = new URL(`${base.replace(/\/$/, "")}/admin/manual-reviews/${reviewId}/decision`);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw new Error("url");
  } catch {
    throw new Error("Invalid collector URL.");
  }
  return { url, token };
}

export async function resolveManualReview(env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch) {
  const { reviewId, body } = buildManualReviewRequest(env);
  const { url, token } = collectorConnection(env, reviewId);
  const init: RequestInit = {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
  let response: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await fetcher(url, { ...init, signal: AbortSignal.timeout(20_000) });
      if (response.status !== 429 && response.status < 500) break;
      if (attempt === 0) await response.body?.cancel();
    } catch {
      if (attempt === 1) throw new Error("Manual review request failed.");
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!response?.ok)
    throw new Error(`Manual review decision failed with status ${response?.status ?? "unknown"}.`);
  try {
    await response.json();
  } catch {
    throw new Error("Manual review endpoint returned invalid JSON.");
  }
  // Do not log the request, server response, token, or source/review binding contents.
  return { ok: true, requestId: body.requestId, decision: body.decision };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(await resolveManualReview(process.env)));
