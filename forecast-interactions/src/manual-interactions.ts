import type { DiscordInteraction } from "../../shared/discordInteraction.ts";
import { forecastDisplayText } from "../../shared/forecastDisplayText.ts";
import {
  MANUAL_DECISION_LABELS,
  type ManualDecision,
  manualConfirmButtons,
  manualDoneButtons,
  manualReviewButtons,
  manualReviewPostLink,
} from "../../shared/forecastManualReview.ts";
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
  ): Promise<{ idempotent?: boolean }>;
};
type ManualAction = {
  environment: "staging" | "production";
  // "prompt" asks for confirmation, "confirm" writes, "cancel" restores the buttons.
  step: "prompt" | "confirm" | "cancel";
  decision: "requeue" | "ignore";
  reviewId: string;
  id: string;
  token: string;
  messageId: string;
  customId: string;
  embeds: Record<string, unknown>[];
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
  const db = environment === "staging" ? env.STAGING_FORECAST_DB : env.PRODUCTION_FORECAST_DB;
  if (!db)
    return ephemeral(
      `${environment} actions are disabled on this deployment. No changes were made.`,
    );
  if (action.step !== "confirm") return swapManualButtons(db, action, backend);
  try {
    await assertUsageAllowed(
      env.USAGE_GUARD_DB,
      environment === "staging" ? "staging_automation" : "production_forecast_automation",
    );
  } catch (error) {
    if (!(error instanceof UsageGuardError)) throw error;
    return ephemeral("Manual-review changes are disabled by Usage Guard.");
  }
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
        embeds: action.embeds,
      },
      backend,
    ),
  );
  // Deferred update of the message that carries the buttons; completed via @original.
  return Response.json({ type: 6 });
}

// Read-only steps (prompt / cancel): never write, only swap this message's buttons.
async function swapManualButtons(db: D1Database, action: ManualAction, backend: ManualBackend) {
  if (!(await boundMessage(db, action)))
    return ephemeral(
      "이 메시지는 더 이상 유효하지 않습니다. 가장 최근 검토 메시지의 버튼을 사용해 주세요.",
    );
  const review = await backend.readManualReview(db, action.reviewId);
  if (review?.state !== "pending")
    return updateMessage({
      components: manualDoneButtons("이미 처리되었거나 만료된 검토입니다"),
    });
  // Messages delivered before the linked-title layout carried the source link in a
  // button; keep a link visible once those buttons are swapped out.
  const [first] = action.embeds;
  const description = String(first?.["description"] ?? "");
  const legacy = first && !description.includes("](https://game.naver.com/");
  return updateMessage({
    ...(legacy
      ? {
          embeds: [
            {
              title: String(first["title"] ?? "Forecast 수동 검토"),
              description:
                `${description}\n원문: ${await reviewPostLink(db, action.reviewId)}`.slice(
                  0,
                  4_000,
                ),
              color: typeof first["color"] === "number" ? first["color"] : 0xf1c40f,
            },
          ],
        }
      : {}),
    components:
      action.step === "prompt"
        ? manualConfirmButtons(action.environment, action.decision, action.reviewId)
        : manualReviewButtons(action.environment, action.reviewId),
  });
}

function messageEmbeds(message: { embeds?: unknown }) {
  return Array.isArray(message.embeds)
    ? message.embeds.filter(
        (embed): embed is Record<string, unknown> => typeof embed === "object" && embed !== null,
      )
    : [];
}

