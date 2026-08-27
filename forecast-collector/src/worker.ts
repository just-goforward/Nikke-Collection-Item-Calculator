import { runCollection } from "./collector";
import { timingSafeBearer } from "./crypto";
import {
  listProposalCandidates,
  markCandidateProposed,
  readCanaryReport,
  readHealth,
  supersedeIncompatibleCandidates,
} from "./db";
import { listSourceQueue, processSourceQueue, readScheduleLedger } from "./source-queue";
import type { CollectorEnv } from "./types";

export default {
  async scheduled(event, env, context) {
    context.waitUntil(runCollection(env, { nowMs: event.scheduledTime }));
  },

  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json(await readHealth(env.FORECAST_DB));
    }
    if (!url.pathname.startsWith("/admin/")) return new Response("Not found", { status: 404 });
    if (env.ADMIN_RATE_LIMITER) {
      const rateLimit = await env.ADMIN_RATE_LIMITER.limit({ key: "admin-api" });
      if (!rateLimit.success) {
        return new Response("Too many requests", { status: 429 });
      }
    } else if (env.ENVIRONMENT !== "test") {
      return new Response("Service unavailable", { status: 503 });
    }
    if (!(await timingSafeBearer(request, env.ADMIN_TOKEN))) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (request.method === "POST" && url.pathname === "/admin/probe") {
      const task = runCollection(env);
      context.waitUntil(task);
      return json(await task);
    }
    if (request.method === "GET" && url.pathname === "/admin/candidates") {
      return json({ candidates: await listProposalCandidates(env.FORECAST_DB) });
    }
    if (request.method === "POST" && url.pathname === "/admin/candidates/supersede-incompatible") {
      return json({ superseded: await supersedeIncompatibleCandidates(env.FORECAST_DB) });
    }
    if (request.method === "GET" && url.pathname === "/admin/source-queue") {
      const limit = Number(url.searchParams.get("limit") ?? 20);
      return json({ items: await listSourceQueue(env.FORECAST_DB, limit) });
    }
    if (request.method === "GET" && url.pathname === "/admin/schedule-ledger") {
      return json(await readScheduleLedger(env.FORECAST_DB, Date.now()));
    }
    if (request.method === "POST" && url.pathname === "/admin/source-queue/process") {
      const length = Number(request.headers.get("content-length") ?? 0);
      if (length > 1_000_000) return new Response("Payload too large", { status: 413 });
      try {
        return json(await processSourceQueue(env.FORECAST_DB, await request.json()));
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid_request";
        const status = message === "candidate_revision_conflict" ? 409 : 400;
        return json({ error: message.slice(0, 120) }, status);
      }
    }
    if (request.method === "GET" && url.pathname === "/admin/canary-report") {
      return json(await readCanaryReport(env.FORECAST_DB, Date.now(), env.DEPLOY_SHA));
    }
    const proposedMatch = url.pathname.match(
      /^\/admin\/candidates\/(forecast-[a-z0-9-]+)\/proposed$/,
    );
    if (request.method === "POST" && proposedMatch?.[1]) {
      const updated = await markCandidateProposed(env.FORECAST_DB, proposedMatch[1]);
      return json({ updated }, updated ? 200 : 409);
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<CollectorEnv>;

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}
