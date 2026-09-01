import { readBoundedJson } from "../../shared/boundedHttp";
import { readCanaryReport, startCanaryDeployment } from "./canary";
import { runCollection } from "./collector";
import { timingSafeBearer } from "./crypto";
import {
  listProposalCandidates,
  markCandidateProposed,
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
import { decideManualReview, listManualReviews } from "./manual-review";
import {
  createDispatcherSmoke,
  readOperationsHealth,
  readWorkflowDispatch,
  recordSourceProcessorInternalFailure,
  recordWatchdogFallback,
  recordWatchdogNotificationFailure,
  recordWorkflowDispatchStatus,
  sanitizeOpsError,
  upsertOpsAlert,
} from "./ops";
import { listSourceQueue, processSourceQueue, readScheduleLedger } from "./source-queue";
import type { CollectorEnv } from "./types";

export default {
  async scheduled(event, env, context) {
    context.waitUntil(runCollection(env, { nowMs: event.scheduledTime }));
  },

  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      const environment = opsEnvironment(env);
      return json({
        ...(await readHealth(env.FORECAST_DB)),
        operations: await readOperationsHealth(env.FORECAST_DB, environment),
      });
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
      const sourceAddress = request.headers.get("cf-connecting-ip") ?? "unknown";
      const unauthenticatedLimit = await env.ADMIN_RATE_LIMITER.limit({
        key: `admin-unauth:${sourceAddress}`,
      });
      if (!unauthenticatedLimit.success) {
        return new Response("Too many requests", { status: 429 });
      }
    } else if (env.ENVIRONMENT !== "test") {
      return new Response("Service unavailable", { status: 503 });
    }
    if (!(await timingSafeBearer(request, env.ADMIN_TOKEN))) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (env.ADMIN_RATE_LIMITER) {
      const authenticatedLimit = await env.ADMIN_RATE_LIMITER.limit({
        key: `admin-auth:${request.method}:${adminRouteGroup(url.pathname)}`,
      });
      if (!authenticatedLimit.success) {
        return new Response("Too many requests", { status: 429 });
      }
    }
    if (request.method === "POST" && url.pathname === "/admin/probe") {
      const task = runCollection(env);
      context.waitUntil(task);
      return json(await task);
    }
    if (request.method === "POST" && url.pathname === "/admin/dispatcher-smoke") {
      if (env.ENVIRONMENT === "production") return new Response("Not found", { status: 404 });
      const length = Number(request.headers.get("content-length") ?? 0);
      if (length > 4_096) return new Response("Payload too large", { status: 413 });
      try {
        const body = await readBoundedJson(request, 4_096, "dispatcher_smoke_body");
        const requestKey =
          typeof body === "object" && body !== null && !Array.isArray(body)
            ? (body as Record<string, unknown>)["requestKey"]
            : null;
        if (typeof requestKey !== "string") throw new Error("invalid_smoke_request_key");
        return json(
          await createDispatcherSmoke(env.FORECAST_DB, opsEnvironment(env), requestKey),
          202,
        );
      } catch (error) {
        return json({ error: sanitizeOpsError(error) }, 400);
      }
    }
    const workflowStatusMatch = url.pathname.match(
      /^\/admin\/workflow-dispatches\/(fd-[0-9a-f]{32})\/status$/,
    );
    if (workflowStatusMatch?.[1]) {
      if (request.method === "GET") {
        const dispatch = await readWorkflowDispatch(
          env.FORECAST_DB,
          opsEnvironment(env),
          workflowStatusMatch[1],
        );
        return json({ dispatch }, dispatch ? 200 : 404);
      }
      if (request.method === "POST") {
        const length = Number(request.headers.get("content-length") ?? 0);
        if (length > 8_192) return new Response("Payload too large", { status: 413 });
        try {
          return json({
            dispatch: await recordWorkflowDispatchStatus(
              env.FORECAST_DB,
              opsEnvironment(env),
              workflowStatusMatch[1],
              await readBoundedJson(request, 8_192, "workflow_callback_body"),
            ),
          });
        } catch (error) {
          const code = sanitizeOpsError(error);
          await upsertOpsAlert(env.FORECAST_DB, {
            alertKey: `callback:${opsEnvironment(env)}:${code}`,
            environment: opsEnvironment(env),
            severity: "critical",
            component: "workflow-callback",
            errorCode: code,
            context: { dispatchId: workflowStatusMatch[1] },
          });
          const status =
            code.includes("not_found") || code.includes("conflict") || code.includes("regression")
              ? 409
              : 400;
          return json({ error: code }, status);
        }
      }
    }
    if (request.method === "POST" && url.pathname === "/admin/ops-alerts/watchdog-fallback") {
      const length = Number(request.headers.get("content-length") ?? 0);
      if (length > 4_096) return new Response("Payload too large", { status: 413 });
      try {
        return json(
          await recordWatchdogFallback(
            env.FORECAST_DB,
            opsEnvironment(env),
            await readBoundedJson(request, 4_096, "watchdog_body"),
          ),
        );
      } catch (error) {
        return json({ error: sanitizeOpsError(error) }, 400);
      }
    }
    if (
      request.method === "POST" &&
      url.pathname === "/admin/ops-alerts/watchdog-notification-failed"
    ) {
      try {
        return json(
          await recordWatchdogNotificationFailure(
            env.FORECAST_DB,
            opsEnvironment(env),
            await readBoundedJson(request, 4_096, "watchdog_notification_failure_body"),
          ),
        );
      } catch (error) {
        return json({ error: sanitizeOpsError(error) }, 400);
      }
    }
    if (
      request.method === "POST" &&
      url.pathname === "/admin/ops-alerts/source-processor-internal"
    ) {
      try {
        return json(
          await recordSourceProcessorInternalFailure(
            env.FORECAST_DB,
            opsEnvironment(env),
            await readBoundedJson(request, 4_096, "source_processor_failure_body"),
          ),
        );
      } catch (error) {
        return json({ error: sanitizeOpsError(error) }, 400);
      }
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
    if (request.method === "GET" && url.pathname === "/admin/manual-reviews") {
      const status = url.searchParams.get("status") ?? "pending";
      if (status !== "pending" && status !== "resolved" && status !== "expired") {
        return json({ error: "manual_review_status_invalid" }, 400);
      }
      const limit = Number(url.searchParams.get("limit") ?? 20);
      return json({ reviews: await listManualReviews(env.FORECAST_DB, { status, limit }) });
    }
    const manualReviewDecisionMatch = url.pathname.match(
      /^\/admin\/manual-reviews\/(mr-[0-9a-f]{32})\/decision$/,
    );
    if (request.method === "POST" && manualReviewDecisionMatch?.[1]) {
      try {
        return json({
          result: await decideManualReview(
            env.FORECAST_DB,
            opsEnvironment(env),
            manualReviewDecisionMatch[1],
            await readBoundedJson(request, 8_192, "manual_review_body"),
          ),
        });
      } catch (error) {
        const code = sanitizeOpsError(error);
        const status =
          code.includes("conflict") || code.includes("not_pending") || code.includes("race")
            ? 409
            : code.includes("not_found")
              ? 404
              : 400;
        return json({ error: code }, status);
      }
    }
    if (request.method === "POST" && url.pathname === "/admin/source-queue/process") {
      const length = Number(request.headers.get("content-length") ?? 0);
      if (length > 1_000_000) return new Response("Payload too large", { status: 413 });
      try {
        return json(
          await processSourceQueue(
            env.FORECAST_DB,
            await readBoundedJson(request, 1_000_000, "source_queue_body"),
          ),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid_request";
        const status = message === "candidate_revision_conflict" ? 409 : 400;
        return json({ error: message.slice(0, 120) }, status);
      }
    }
    if (request.method === "GET" && url.pathname === "/admin/canary-report") {
      return json(
        await readCanaryReport(env.FORECAST_DB, Date.now(), env.DEPLOY_SHA, opsEnvironment(env)),
      );
    }
    if (request.method === "POST" && url.pathname === "/admin/canary-deployments/start") {
      try {
        const body = await readBoundedJson(request, 4_096, "canary_start_body");
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          throw new Error("canary_start_body_invalid");
        }
        const record = body as Record<string, unknown>;
        if (
          typeof record["collectorCron"] !== "string" ||
          typeof record["dispatcherCron"] !== "string"
        ) {
          throw new Error("canary_start_cron_invalid");
        }
        return json({
          deployment: await startCanaryDeployment(env.FORECAST_DB, {
            environment: opsEnvironment(env),
            deploymentSha: env.DEPLOY_SHA,
            collectorCron: record["collectorCron"],
            dispatcherCron: record["dispatcherCron"],
          }),
        });
      } catch (error) {
        const code = sanitizeOpsError(error);
        return json({ error: code }, code.includes("conflict") ? 409 : 400);
      }
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
        return json(
          await createDiscordApprovalTest(
            env.FORECAST_DB,
            await readBoundedJson(request, 32_768, "discord_test_body"),
          ),
        );
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
          return json(
            await createDiscordStagingAdoption(
              env.FORECAST_DB,
              await readBoundedJson(request, 32_768, "discord_adoption_body"),
            ),
          );
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
          await readBoundedJson(request, 32_768, "discord_message_body"),
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
          await readBoundedJson(request, 32_768, "discord_adoption_result_body"),
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

function opsEnvironment(env: CollectorEnv) {
  return env.ENVIRONMENT === "production" ? "production" : "staging";
}

function adminRouteGroup(pathname: string) {
  if (pathname.startsWith("/admin/workflow-dispatches/")) return "workflow-dispatches";
  if (pathname.startsWith("/admin/manual-reviews/")) return "manual-reviews";
  if (pathname.startsWith("/admin/source-queue")) return "source-queue";
  if (pathname.startsWith("/admin/discord-")) return "discord";
  if (pathname.startsWith("/admin/candidates")) return "candidates";
  if (pathname.startsWith("/admin/ops-alerts")) return "ops-alerts";
  return pathname.slice("/admin/".length).split("/")[0] || "root";
}
