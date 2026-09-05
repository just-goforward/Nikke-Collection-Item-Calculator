import { readBoundedJson } from "../../shared/boundedHttp.ts";
import {
  listProposalCandidates,
  markCandidateProposed,
  supersedeIncompatibleCandidates,
} from "./db";
import {
  type AdminRequestContext,
  type AdminRouteHandler,
  json,
  opsEnvironment,
} from "./http-shared";
import { decideManualReview, listManualReviews } from "./manual-review";
import { sanitizeOpsError } from "./ops";
import { listSourceQueue, processSourceQueue, readScheduleLedger } from "./source-queue";

const SOURCE_ROUTE_HANDLERS: readonly AdminRouteHandler[] = [
  handleSourceReadRoute,
  handleManualReviewRoute,
  handleSourceMutationRoute,
];

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
  return null;
}

async function handleManualReviewRoute({ request, url, env }: AdminRequestContext) {
  if (request.method === "GET" && url.pathname === "/admin/manual-reviews") {
    return listReviews(url, env.FORECAST_DB);
  }

  const manualReviewDecisionMatch = url.pathname.match(
    /^\/admin\/manual-reviews\/(mr-[0-9a-f]{32})\/decision$/,
  );
  if (request.method === "POST" && manualReviewDecisionMatch?.[1]) {
    return decideReview(request, env, manualReviewDecisionMatch[1]);
  }
  return null;
}

async function handleSourceMutationRoute({ request, url, env }: AdminRequestContext) {
  if (request.method === "POST" && url.pathname === "/admin/source-queue/process") {
    if (Number(request.headers.get("content-length") ?? 0) > 1_000_000) {
      return new Response("Payload too large", { status: 413 });
    }
    try {
      return json(
        await processSourceQueue(
          env.FORECAST_DB,
          await readBoundedJson(request, 1_000_000, "source_queue_body"),
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid_request";
      return json(
        { error: message.slice(0, 120) },
        message === "candidate_revision_conflict" ? 409 : 400,
      );
    }
  }

  const proposedMatch = url.pathname.match(
    /^\/admin\/candidates\/(forecast-[a-z0-9-]+)\/proposed$/,
  );
  if (request.method === "POST" && proposedMatch?.[1]) {
    const updated = await markCandidateProposed(env.FORECAST_DB, proposedMatch[1]);
    return json({ updated }, updated ? 200 : 409);
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

async function decideReview(request: Request, env: AdminRequestContext["env"], reviewId: string) {
  try {
    return json({
      result: await decideManualReview(
        env.FORECAST_DB,
        opsEnvironment(env),
        reviewId,
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