function parseManualAction(interaction: DiscordInteraction): ManualAction | null {
  const customId = interaction.data?.custom_id;
  if (typeof customId !== "string") return null;
  // Groups: 1 environment, 2 decision, 3 "_confirm", 4 "cancel", 5 review ID.
  const match =
    /^forecast_manual_(staging|production)_(?:(requeue|ignore)(_confirm)?|(cancel)):(mr-[0-9a-f]{32})$/.exec(
      customId,
    );
  const message = (Reflect.get(interaction, "message") ?? {}) as { id?: unknown; embeds?: unknown };
  const id = String(interaction.id);
  // Never accept a coerced "undefined"/"null" as an interaction token.
  const token = typeof interaction.token === "string" ? interaction.token : "";
  const messageId = String(message.id);
  if (
    !match ||
    !/^\d{1,24}$/.test(id) ||
    !/^[A-Za-z0-9._-]{1,512}$/.test(token) ||
    !/^\d{6,24}$/.test(messageId)
  )
    return null;
  return {
    environment: match[1] === "production" ? "production" : "staging",
    step: match[4] ? "cancel" : match[3] ? "confirm" : "prompt",
    decision: match[2] === "requeue" ? "requeue" : "ignore",
    reviewId: match[5]!,
    id,
    token,
    messageId,
    customId,
    embeds: messageEmbeds(message),
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

function boundMessage(db: D1Database, action: ManualAction) {
  return db
    .prepare(`SELECT alert_key FROM forecast_ops_alerts
    WHERE environment=? AND discord_message_id=? AND json_extract(context_json,'$.reviewId')=?`)
    .bind(action.environment, action.messageId, action.reviewId)
    .first();
}

async function boundManualReview(db: D1Database, action: ManualAction, backend: ManualBackend) {
  if (!(await boundMessage(db, action))) return null;
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
    embeds: Record<string, unknown>[];
  },
  backend: ManualBackend,
) {
  let failure: string | null = null;
  // Only the execution that actually applied the decision announces it.
  let applied = false;
  try {
    if (!input.alreadyResolved) {
      const result = await backend.decideManualReview(
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
      applied = result.idempotent !== true;
    }
    await db
      .prepare(`UPDATE discord_interaction_audit SET result='completed',completed_at=?,error_code=NULL
      WHERE interaction_id=?`)
      .bind(new Date().toISOString(), input.id)
      .run();
  } catch (error) {
    failure =
      error instanceof Error
        ? (error.message.match(/manual_review_[a-z_]+/)?.[0] ?? "manual_review_failed")
        : "manual_review_failed";
    await db
      .prepare(`UPDATE discord_interaction_audit SET result='failed',error_code=?,completed_at=?
      WHERE interaction_id=?`)
      .bind(failure, new Date().toISOString(), input.id)
      .run();
  }
  const { original, followUp } = await manualOutcome(db, input, { applied, failure }, backend);
  const webhook = `https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${encodeURIComponent(input.token)}`;
  // Each call is attempted independently so a rejected edit still confirms the decision.
  for (const [method, url, body] of [
    ["PATCH", `${webhook}/messages/@original`, original],
    ["POST", webhook, followUp],
  ] as const) {
    if (!body) continue;
    const code = await sendWebhook(method, url, body);
    if (code)
      await db
        .prepare("UPDATE discord_interaction_audit SET error_code=? WHERE interaction_id=?")
        .bind(code, input.id)
        .run();
  }
}

// Render from the stored outcome: a concurrent confirm may have resolved it first.
async function manualOutcome(
  db: D1Database,
  input: {
    environment: "staging" | "production";
    decision: ManualDecision;
    reviewId: string;
    actor: string;
    alreadyResolved: boolean;
    embeds: Record<string, unknown>[];
  },
  { applied, failure }: { applied: boolean; failure: string | null },
  backend: ManualBackend,
): Promise<{ original: object; followUp: object | null }> {
  const review = await backend.readManualReview(db, input.reviewId);
  const resolved =
    review?.state === "resolved" && (review.decision === "requeue" || review.decision === "ignore")
      ? review.decision
      : null;
  return resolved
    ? {
        original: doneMessage(input.embeds, resolved, input.actor),
        // Only the interaction that applied the decision announces it publicly.
        followUp: !applied
          ? null
          : {
              content: `✅ ${await reviewPostLink(db, input.reviewId)} — ${MANUAL_DECISION_LABELS[resolved]}${resolved === "ignore" ? "으로" : "로"} 처리했습니다.`,
            },
      }
    : {
        // Restore the decision buttons so the owner can retry; explain privately.
        original: { components: manualReviewButtons(input.environment, input.reviewId) },
        followUp: {
          content: `${MANUAL_DECISION_LABELS[input.decision]} 처리가 적용되지 않았습니다(${failure ?? "manual_review_failed"}). 잠시 후 다시 눌러 주세요.`,
          flags: 64,
        },
      };
}

async function sendWebhook(method: "PATCH" | "POST", url: string, body: object) {
  try {
    const response = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(8_000),
    });
    await response.body?.cancel();
    return response.ok ? null : "manual_review_discord_response_failed";
  } catch {
    return "manual_review_discord_transport_failed";
  }
}

function doneMessage(embeds: Record<string, unknown>[], decision: ManualDecision, actor: string) {
  const label = MANUAL_DECISION_LABELS[decision];
  const outcome = `**처리됨: ${label}** · <@${actor}> · ${kstMinute(new Date())}`;
  const [first] = embeds;
  return {
    // Rebuild from known fields only; never echo response-only embed properties.
    ...(first
      ? {
          embeds: [
            {
              title: String(first["title"] ?? "Forecast 수동 검토"),
              description: `${String(first["description"] ?? "")}\n\n${outcome}`.slice(0, 4_000),
              color: 0x2ecc71,
            },
          ],
        }
      : {}),
    components: manualDoneButtons(`처리됨: ${label}`),
  };
}

async function reviewPostLink(db: D1Database, reviewId: string) {
  const post = await db
    .prepare(`SELECT q.title,q.url FROM source_manual_reviews r
    JOIN source_queue q ON q.source=r.source AND q.item_id=r.item_id WHERE r.review_id=?`)
    .bind(reviewId)
    .first<{ title: string | null; url: string | null }>();
  if (!post) return "검토 항목";
  const title = forecastDisplayText(post.title ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return manualReviewPostLink(title || "Naver 일정 게시물", post.url ?? "");
}

function updateMessage(data: object) {
  return Response.json(
    { type: 7, data: { ...data, allowed_mentions: { parse: [] } } },
    { headers: { "cache-control": "no-store" } },
  );
}

function kstMinute(date: Date) {
  return `${new Date(date.getTime() + 9 * 3_600_000).toISOString().slice(0, 16).replace("T", " ")} KST`;
}

function ephemeral(content: string) {
  return Response.json(
    { type: 4, data: { content, flags: 64 } },
    { headers: { "cache-control": "no-store" } },
  );
}
