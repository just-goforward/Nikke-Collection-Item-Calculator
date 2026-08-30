import { runCollection } from "./collector";
import { timingSafeBearer } from "./crypto";
import {
  listProposalCandidates,
  markCandidateProposed,
  readCanaryReport,
  readHealth,
  supersedeIncompatibleCandidates,
} from "./db";
import {
  createDiscordApprovalTest,
  createDiscordStagingAdoption,
  handleDiscordInteraction,
  listApprovedDiscordStagingAdoptions,
  markDiscordStagingAdoptionProcessed,
  recordDiscordStagingAdoptionMessage,
} from "./discord-approval";
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
    if (request.method === "POST" && url.pathname === "/discord/interactions") {
      if (env.ADMIN_RATE_LIMITER) {
        const sourceAddress = request.headers.get("cf-connecting-ip") ?? "unknown";
        const rateLimit = await env.ADMIN_RATE_LIMITER.limit({
          key: `discord-interactions:${sourceAddress}`,
        });
        if (!rateLimit.success) return new Response("Too many requests", { status: 429 });
      } else if (env.ENVIRONMENT !== "test") {
        return new Response("Service unavailable", { status: 503 });
      }
      return handleDiscordInteraction(request, env, context);
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
    if (request.method === "POST" && url.pathname === "/admin/discord-test-approvals") {
      if (
        env.ENVIRONMENT === "production" ||
        (env.DISCORD_APPROVAL_MODE !== "test" && env.DISCORD_APPROVAL_MODE !== "staging_adoption")
      ) {
        return new Response("Not found", { status: 404 });
      }
      const length = Number(request.headers.get("content-length") ?? 0);
      if (length > 32_768) return new Response("Payload too large", { status: 413 });
      try {
        return json(await createDiscordApprovalTest(env.FORECAST_DB, await request.json()));
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid_request";
        const status = message === "discord_test_request_key_conflict" ? 409 : 400;
        return json({ error: message.slice(0, 120) }, status);
      }
    }
    if (url.pathname === "/admin/discord-staging-adoptions") {
      if (env.ENVIRONMENT === "production" || env.DISCORD_APPROVAL_MODE !== "staging_adoption") {
        return new Response("Not found", { status: 404 });
      }
      if (request.method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? 5);
        return json({
          adoptions: await listApprovedDiscordStagingAdoptions(env.FORECAST_DB, limit),
        });
      }
      if (request.method === "POST") {
        const length = Number(request.headers.get("content-length") ?? 0);
        if (length > 32_768) return new Response("Payload too large", { status: 413 });
        try {
          return json(await createDiscordStagingAdoption(env.FORECAST_DB, await request.json()));
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid_request";
          const status = message === "discord_staging_request_key_conflict" ? 409 : 400;
          return json({ error: message.slice(0, 120) }, status);
        }
      }
    }
    const adoptionMessageMatch = url.pathname.match(
      /^\/admin\/discord-staging-adoptions\/(discord-staging-[0-9a-f-]{36})\/message$/,
    );
    if (request.method === "POST" && adoptionMessageMatch?.[1]) {
      if (env.ENVIRONMENT === "production" || env.DISCORD_APPROVAL_MODE !== "staging_adoption") {
        return new Response("Not found", { status: 404 });
      }
      try {
        const updated = await recordDiscordStagingAdoptionMessage(
          env.FORECAST_DB,
          adoptionMessageMatch[1],
          await request.json(),
        );
        return json({ adoption: updated }, updated ? 200 : 404);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid_request";
        const status = message === "discord_staging_message_conflict" ? 409 : 400;
        return json({ error: message.slice(0, 120) }, status);
      }
    }
    const adoptionResultMatch = url.pathname.match(
      /^\/admin\/discord-staging-adoptions\/(discord-staging-[0-9a-f-]{36})\/adoption-pr$/,
    );
    if (request.method === "POST" && adoptionResultMatch?.[1]) {
      if (env.ENVIRONMENT === "production" || env.DISCORD_APPROVAL_MODE !== "staging_adoption") {
        return new Response("Not found", { status: 404 });
      }
      try {
        const updated = await markDiscordStagingAdoptionProcessed(
          env.FORECAST_DB,
          adoptionResultMatch[1],
          await request.json(),
        );
        return json({ adoption: updated }, updated ? 200 : 404);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid_request";
        const status = message === "discord_staging_result_conflict" ? 409 : 400;
        return json({ error: message.slice(0, 120) }, status);
      }
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
