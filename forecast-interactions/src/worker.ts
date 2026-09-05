import { sha256Hex } from "../../forecast-collector/src/crypto";
import {
  approveDiscordStagingAdoption,
  approveDiscordTest,
  readApprovalById,
  readStagingAdoptionById,
} from "../../forecast-collector/src/discord-approval";
import {
  decideManualReviewFromDiscord,
  readManualReview,
} from "../../forecast-collector/src/manual-review";
import { upsertOpsAlert } from "../../forecast-collector/src/ops";
import {
  approvedData,
  CUSTOM_ID_PREFIX,
  type DiscordInteraction,
  parseDiscordInteraction,
  readVerifiedDiscordBody,
  STAGING_CUSTOM_ID_PREFIX,
  stagingApprovedData,
  unavailableApprovalData,
} from "../../shared/discordInteraction.ts";
import { assertUsageAllowed, UsageGuardError } from "../../shared/usageGuard";
import type { InteractionEnvironment, InteractionRouterEnv } from "./types";

const DISCORD_API = "https://discord.com/api/v10";
const MANUAL_CUSTOM_ID =
  /^forecast_manual_(staging|production)_(requeue|ignore):(mr-[0-9a-f]{32})$/;
const ROUTER_TEST_PREFIX = "forecast_router_test:";
const MAX_INTERACTION_TOKEN_LENGTH = 512;

