import type { DiscordInteraction } from "../../shared/discordInteraction.ts";
import { assertUsageAllowed, UsageGuardError } from "../../shared/usageGuard.ts";
import type { InteractionRouterEnv } from "./types.ts";

type ManualBackend = {
  sha256Hex(value: string): Promise<string>;
  readManualReview(
    db: D1Database,
    reviewId: string,
  ): Promise<{ state: string; decision: string | null } | null>;
  decideManualReview(
    db: D1Database,
    environment: "staging" | "production",
    reviewId: string,
    raw: unknown,
    options: { actor: string },
  ): Promise<unknown>;
};
type ManualAction = {
  environment: "staging" | "production";
  decision: "requeue" | "ignore";
  reviewId: string;
  id: string;
  token: string;
  messageId: string;
  customId: string;
};

export async function handleManualInteraction(
  interaction: DiscordInteraction,
  env: InteractionRouterEnv,
  context: ExecutionContext,
  backend: ManualBackend,
): Promise<Response> {
  const action = parseManualAction(interaction);
  if (!action) return ephemeral("Invalid manual-review button.");
  const actor = env.DISCORD_APPROVER_USER_ID ?? env.DISCORD_FORECAST_APPROVER_USER_ID;
  const denied = authorizeManual(interaction, env, action, actor);
  if (denied) return denied;
  const { environment, decision, reviewId, id, token } = action;
  try {
    await assertUsageAllowed(
      env.USAGE_GUARD_DB,
      environment === "staging" ? "staging_automation" : "production_forecast_automation",
    );
  } catch (error) {
    if (!(error instanceof UsageGuardError)) throw error;
    return ephemeral("Manual-review changes are disabled by Usage Guard.");
  }
  const db = environment === "staging" ? env.STAGING_FORECAST_DB : env.PRODUCTION_FORECAST_DB;
  const review = await boundManualReview(db, action, backend);
  if (!review)
    return ephemeral(
      "Manual review is unavailable, expired, resolved differently, or bound to another message.",
    );
  const hash = await backend.sha256Hex(action.customId);
  const now = new Date().toISOString();
  await db
    .prepare(`INSERT OR IGNORE INTO discord_interaction_audit
    (interaction_id,environment,action,custom_id_hash,received_at,initial_response_at,initial_response_ms)
    VALUES(?,?,'manual_review',?,?,?,0)`)
    .bind(id, environment, hash, now, now)
    .run();
  const audit = await db
    .prepare(
      "SELECT custom_id_hash,environment FROM discord_interaction_audit WHERE interaction_id=?",
    )
    .bind(id)
    .first<{ custom_id_hash: string; environment: string }>();
  if (audit?.custom_id_hash !== hash || audit.environment !== environment)
    return ephemeral("Manual-review interaction identity conflict.");
  context.waitUntil(
    completeManualReview(
      env,
      db,
      {
        environment,
        decision,
        reviewId,
        actor,
        id,
        token,
        alreadyResolved: review.state === "resolved",
      },
      backend,
    ),
  );
  return Response.json({ type: 5, data: { flags: 64 } });
}

function parseManualAction(interaction: DiscordInteraction): ManualAction | null {
  const customId = interaction.data?.custom_id;
  if (typeof customId !== "string") return null;
  const match = /^forecast_manual_(staging|production)_(requeue|ignore):(mr-[0-9a-f]{32})$/.exec(
    customId,
  );
  const message = Reflect.get(interaction, "message") as { id?: unknown } | undefined;
  if (
    !match ||
    typeof interaction.id !== "string" ||
    !/^\d{1,24}$/.test(interaction.id) ||
    typeof interaction.token !== "string" ||
    !/^[A-Za-z0-9._-]{1,512}$/.test(interaction.token) ||
    typeof message?.id !== "string" ||
    !/^\d{6,24}$/.test(message.id)
  )
    return null;
  return {
    environment: match[1] === "production" ? "production" : "staging",
    decision: match[2] === "requeue" ? "requeue" : "ignore",
    reviewId: match[3]!,
    id: interaction.id,
    token: interaction.token,
    messageId: message.id,
    customId,
  };
}

