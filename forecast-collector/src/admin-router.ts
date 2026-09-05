import { handleAdminCanaryRoute } from "./admin-routes-canary";
import { handleAdminDiscordRoute } from "./admin-routes-discord";
import { handleAdminOpsRoute } from "./admin-routes-ops";
import { handleAdminSourceRoute } from "./admin-routes-source";
import type { AdminRequestContext, AdminRouteHandler } from "./http-shared";

const ROUTE_HANDLERS: readonly AdminRouteHandler[] = [
  handleAdminOpsRoute,
  handleAdminSourceRoute,
  handleAdminCanaryRoute,
  handleAdminDiscordRoute,
];

export async function handleAdminRoute(context: AdminRequestContext) {
  for (const handler of ROUTE_HANDLERS) {
    const response = await handler(context);
    if (response) return response;
  }
  return new Response("Not found", { status: 404 });
}