type AuthorizedAction =
  | {
      kind: "manual_review";
      environment: InteractionEnvironment;
      decision: "requeue" | "ignore";
      reviewId: string;
      customId: string;
      interactionId: string;
      interactionToken: string;
      actorUserId: string;
      alreadyResolved: boolean;
    }
  | {
      kind: "staging_adoption";
      environment: "staging";
      approvalId: string;
      customId: string;
      interactionId: string;
      interactionToken: string;
      actorUserId: string;
    }
  | {
      kind: "test_approval";
      environment: "staging";
      approvalId: string;
      customId: string;
      interactionId: string;
      interactionToken: string;
      actorUserId: string;
    }
  | {
      kind: "router_test";
      environment: "staging";
      customId: string;
      interactionId: string;
      interactionToken: string;
      actorUserId: string;
    };

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return health(env);
    }
    if (request.method !== "POST" || url.pathname !== "/discord/interactions") {
      return new Response("Not found", { status: 404 });
    }
    const receivedMs = Date.now();
    const body = await readVerifiedDiscordBody(request, env.DISCORD_PUBLIC_KEY, receivedMs);
    if (body instanceof Response) return body;
    const interaction = parseDiscordInteraction(body, env.DISCORD_APPLICATION_ID);
    if (interaction instanceof Response) return interaction;
    if (interaction.type === 1) return interactionJson({ type: 1 });
    const parsedAction = authorizeAction(interaction, env);
    if (parsedAction instanceof Response) return parsedAction;
    try {
      await assertUsageAllowed(
        env.USAGE_GUARD_DB,
        parsedAction.environment === "staging"
          ? "staging_automation"
          : "production_forecast_automation",
      );
    } catch (error) {
      if (!(error instanceof UsageGuardError)) throw error;
      return ephemeral(
        `Cloudflare 월간 예산 보호 상태(${error.action})로 Forecast 변경이 중단되었습니다.`,
      );
    }
    const action = await validateActionTarget(parsedAction, env);
    if (action instanceof Response) return action;

    const db = databaseFor(env, action.environment);
    const customIdHash = await sha256Hex(action.customId);
    try {
      const inserted = await db
        .prepare(
          `INSERT OR IGNORE INTO discord_interaction_audit (
             interaction_id, environment, action, custom_id_hash, received_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          action.interactionId,
          action.environment,
          action.kind,
          customIdHash,
          new Date(receivedMs).toISOString(),
        )
        .run();
      if (Number(inserted.meta.changes ?? 0) !== 1) {
        await db
          .prepare(
            `UPDATE discord_interaction_audit SET replay_count = replay_count + 1
             WHERE interaction_id = ?`,
          )
          .bind(action.interactionId)
          .run();
        return ephemeral("이미 처리된 Discord interaction입니다.");
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "discord_router_audit_insert_failed",
          interactionId: action.interactionId,
          environment: action.environment,
          errorCode: errorCode(error),
        }),
      );
      return new Response("Service unavailable", { status: 503 });
    }

    const initialResponseAt = Date.now();
    const initialResponseMs = Math.max(0, initialResponseAt - receivedMs);
    context.waitUntil(
      recordInitialResponse(db, action.interactionId, initialResponseAt, initialResponseMs),
    );
    context.waitUntil(completeAction(env, action, receivedMs));
    return interactionJson({ type: 6 });
  },
} satisfies ExportedHandler<InteractionRouterEnv>;

async function recordInitialResponse(
  db: D1Database,
  interactionId: string,
  responseAtMs: number,
  responseMs: number,
) {
  try {
    await db
      .prepare(
        `UPDATE discord_interaction_audit
         SET initial_response_at = ?, initial_response_ms = ?
         WHERE interaction_id = ? AND initial_response_at IS NULL`,
      )
      .bind(new Date(responseAtMs).toISOString(), responseMs, interactionId)
      .run();
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "discord_router_initial_response_audit_failed",
        interactionId,
        errorCode: errorCode(error),
      }),
    );
  }
}

function authorizeAction(interaction: DiscordInteraction, env: InteractionRouterEnv) {
  if (interaction.guild_id !== env.DISCORD_GUILD_ID) {
    return ephemeral("허용된 Discord 서버에서만 처리할 수 있습니다.");
  }
  const actorUserId = interaction.member?.user?.id ?? interaction.user?.id;
  if (actorUserId !== env.DISCORD_APPROVER_USER_ID) {
    return ephemeral("이 작업을 수행할 권한이 없습니다.");
  }
  const interactionId = matchingString(interaction.id, /^\d{1,24}$/);
  const interactionToken = boundedString(interaction.token, MAX_INTERACTION_TOKEN_LENGTH);
  const customId = boundedString(interaction.data?.custom_id, 100);
  if (!interactionId || !interactionToken || !customId) {
    return ephemeral("유효하지 않은 Discord 버튼입니다.");
  }

  const manual = customId.match(MANUAL_CUSTOM_ID);
  if (manual?.[1] && manual[2] && manual[3]) {
    if (interaction.channel_id !== env.DISCORD_ALERT_CHANNEL_ID) {
      return ephemeral("수급량 운영 경고 채널에서만 처리할 수 있습니다.");
    }
    const environment = manual[1] as InteractionEnvironment;
    if (environment === "production" && env.PRODUCTION_MUTATIONS_ENABLED !== "true") {
      return ephemeral("production Forecast 수동 처리는 아직 활성화되지 않았습니다.");
    }
    const decision = manual[2] as "requeue" | "ignore";
    const reviewId = manual[3];
    return {
      kind: "manual_review" as const,
      environment,
      decision,
      reviewId,
      customId,
      interactionId,
      interactionToken,
      actorUserId,
      alreadyResolved: false,
    };
  }

  if (customId.startsWith(STAGING_CUSTOM_ID_PREFIX)) {
    if (interaction.channel_id !== env.DISCORD_APPROVAL_CHANNEL_ID) {
      return ephemeral("수급량 승인 채널에서만 처리할 수 있습니다.");
    }
    const approvalId = customId.slice(STAGING_CUSTOM_ID_PREFIX.length);
    return {
      kind: "staging_adoption" as const,
      environment: "staging" as const,
      approvalId,
      customId,
      interactionId,
      interactionToken,
      actorUserId,
    };
  }

  if (customId.startsWith(CUSTOM_ID_PREFIX)) {
    if (interaction.channel_id !== env.DISCORD_APPROVAL_CHANNEL_ID) {
      return ephemeral("수급량 승인 채널에서만 처리할 수 있습니다.");
    }
    const approvalId = customId.slice(CUSTOM_ID_PREFIX.length);
    return {
      kind: "test_approval" as const,
      environment: "staging" as const,
      approvalId,
      customId,
      interactionId,
      interactionToken,
      actorUserId,
    };
  }

  if (customId.startsWith(ROUTER_TEST_PREFIX)) {
    if (
      interaction.channel_id !== env.DISCORD_ACTIVITY_CHANNEL_ID &&
      interaction.channel_id !== env.DISCORD_APPROVAL_CHANNEL_ID
    ) {
      return ephemeral("수급량 활동 또는 승인 채널에서만 테스트할 수 있습니다.");
    }
    if (!/^forecast_router_test:[0-9a-f]{32}$/.test(customId)) {
      return ephemeral("유효하지 않은 Router 테스트 버튼입니다.");
    }
    return {
      kind: "router_test" as const,
      environment: "staging" as const,
      customId,
      interactionId,
      interactionToken,
      actorUserId,
    };
  }
  return ephemeral("지원하지 않는 Forecast 작업입니다.");
}

async function validateActionTarget(action: AuthorizedAction, env: InteractionRouterEnv) {
  if (action.kind === "manual_review") {
    const review = await readManualReview(databaseFor(env, action.environment), action.reviewId);
    if (!review) return ephemeral("검토 항목이 만료되었거나 이미 처리되었습니다.");
    const alreadyResolved = review.state === "resolved" && review.decision === action.decision;
    if (review.state !== "pending" && !alreadyResolved) {
      return ephemeral("검토 항목이 만료되었거나 이미 처리되었습니다.");
    }
    return { ...action, alreadyResolved };
  }
  if (action.kind === "staging_adoption") {
    const row = await readStagingAdoptionById(env.STAGING_FORECAST_DB, action.approvalId);
    if (!row || !["pending", "approved", "adoption_pr_created"].includes(row.state)) {
      return ephemeral("staging 승인 대상이 만료되었거나 존재하지 않습니다.");
    }
  }
  if (action.kind === "test_approval") {
    const row = await readApprovalById(env.STAGING_FORECAST_DB, action.approvalId);
    if (!row || !["pending", "test_approved"].includes(row.state)) {
      return ephemeral("테스트 승인 대상이 만료되었거나 존재하지 않습니다.");
    }
  }
  return action;
}

async function completeAction(
  env: InteractionRouterEnv,
  action: AuthorizedAction,
  receivedMs: number,
) {
  const db = databaseFor(env, action.environment);
  try {
    const data = await actionResult(db, action);
    await updateOriginalMessage(env.DISCORD_APPLICATION_ID, action.interactionToken, data);
    await db
      .prepare(
        `UPDATE discord_interaction_audit
         SET completed_at = ?, result = 'completed', error_code = NULL
         WHERE interaction_id = ? AND completed_at IS NULL`,
      )
      .bind(new Date().toISOString(), action.interactionId)
      .run();
    console.log(
      JSON.stringify({
        event: "discord_router_action_completed",
        environment: action.environment,
        action: action.kind,
        interactionId: action.interactionId,
        totalMs: Date.now() - receivedMs,
      }),
    );
  } catch (error) {
    const code = errorCode(error);
    try {
      await db
        .prepare(
          `UPDATE discord_interaction_audit
           SET completed_at = ?, result = 'failed', error_code = ?
           WHERE interaction_id = ? AND completed_at IS NULL`,
        )
        .bind(new Date().toISOString(), code, action.interactionId)
        .run();
      await upsertOpsAlert(db, {
        alertKey: `discord-interaction:${action.environment}:${code}`,
        environment: action.environment,
        severity: "critical",
        component: "discord-router",
        errorCode: code,
        context: { action: action.kind, interactionId: action.interactionId },
      });
    } catch (auditError) {
      console.error(
        JSON.stringify({
          event: "discord_router_failure_audit_failed",
          environment: action.environment,
          action: action.kind,
          interactionId: action.interactionId,
          errorCode: code,
          auditErrorCode: errorCode(auditError),
        }),
      );
    }
  }
}

async function actionResult(db: D1Database, action: AuthorizedAction) {
  if (action.kind === "manual_review") {
    if (action.alreadyResolved) {
      return manualReviewCompletedData(
        await readManualReview(db, action.reviewId),
        action.environment,
        action.decision,
      );
    }
    const result = await decideManualReviewFromDiscord(
      db,
      action.environment,
      action.reviewId,
      action.decision,
      action.actorUserId,
      action.interactionId,
    );
    return manualReviewCompletedData(result.review, action.environment, action.decision);
  }
  if (action.kind === "staging_adoption") {
    const result = await approveDiscordStagingAdoption(
      db,
      action.approvalId,
      action.interactionId,
      action.actorUserId,
      Date.now(),
    );
    if (result.outcome === "approved" || result.outcome === "already_approved") {
      return stagingApprovedData(result.approval, action.customId);
    }
    return unavailableApprovalData("staging 승인 대상이 만료되었거나 존재하지 않습니다.");
  }
  if (action.kind === "test_approval") {
    const result = await approveDiscordTest(
      db,
      action.approvalId,
      action.interactionId,
      action.actorUserId,
      Date.now(),
    );
    if (result.outcome === "approved" || result.outcome === "already_approved") {
      return approvedData(result.approval, action.customId);
    }
    return unavailableApprovalData("테스트 승인 대상이 만료되었거나 존재하지 않습니다.");
  }
  return {
    content:
      "Forecast Discord Interaction Router 테스트가 완료되었습니다. Forecast와 PR은 변경되지 않았습니다.",
    embeds: [],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 2,
            custom_id: action.customId,
            label: "Router 테스트 완료",
            disabled: true,
          },
        ],
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

function manualReviewCompletedData(
  review: Awaited<ReturnType<typeof readManualReview>>,
  environment: InteractionEnvironment,
  decision: "requeue" | "ignore",
) {
  if (!review) throw new Error("manual_review_missing_after_discord_decision");
  const label = decision === "requeue" ? "재처리 대기" : "관련 없음 처리";
  return {
    content: `Manual review \`${review.reviewId}\`가 ${label} 상태로 처리되었습니다.`,
    embeds: [],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 5, label: "원문 열기", url: review.sourceItem.url },
          {
            type: 2,
            style: decision === "requeue" ? 1 : 2,
            custom_id: `forecast_manual_${environment}_${decision}:${review.reviewId}`,
            label,
            disabled: true,
          },
        ],
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