function authorizeManual(
  interaction: DiscordInteraction,
  env: InteractionRouterEnv,
  action: ManualAction,
  actor: string,
) {
  if (
    interaction.guild_id !== env.DISCORD_GUILD_ID ||
    interaction.member?.user?.id !== actor ||
    interaction.channel_id !== env.DISCORD_ALERT_CHANNEL_ID
  )
    return ephemeral("You are not authorized to resolve manual reviews in this channel.");
  if (action.environment === "production" && env.PRODUCTION_MUTATIONS_ENABLED !== "true")
    return ephemeral("Production manual-review mutations are disabled.");
  return null;
}

async function boundManualReview(db: D1Database, action: ManualAction, backend: ManualBackend) {
  const binding = await db
    .prepare(`SELECT alert_key FROM forecast_ops_alerts
    WHERE environment=? AND discord_message_id=? AND json_extract(context_json,'$.reviewId')=?`)
    .bind(action.environment, action.messageId, action.reviewId)
    .first();
  if (!binding) return null;
  const review = await backend.readManualReview(db, action.reviewId);
  if (
    !review ||
    (review.state !== "pending" &&
      !(review.state === "resolved" && review.decision === action.decision))
  )
    return null;
  return review;
}

async function completeManualReview(
  env: InteractionRouterEnv,
  db: D1Database,
  input: {
    environment: "staging" | "production";
    decision: "requeue" | "ignore";
    reviewId: string;
    actor: string;
    id: string;
    token: string;
    alreadyResolved: boolean;
  },
  backend: ManualBackend,
) {
  let content: string;
  try {
    if (!input.alreadyResolved)
      await backend.decideManualReview(
        db,
        input.environment,
        input.reviewId,
        {
          requestId: `mrq-${(await backend.sha256Hex(`discord:${input.id}`)).slice(0, 32)}`,
          decision: input.decision,
          reason:
            input.decision === "requeue" ? "Discord에서 재처리 승인" : "Discord에서 관련 없음 승인",
          runId: Math.max(1, Number.parseInt(input.id.slice(-9), 10)),
          event: null,
        },
        { actor: `discord:${input.actor}` },
      );
    await db
      .prepare(`UPDATE discord_interaction_audit SET result='completed',completed_at=?,error_code=NULL
      WHERE interaction_id=?`)
      .bind(new Date().toISOString(), input.id)
      .run();
    content = `${input.environment}: manual review ${input.reviewId} ${input.decision} completed.`;
  } catch (error) {
    const code =
      error instanceof Error
        ? (error.message.match(/manual_review_[a-z_]+/)?.[0] ?? "manual_review_failed")
        : "manual_review_failed";
    await db
      .prepare(`UPDATE discord_interaction_audit SET result='failed',error_code=?,completed_at=?
      WHERE interaction_id=?`)
      .bind(code, new Date().toISOString(), input.id)
      .run();
    content = `Manual review not applied (${code}). Retry the original button.`;
  }
  try {
    const response = await fetch(
      `https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${encodeURIComponent(input.token)}/messages/@original`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, components: [], allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) throw new Error("manual_review_discord_response_failed");
    await response.body?.cancel();
  } catch (error) {
    const code =
      error instanceof Error && error.message === "manual_review_discord_response_failed"
        ? error.message
        : "manual_review_discord_transport_failed";
    await db
      .prepare("UPDATE discord_interaction_audit SET error_code=? WHERE interaction_id=?")
      .bind(code, input.id)
      .run();
  }
}

function ephemeral(content: string) {
  return Response.json(
    { type: 4, data: { content, flags: 64 } },
    { headers: { "cache-control": "no-store" } },
  );
}
