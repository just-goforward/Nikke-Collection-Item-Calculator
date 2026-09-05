import { readBoundedJson } from "../../shared/boundedHttp.ts";
import {
  createDiscordApprovalTest,
  createDiscordStagingAdoption,
  listApprovedDiscordStagingAdoptions,
  markDiscordStagingAdoptionProcessed,
  recordDiscordStagingAdoptionMessage,
} from "./discord-approval";
import { type AdminRequestContext, type AdminRouteHandler, json } from "./http-shared";

const DISCORD_ROUTE_HANDLERS: readonly AdminRouteHandler[] = [
  handleDiscordTestRoute,
  handleStagingAdoptionCollectionRoute,
  handleStagingAdoptionMessageRoute,
  handleStagingAdoptionResultRoute,
];

export async function handleAdminDiscordRoute(context: AdminRequestContext) {
  for (const handler of DISCORD_ROUTE_HANDLERS) {
    const response = await handler(context);
    if (response) return response;
  }
  return null;
}

async function handleDiscordTestRoute({ request, url, env }: AdminRequestContext) {
  if (request.method === "POST" && url.pathname === "/admin/discord-test-approvals") {
    if (!discordTestEnabled(env)) return new Response("Not found", { status: 404 });
    if (contentLengthExceeds(request, 32_768)) {
      return new Response("Payload too large", { status: 413 });
    }
    try {
      return json(
        await createDiscordApprovalTest(
          env.FORECAST_DB,
          await readBoundedJson(request, 32_768, "discord_test_body"),
        ),
      );
    } catch (error) {
      return requestError(error, "discord_test_request_key_conflict");
    }
  }
  return null;
}

async function handleStagingAdoptionCollectionRoute({ request, url, env }: AdminRequestContext) {
  if (url.pathname === "/admin/discord-staging-adoptions") {
    if (!stagingAdoptionEnabled(env)) return new Response("Not found", { status: 404 });
    if (request.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 5);
      return json({
        adoptions: await listApprovedDiscordStagingAdoptions(env.FORECAST_DB, limit),
      });
    }
    if (request.method === "POST") {
      if (contentLengthExceeds(request, 32_768)) {
        return new Response("Payload too large", { status: 413 });
      }
      try {
        return json(
          await createDiscordStagingAdoption(
            env.FORECAST_DB,
            await readBoundedJson(request, 32_768, "discord_adoption_body"),
          ),
        );
      } catch (error) {
        return requestError(error, "discord_staging_request_key_conflict");
      }
    }
  }
  return null;
}

async function handleStagingAdoptionMessageRoute({ request, url, env }: AdminRequestContext) {
  const adoptionMessageMatch = url.pathname.match(
    /^\/admin\/discord-staging-adoptions\/(discord-staging-[0-9a-f-]{36})\/message$/,
  );
  if (request.method === "POST" && adoptionMessageMatch?.[1]) {
    if (!stagingAdoptionEnabled(env)) return new Response("Not found", { status: 404 });
    try {
      const updated = await recordDiscordStagingAdoptionMessage(
        env.FORECAST_DB,
        adoptionMessageMatch[1],
        await readBoundedJson(request, 32_768, "discord_message_body"),
      );
      return json({ adoption: updated }, updated ? 200 : 404);
    } catch (error) {
      return requestError(error, "discord_staging_message_conflict");
    }
  }
  return null;
}

async function handleStagingAdoptionResultRoute({ request, url, env }: AdminRequestContext) {
  const adoptionResultMatch = url.pathname.match(
    /^\/admin\/discord-staging-adoptions\/(discord-staging-[0-9a-f-]{36})\/adoption-pr$/,
  );
  if (request.method === "POST" && adoptionResultMatch?.[1]) {
    if (!stagingAdoptionEnabled(env)) return new Response("Not found", { status: 404 });
    try {
      const updated = await markDiscordStagingAdoptionProcessed(
        env.FORECAST_DB,
        adoptionResultMatch[1],
        await readBoundedJson(request, 32_768, "discord_adoption_result_body"),
      );
      return json({ adoption: updated }, updated ? 200 : 404);
    } catch (error) {
      return requestError(error, "discord_staging_result_conflict");
    }
  }
  return null;
}

function discordTestEnabled(env: AdminRequestContext["env"]) {
  return (
    env.ENVIRONMENT !== "production" &&
    (env.DISCORD_APPROVAL_MODE === "test" || env.DISCORD_APPROVAL_MODE === "staging_adoption")
  );
}

function stagingAdoptionEnabled(env: AdminRequestContext["env"]) {
  return env.ENVIRONMENT !== "production" && env.DISCORD_APPROVAL_MODE === "staging_adoption";
}

function requestError(error: unknown, conflictCode: string) {
  const message = error instanceof Error ? error.message : "invalid_request";
  return json({ error: message.slice(0, 120) }, message === conflictCode ? 409 : 400);
}

function contentLengthExceeds(request: Request, limit: number) {
  return Number(request.headers.get("content-length") ?? 0) > limit;
}