async function updateOriginalMessage(applicationId: string, token: string, data: object) {
  const response = await fetch(
    `${DISCORD_API}/webhooks/${applicationId}/${encodeURIComponent(token)}/messages/@original`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(8_000),
    },
  );
  if (!response.ok) throw new Error(`discord_interaction_webhook_${response.status}`);
  await response.body?.cancel();
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
  return Response.json(
    {
      status: "ok",
      deploymentSha: env.DEPLOY_SHA,
      productionMutationsEnabled: env.PRODUCTION_MUTATIONS_ENABLED === "true",
      databases: { staging, production },
    },
    { headers: { "cache-control": "no-store" } },
  );
}

async function healthRow(db: D1Database) {
  const migration = await db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .first<{ version: number | null }>();
  const version = Number(migration?.version ?? 0);
  const audit =
    version >= 8
      ? await db
          .prepare(
            `SELECT result, received_at FROM discord_interaction_audit
             ORDER BY received_at DESC LIMIT 1`,
          )
          .first<{ result: string | null; received_at: string }>()
      : null;
  return {
    schemaVersion: version,
    latestInteraction: audit ? { result: audit.result, receivedAt: audit.received_at } : null,
  };
}

function databaseFor(env: InteractionRouterEnv, environment: InteractionEnvironment) {
  return environment === "production" ? env.PRODUCTION_FORECAST_DB : env.STAGING_FORECAST_DB;
}

function matchingString(value: unknown, pattern: RegExp) {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function boundedString(value: unknown, maxLength: number) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : null;
}

function errorCode(error: unknown) {
  const value = error instanceof Error ? error.message : "unknown";
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "unknown";
}

function ephemeral(content: string) {
  return interactionJson({ type: 4, data: { content, flags: 64 } });
}

function interactionJson(value: unknown) {
  return Response.json(value, { headers: { "cache-control": "no-store" } });
}
