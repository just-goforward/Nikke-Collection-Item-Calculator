import { sha256Hex } from "../../forecast-collector/src/crypto.ts";
import {
  decideManualReview,
  readManualReview,
} from "../../forecast-collector/src/manual-review.ts";
import { readBoundedText } from "../../shared/boundedHttp.ts";
import {
  parseDiscordInteraction,
  readVerifiedDiscordBody,
} from "../../shared/discordInteraction.ts";
import {
  applyPublicationCommand,
  bindDirectReviewMessage,
  type CommandInput,
  createPreviousRollbackReview,
  createReview,
  publicationErrorCode,
  type ReviewRow,
  readActive,
  readReview,
} from "../../shared/forecast-publication/store.ts";
import { importPublicationSigningKey } from "../../shared/forecastPublication.ts";
import { assertUsageAllowed, UsageGuardError } from "../../shared/usageGuard.ts";
import { handleManualInteraction } from "./manual-interactions.ts";
import type { InteractionRouterEnv } from "./types.ts";

export default {
  async fetch(request: Request, env, context) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return health(env);
    }
    if (request.method !== "POST" || url.pathname !== "/discord/interactions")
      return new Response("Not found", { status: 404 });
    const body = await readVerifiedDiscordBody(request, env.DISCORD_PUBLIC_KEY, Date.now());
    if (body instanceof Response) return body;
    const interaction = parseDiscordInteraction(body, env.DISCORD_APPLICATION_ID);
    if (interaction instanceof Response) return interaction;
    if (interaction.type === 1) return reply({ type: 1 });
    const customId = interaction.data?.custom_id;
    if (
      typeof customId === "string" &&
      /^forecast_manual_(staging|production)_(requeue|ignore):mr-/.test(customId)
    )
      return handleManualInteraction(interaction, env, context, {
        sha256Hex,
        decideManualReview,
        readManualReview,
      });
    if (typeof customId !== "string" || !customId.startsWith("forecast_publish:"))
      return ephemeral("Legacy Forecast / GitHub-PR buttons are disabled. No changes were made.");
    if (
      interaction.guild_id !== env.DISCORD_GUILD_ID ||
      interaction.member?.user?.id !== env.DISCORD_FORECAST_APPROVER_USER_ID
    )
      return ephemeral("You are not authorized to publish forecasts.");
    if (interaction.channel_id !== env.DISCORD_APPROVAL_CHANNEL_ID)
      return ephemeral("Use the configured forecast approval channel.");
    const match = /^forecast_publish:(staging|production):([0-9a-f]{32})$/.exec(customId);
    const message = Reflect.get(interaction, "message") as { id?: unknown } | undefined;
    if (
      !match ||
      typeof interaction.id !== "string" ||
      !/^\d{1,24}$/.test(interaction.id) ||
      typeof message?.id !== "string" ||
      !/^\d{6,24}$/.test(message.id) ||
      typeof interaction.token !== "string" ||
      !/^[A-Za-z0-9._-]{1,512}$/.test(interaction.token)
    )
      return ephemeral("Invalid publication button.");
    const environment = match[1] as "staging" | "production";
    if (
      environment === "production"
        ? env.PRODUCTION_PUBLICATION_MODE !== "enabled" ||
          env.PRODUCTION_MUTATIONS_ENABLED !== "true"
        : env.STAGING_PUBLICATION_MODE !== "enabled"
    )
      return ephemeral(`${environment} publication is disabled. No changes were made.`);
    if (!(await publicationKeyAvailable(env)))
      return ephemeral(
        `${environment} publication is disabled: publication_signing_key_unavailable (missing or invalid key/key ID). No changes were made.`,
      );
    const input: CommandInput = {
      environment,
      reviewId: match[2]!,
      interactionId: interaction.id,
      actorId: env.DISCORD_FORECAST_APPROVER_USER_ID,
      channelId: env.DISCORD_APPROVAL_CHANNEL_ID,
      messageId: message.id,
    };
    // Public deferred response: emergency confirmations survive client reloads in
    // the authenticated approval channel; the clicked review remains unchanged.
    context.waitUntil(complete(env, input, interaction.token));
    return reply({ type: 5, data: { flags: 0 } });
  },
} satisfies ExportedHandler<InteractionRouterEnv>;

