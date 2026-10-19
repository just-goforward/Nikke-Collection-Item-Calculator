import { readBoundedJson } from "../../shared/boundedHttp.ts";
import {
  type AdminRequestContext,
  type AdminRouteHandler,
  json,
  opsEnvironment,
} from "./http-shared";
import {
  recordSourceProcessorInternalFailure,
  recordWatchdogFallback,
  recordWatchdogNotificationFailure,
  sanitizeOpsError,
} from "./ops";

const OPS_ROUTE_HANDLERS: readonly AdminRouteHandler[] = [handleOpsAlertRoute];

export async function handleAdminOpsRoute(context: AdminRequestContext) {
  for (const handler of OPS_ROUTE_HANDLERS) {
    const response = await handler(context);
    if (response) return response;
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

function contentLengthExceeds(request: Request, limit: number) {
  return Number(request.headers.get("content-length") ?? 0) > limit;
}
