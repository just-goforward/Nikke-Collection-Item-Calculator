import { readBoundedJson } from "../../shared/boundedHttp.ts";
import { runCollection } from "./collector";
import {
  type AdminRequestContext,
  type AdminRouteHandler,
  json,
  opsEnvironment,
} from "./http-shared";
import {
  createDispatcherSmoke,
  readWorkflowDispatch,
  recordSourceProcessorInternalFailure,
  recordWatchdogFallback,
  recordWatchdogNotificationFailure,
  recordWorkflowDispatchStatus,
  sanitizeOpsError,
  upsertOpsAlert,
} from "./ops";

const OPS_ROUTE_HANDLERS: readonly AdminRouteHandler[] = [
  handleProbeRoute,
  handleWorkflowRoute,
  handleOpsAlertRoute,
];

export async function handleAdminOpsRoute(context: AdminRequestContext) {
  for (const handler of OPS_ROUTE_HANDLERS) {
    const response = await handler(context);
    if (response) return response;
  }
  return null;
}

async function handleProbeRoute({ request, url, env, executionContext }: AdminRequestContext) {
  if (request.method === "POST" && url.pathname === "/admin/probe") {
    const task = runCollection(env);
    executionContext.waitUntil(task);
    return json(await task);
  }
  if (request.method === "POST" && url.pathname === "/admin/dispatcher-smoke") {
    if (env.ENVIRONMENT === "production") return new Response("Not found", { status: 404 });
    if (contentLengthExceeds(request, 4_096)) {
      return new Response("Payload too large", { status: 413 });
    }
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
  return null;
}

async function handleWorkflowRoute({ request, url, env }: AdminRequestContext) {
  const workflowStatusMatch = url.pathname.match(
    /^\/admin\/workflow-dispatches\/(fd-[0-9a-f]{32})\/status$/,
  );
  const dispatchId = workflowStatusMatch?.[1];
  if (dispatchId && request.method === "GET") {
    const dispatch = await readWorkflowDispatch(env.FORECAST_DB, opsEnvironment(env), dispatchId);
    return json({ dispatch }, dispatch ? 200 : 404);
  }
  if (dispatchId && request.method === "POST") {
    return recordWorkflowStatus(request, env, dispatchId);
  }
  return null;
}

async function handleOpsAlertRoute({ request, url, env }: AdminRequestContext) {
  if (request.method === "POST" && url.pathname === "/admin/ops-alerts/watchdog-fallback") {
    if (contentLengthExceeds(request, 4_096)) {
      return new Response("Payload too large", { status: 413 });
    }
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
  if (request.method === "POST" && url.pathname === "/admin/ops-alerts/source-processor-internal") {
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
  return null;
}

async function recordWorkflowStatus(
  request: Request,
  env: AdminRequestContext["env"],
  dispatchId: string,
) {
  if (contentLengthExceeds(request, 8_192)) {
    return new Response("Payload too large", { status: 413 });
  }
  try {
    return json({
      dispatch: await recordWorkflowDispatchStatus(
        env.FORECAST_DB,
        opsEnvironment(env),
        dispatchId,
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
      context: { dispatchId },
    });
    const status =
      code.includes("not_found") || code.includes("conflict") || code.includes("regression")
        ? 409
        : 400;
    return json({ error: code }, status);
  }
}

function contentLengthExceeds(request: Request, limit: number) {
  return Number(request.headers.get("content-length") ?? 0) > limit;
}
