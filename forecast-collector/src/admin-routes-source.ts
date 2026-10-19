import { listProposalCandidates } from "./db";
import { type AdminRequestContext, type AdminRouteHandler, json } from "./http-shared";
import { readScheduleLedger } from "./schedule-ledger";
import { listManualReviews, listSourceQueue } from "./source-history";

const SOURCE_ROUTE_HANDLERS: readonly AdminRouteHandler[] = [handleSourceReadRoute];

export async function handleAdminSourceRoute(context: AdminRequestContext) {
  for (const handler of SOURCE_ROUTE_HANDLERS) {
    const response = await handler(context);
    if (response) return response;
  }
  return null;
}

async function handleSourceReadRoute({ request, url, env }: AdminRequestContext) {
  if (request.method === "GET" && url.pathname === "/admin/candidates") {
    return json({ candidates: await listProposalCandidates(env.FORECAST_DB) });
  }
  if (request.method === "GET" && url.pathname === "/admin/source-queue") {
    const limit = Number(url.searchParams.get("limit") ?? 20);
    return json({ items: await listSourceQueue(env.FORECAST_DB, limit) });
  }
  if (request.method === "GET" && url.pathname === "/admin/schedule-ledger") {
    return json(await readScheduleLedger(env.FORECAST_DB, Date.now()));
  }
  if (request.method === "GET" && url.pathname === "/admin/manual-reviews") {
    return listReviews(url, env.FORECAST_DB);
  }
  return null;
}

async function listReviews(url: URL, db: D1Database) {
  const status = url.searchParams.get("status") ?? "pending";
  if (status !== "pending" && status !== "resolved" && status !== "expired") {
    return json({ error: "manual_review_status_invalid" }, 400);
  }
  const limit = Number(url.searchParams.get("limit") ?? 20);
  return json({ reviews: await listManualReviews(db, { status, limit }) });
}