async function complete(env: InteractionRouterEnv, input: CommandInput, token: string) {
  const db = input.environment === "staging" ? env.STAGING_FORECAST_DB : env.PRODUCTION_FORECAST_DB;
  let message: PublicationResponse;
  try {
    message = await publicationResponse(env, db, input);
  } catch (error) {
    message = {
      content: `Publication not applied (${publicationErrorCode(error)}). The review is unchanged; retry this button. If stale/expired, use a fresh review.`,
    };
  }
  await deliverPublicationResponse(env, db, input, token, message);
}

type PublicationResponse = { content: string; directReviewIds?: string[]; components?: object[] };

async function publicationResponse(
  env: InteractionRouterEnv,
  db: D1Database,
  input: CommandInput,
): Promise<PublicationResponse> {
  const review = await readReview(db, input);
  const now = Date.now();
  let result: { sequence: number; duplicate: boolean };
  try {
    // Applied command lookup precedes expiry, quota and pointer checks: replay must return
    // its original outcome even after a later publication or Usage Guard stop.
    result = await applyPublicationCommand(
      db,
      input,
      {
        privateKey: env.FORECAST_PUBLICATION_SIGNING_KEY ?? "",
        keyId: env.FORECAST_PUBLICATION_KEY_ID,
      },
      now,
      () =>
        assertUsageAllowed(
          env.USAGE_GUARD_DB,
          input.environment === "staging" ? "staging_automation" : "production_forecast_automation",
        ),
    );
  } catch (error) {
    if (
      review.action === "approve" ||
      ![
        "publication_review_expired",
        "publication_review_stale",
        "runtime_activation_stale",
      ].includes(publicationErrorCode(error))
    )
      throw error;
    const active = await readActive(db, input.environment);
    // Explicit second confirmation, never an automatic stale emergency mutation. This
    // refresh is human-triggered and works even when Usage Guard has stopped the Cron.
    const refreshedReviewId = await createReview(
      db,
      active,
      review.action,
      review.candidate_id,
      review.payload_hash,
      now,
      input.interactionId,
    );
    return emergencyConfirmation(
      db,
      [refreshedReviewId],
      `${input.environment}: the emergency review was stale/expired. Nothing was published.`,
    );
  }
  const content = `${input.environment}: ${review.action} ${result.duplicate ? "already applied" : "applied"} at sequence ${result.sequence}.\nActivation operation: ${input.interactionId}`;
  // Every active result offers off immediately, including the first approval and
  // a rollback. Off results offer rollback to their previous approved artifact.
  try {
    const active = await readActive(db, input.environment);
    if (active.operation_id === input.interactionId && active.sequence === result.sequence) {
      const ids: string[] = [];
      const rollback = await createPreviousRollbackReview(db, active, now, input.interactionId);
      if (rollback) ids.push(rollback);
      if (active.candidate_id)
        ids.push(await createReview(db, active, "off", null, null, now, input.interactionId));
      if (ids.length) return await emergencyConfirmation(db, ids, content);
    }
  } catch (error) {
    // The activation already committed; never report a failed publication or undo it.
    return {
      content: `${content}\nEmergency confirmation unavailable (${publicationErrorCode(error)}).`,
    };
  }
  return { content };
}

async function emergencyConfirmation(
  db: D1Database,
  reviewIds: string[],
  content: string,
): Promise<PublicationResponse> {
  const details: string[] = [];
  const buttons: object[] = [];
  for (const reviewId of reviewIds) {
    const review = await db
      .prepare("SELECT * FROM forecast_runtime_reviews WHERE review_id=?")
      .bind(reviewId)
      .first<ReviewRow>();
    if (!review) throw new Error("publication_review_missing");
    details.push(
      `Confirm ${review.action} against CURRENT sequence ${review.expected_sequence}.` +
        `\nCandidate: ${review.candidate_id ?? "off"}\nSHA-256: ${review.payload_hash ?? "none"}` +
        `\nExpires: ${new Date(review.expires_at).toISOString()}`,
    );
    buttons.push({
      type: 2,
      style: 4,
      label: `Confirm ${review.action} (${review.environment})`,
      custom_id: `forecast_publish:${review.environment}:${reviewId}`,
    });
  }
  return {
    directReviewIds: reviewIds,
    content: `${content}\n${details.join("\n\n")}`,
    components: [{ type: 1, components: buttons }],
  };
}

async function deliverPublicationResponse(
  env: InteractionRouterEnv,
  db: D1Database,
  input: CommandInput,
  token: string,
  { content, directReviewIds, components }: PublicationResponse,
) {
  try {
    const response = await fetch(
      `https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${encodeURIComponent(token)}/messages/@original`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content,
          components: components ?? [],
          allowed_mentions: { parse: [] },
        }),
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) throw new Error("publication_discord_response_failed");
    if (directReviewIds?.length) {
      const message: unknown = JSON.parse(
        await readBoundedText(response, 16_384, "publication_discord_response_too_large"),
      );
      const messageId = message && typeof message === "object" ? Reflect.get(message, "id") : null;
      if (typeof messageId !== "string" || !/^\d{6,24}$/.test(messageId))
        throw new Error("publication_message_id");
      for (const reviewId of directReviewIds)
        await bindDirectReviewMessage(db, {
          reviewId,
          interactionId: input.interactionId,
          messageId,
          channelId: input.channelId,
        });
    } else {
      await response.body?.cancel();
    }
  } catch (error) {
    // Never roll back a committed decision for a delivery failure. The atomic result outbox
    // survives Worker restarts, and replay of the interaction returns its recorded outcome.
    console.warn(
      JSON.stringify({
        event: "publication_discord_response_failed",
        interactionId: input.interactionId,
        code: publicationErrorCode(error),
      }),
    );
  }
}

function reply(value: object) {
  return Response.json(value, { headers: { "cache-control": "no-store" } });
}
function ephemeral(content: string) {
  return reply({ type: 4, data: { content, flags: 64 } });
}

async function publicationKeyAvailable(env: InteractionRouterEnv) {
  if (
    !env.FORECAST_PUBLICATION_SIGNING_KEY ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(env.FORECAST_PUBLICATION_KEY_ID)
  )
    return false;
  try {
    await importPublicationSigningKey(env.FORECAST_PUBLICATION_SIGNING_KEY);
    return true;
  } catch {
    return false;
  }
}

async function health(env: InteractionRouterEnv) {
  try {
    await assertUsageAllowed(env.USAGE_GUARD_DB, "admin_read");
  } catch (error) {
    if (!(error instanceof UsageGuardError)) throw error;
    return Response.json(
      {
        status: "quota_disabled",
        deploymentSha: env.DEPLOY_SHA,
        quotaAction: error.action,
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  const [staging, production] = await Promise.all([
    healthRow(env.STAGING_FORECAST_DB),
    healthRow(env.PRODUCTION_FORECAST_DB),
  ]);
  const keyAvailable = await publicationKeyAvailable(env);
  return reply({
    status: "ok",
    deploymentSha: env.DEPLOY_SHA,
    productionMutationsEnabled: env.PRODUCTION_MUTATIONS_ENABLED === "true",
    stagingPublication: env.STAGING_PUBLICATION_MODE === "enabled" && keyAvailable,
    productionPublication:
      env.PRODUCTION_PUBLICATION_MODE === "enabled" &&
      env.PRODUCTION_MUTATIONS_ENABLED === "true" &&
      keyAvailable,
    publicationError: keyAvailable ? null : "publication_signing_key_unavailable",
    databases: { staging, production },
  });
}

async function healthRow(db: D1Database) {
  const migration = await db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .first<{ version: number | null }>();
  const version = Number(migration?.version ?? 0);
  // Retain the existing readiness response shape; new databases report the runtime command log.
  const audit =
    version >= 23
      ? await db
          .prepare(`SELECT state AS result,strftime('%Y-%m-%dT%H:%M:%fZ',created_at/1000.0,'unixepoch') AS received_at
        FROM forecast_runtime_commands ORDER BY created_at DESC LIMIT 1`)
          .first<{ result: string; received_at: string }>()
      : version >= 8
        ? await db
            .prepare(
              "SELECT result,received_at FROM discord_interaction_audit ORDER BY received_at DESC LIMIT 1",
            )
            .first<{ result: string | null; received_at: string }>()
        : null;
  return {
    schemaVersion: version,
    latestInteraction: audit ? { result: audit.result, receivedAt: audit.received_at } : null,
  };
}
