import { readBoundedText } from "../../shared/boundedHttp.ts";
import {
  CERTIFIED_EVIDENCE_COVERAGE,
  type CertifiedEvidenceCoverage,
} from "../../shared/certifiedEvidenceCoverage.ts";
import {
  parseDiscordInteraction,
  readVerifiedDiscordBody,
} from "../../shared/discordInteraction.ts";
import { errorCode, isD1TriggerAbort } from "../../shared/errorCodes.ts";
import {
  applyPublicationCommand,
  bindDirectReviewMessage,
  type CommandInput,
  candidateCoverageError,
  createPreviousRollbackReview,
  createReview,
  type ReviewRow,
  readActive,
  readReview,
  readSealedCandidate,
} from "../../shared/forecast-publication/store.ts";
import { importPublicationSigningKey } from "../../shared/forecastPublication.ts";
import { kstLabel } from "../../shared/kst.ts";
import { assertUsageAllowed, UsageGuardError } from "../../shared/usageGuard.ts";
import type { InteractionRouterEnv } from "./types.ts";
import { handleV2Interaction } from "./v2-interactions.ts";

/** Discord's signature is already verified here; an unparseable body is an expected
 * 400 client error, so the parse outcome is returned explicitly instead of swallowed. */
function parseSignedJson(body: string): { value: unknown } | null {
  try {
    return { value: JSON.parse(body) as unknown };
  } catch {
    return null;
  }
}

/** The deployed export below closes over the real registry, never request/env data. */
export const createInteractionWorker = (
  coverage: readonly CertifiedEvidenceCoverage[] = CERTIFIED_EVIDENCE_COVERAGE,
) =>
  ({
    async fetch(request: Request, env, context) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return health(env);
      }
      if (request.method !== "POST" || url.pathname !== "/discord/interactions")
        return new Response("Not found", { status: 404 });
      const body = await readVerifiedDiscordBody(request, env.DISCORD_PUBLIC_KEY, Date.now());
      if (body instanceof Response) return body;
      // The shared legacy parser intentionally accepts buttons only; route signed
      // v2 modal submissions here without broadening legacy interaction support.
      const signedBody = parseSignedJson(body);
      if (!signedBody) return new Response("Invalid JSON", { status: 400 });
      const v2 = signedBody.value as Parameters<typeof handleV2Interaction>[0];
      if (typeof v2?.data?.custom_id === "string" && /^fv2m?:/.test(v2.data.custom_id))
        return handleV2Interaction(v2, env, context);
      const interaction = parseDiscordInteraction(body, env.DISCORD_APPLICATION_ID);
      if (interaction instanceof Response) return interaction;
      if (interaction.type === 1) return reply({ type: 1 });
      const customId = interaction.data?.custom_id;
      if (
        env.FORECAST_ENVIRONMENT === "staging" &&
        typeof customId === "string" &&
        /^(forecast_publish:production:|forecast_manual_production_)/.test(customId)
      )
        return ephemeral(
          "production actions are disabled on this deployment. No changes were made.",
        );
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
      const db = environment === "staging" ? env.STAGING_FORECAST_DB : env.PRODUCTION_FORECAST_DB;
      if (!db)
        return ephemeral(
          `${environment} actions are disabled on this deployment. No changes were made.`,
        );
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
      context.waitUntil(complete(env, db, input, interaction.token, coverage));
      return reply({ type: 5, data: { flags: 0 } });
    },
  }) satisfies ExportedHandler<InteractionRouterEnv>;
export default createInteractionWorker();

async function complete(
  env: InteractionRouterEnv,
  db: D1Database,
  input: CommandInput,
  token: string,
  coverage: readonly CertifiedEvidenceCoverage[],
) {
  let message: PublicationResponse;
  let review: ReviewRow | undefined;
  try {
    review = await readReview(db, input);
    message = await publicationResponse(env, db, input, review, coverage);
  } catch (error) {
    message = {
      content: publicationFailedContent(errorCode(error, "publication"), review?.action),
    };
  }
  await deliverPublicationResponse(env, db, input, token, message);
}

type PublicationResponse = { content: string; directReviewIds?: string[]; components?: object[] };

async function publicationResponse(
  env: InteractionRouterEnv,
  db: D1Database,
  input: CommandInput,
  review: ReviewRow,
  coverage: readonly CertifiedEvidenceCoverage[],
): Promise<PublicationResponse> {
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
      coverage,
    );
  } catch (error) {
    // `runtime_activation_stale` is a D1 trigger abort. The branch compares the registered
    // token against the driver message (whole word, any layout) instead of depending on
    // the exact shape the sanitizer recognises; what is rendered is a registered code
    // either way, never text read out of the message.
    const code = isD1TriggerAbort(error, "runtime_activation_stale")
      ? "runtime_activation_stale"
      : errorCode(error, "publication");
    if (
      ![
        "publication_review_expired",
        "publication_review_stale",
        "runtime_activation_stale",
      ].includes(code)
    )
      throw error;
    if (review.action === "approve")
      return {
        content: publicationNotAppliedContent(
          code,
          "이미 지난 승인 요청입니다. 만료되었거나 다른 요청이 먼저 반영되었습니다",
        ),
      };
    if (review.action === "rollback") {
      const target = await readSealedCandidate(db, review.candidate_id!);
      if (candidateCoverageError(target.candidate, coverage))
        return {
          content: publicationNotAppliedContent(
            code,
            "되돌릴 대상 후보의 근거 자료가 부족해 롤백을 확인할 수 없습니다",
          ),
        };
    }
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
      publicationStaleContent(input.environment, review.action),
      "reconfirm",
    );
  }
  const content = publicationAppliedContent({
    environment: input.environment,
    action: review.action,
    sequence: result.sequence,
    duplicate: result.duplicate,
    interactionId: input.interactionId,
  });
  // Every active result offers off immediately, including the first approval and
  // a rollback. Off results offer rollback to their previous approved artifact.
  try {
    const active = await readActive(db, input.environment);
    if (active.operation_id === input.interactionId && active.sequence === result.sequence) {
      const ids: string[] = [];
      const rollback = await createPreviousRollbackReview(
        db,
        active,
        now,
        input.interactionId,
        coverage,
      );
      if (rollback) ids.push(rollback);
      if (active.candidate_id)
        ids.push(await createReview(db, active, "off", null, null, now, input.interactionId));
      if (ids.length) return await emergencyConfirmation(db, ids, content, "optional");
    }
  } catch (error) {
    // The activation already committed; never report a failed publication or undo it.
    return {
      content: `${content}\n📌 다음 단계 확인 불가: 되돌리기·끄기 버튼을 만들지 못했습니다(${errorCode(error, "publication")}). 이 작업의 반영 결과는 취소되지 않았습니다.`,
    };
  }
  return { content };
}

/** Korean action names; branch logic and routing stay on the raw action value. */
const ACTION_KO = { approve: "승인", rollback: "롤백", off: "끄기" } as const;

function publicationFailedContent(code: string, action?: ReviewRow["action"]) {
  let label = "";
  if (action) label = action === "rollback" ? "되돌리기" : ACTION_KO[action];
  return (
    `**Forecast ${label ? `${label} ` : ""}처리 실패** · 오류 코드: \`${code}\`\n` +
    "❌ 무슨 일이: 버튼을 눌렀지만 처리를 끝내지 못했습니다. 아직 사이트 내용은 바뀌지 않았습니다.\n" +
    "📌 영향: 이 검토는 그대로 남아 있습니다. 같은 버튼을 한 번 더 눌러 다시 시도할 수 있습니다.\n" +
    "🕔 만료되면: 만료된 검토는 적용되지 않으며, 그때는 새 검토 메시지의 버튼을 사용해야 합니다.\n" +
    "👉 해 주실 일: 한 번 다시 눌러 보시고, 같은 오류가 반복되면 이 코드를 운영자에게 알려 주세요."
  );
}

function publicationNotAppliedContent(code: string, reason: string) {
  return (
    `**Forecast 반영 안 됨** · 오류 코드: \`${code}\`\n` +
    `❌ 무슨 일이: ${reason}. 아무것도 반영되지 않았습니다.\n` +
    "📌 영향: 사이트는 이전 상태 그대로입니다.\n" +
    "👉 해 주실 일: 필요한 경우 가장 최신 검토 메시지의 버튼을 사용해 주세요. 이 메시지의 버튼을 다시 누르지 마세요."
  );
}

function publicationStaleContent(environment: string, action: string) {
  const ko = ACTION_KO[action as keyof typeof ACTION_KO] ?? action;
  return (
    `**Forecast 확인 필요** · 환경: ${environment}\n` +
    "❌ 무슨 일이: 누르신 검토가 그사이 만료되었거나 현재 상태와 맞지 않아 그대로는 적용되지 않았습니다. 아무것도 반영되지 않았습니다.\n" +
    `📌 영향: 아래 새 확인 버튼은 지금 상태 기준으로 다시 만든 ${ko} 요청입니다.\n` +
    "🕔 그대로 두면: 만료 시각이 지나면 아무것도 바뀌지 않습니다.\n" +
    "👉 해 주실 일: 계속 진행하려면 아래 버튼을 다시 눌러 주세요. 진행하지 않으려면 무시하시면 됩니다."
  );
}

function publicationAppliedContent(input: {
  environment: string;
  action: string;
  sequence: number;
  duplicate: boolean;
  interactionId: string;
}) {
  const ko = ACTION_KO[input.action as keyof typeof ACTION_KO] ?? input.action;
  const outcome =
    input.action === "off"
      ? "이 작업은 사이트 예보를 끄기로 처리했습니다."
      : "이 작업은 사이트 예보를 요청한 후보 내용으로 반영했습니다.";
  return (
    `**Forecast ${ko} 반영 완료** · 환경: ${input.environment}\n` +
    `✅ 처리 결과: ${input.duplicate ? "이미 처리된 요청이라 다시 반영하지 않았습니다(중복 클릭). 원래 처리 결과를 안내합니다." : "요청대로 반영했습니다."} 처리 당시 순번은 ${input.sequence}입니다.\n` +
    `📌 영향: ${outcome} 이후 다른 작업으로 상태가 바뀌었을 수 있습니다.\n` +
    "👉 해 주실 일: 할 일 없음.\n" +
    `기록용: 시퀀스 ${input.sequence} · 작업 ${input.interactionId}`
  );
}

async function emergencyConfirmation(
  db: D1Database,
  reviewIds: string[],
  content: string,
  mode: "optional" | "reconfirm",
): Promise<PublicationResponse> {
  const details: string[] = [];
  const buttons: object[] = [];
  for (const reviewId of reviewIds) {
    const review = await db
      .prepare("SELECT * FROM forecast_runtime_reviews WHERE review_id=?")
      .bind(reviewId)
      .first<ReviewRow>();
    if (!review) throw new Error("publication_review_missing");
    const hash = review.payload_hash ? `· SHA-256: ${review.payload_hash.slice(0, 12)}…` : "";
    const consequence = review.action === "off" ? "예보가 꺼집니다" : "이전 후보로 되돌아갑니다";
    const instruction =
      mode === "optional"
        ? `🛟 비상 조치(선택): 문제가 있을 때만 아래 버튼을 누르세요. 누르면 현재 순번 ${review.expected_sequence} 기준으로 ${consequence}. 필요 없으면 누르지 마세요.`
        : `🔁 확인 필요: 현재 순번 ${review.expected_sequence}에 대해 ${ACTION_KO[review.action]} 버튼을 눌러 확정합니다.`;
    details.push(
      instruction +
        `\n· 대상 후보: ${review.candidate_id ?? "없음(끄기)"}${hash ? `\n${hash}` : ""}` +
        `\n· 만료: ${kstLabel(new Date(review.expires_at).toISOString())} KST (누르지 않으면 추가 변경 없음)`,
    );
    buttons.push({
      type: 2,
      style: 4,
      label: `${ACTION_KO[review.action]} 확인 (${review.environment})`,
      custom_id: `forecast_publish:${review.environment}:${reviewId}`,
    });
  }
  return {
    directReviewIds: reviewIds,
    content: `${content}\n${details.join("\n\n")}`,
    components: [{ type: 1, components: buttons }],
  };
}

/** Discarding an unread Discord body can itself reject; the delivery outcome is already
 * committed to the outbox, so the discard failure is recorded, not surfaced. */
async function discardResponseBody(response: Response, interactionId: string) {
  try {
    await response.body?.cancel();
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "publication_discord_body_discard_failed",
        interactionId,
        code: errorCode(error),
      }),
    );
  }
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
      await discardResponseBody(response, input.interactionId);
    }
  } catch (error) {
    // Never roll back a committed decision for a delivery failure. The atomic result outbox
    // survives Worker restarts, and replay of the interaction returns its recorded outcome.
    console.warn(
      JSON.stringify({
        event: "publication_discord_response_failed",
        interactionId: input.interactionId,
        code: errorCode(error, "publication"),
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

/** Expected configuration check, not a hidden failure: a missing or unusable key makes every
 * caller report `publication_signing_key_unavailable` and keep publication disabled, so the
 * unusable outcome is a deliberate `false` rather than a swallowed error. */
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
  const productionDb =
    env.FORECAST_ENVIRONMENT === "staging" ? undefined : env.PRODUCTION_FORECAST_DB;
  const [staging, production] = await Promise.all([
    healthRow(env.STAGING_FORECAST_DB),
    productionDb ? healthRow(productionDb) : undefined,
  ]);
  const keyAvailable = await publicationKeyAvailable(env);
  return reply({
    status: "ok",
    deploymentSha: env.DEPLOY_SHA,
    productionMutationsEnabled: !!productionDb && env.PRODUCTION_MUTATIONS_ENABLED === "true",
    stagingPublication: env.STAGING_PUBLICATION_MODE === "enabled" && keyAvailable,
    productionPublication:
      !!productionDb &&
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
  // v2 decision buttons are recorded separately (migration 0031); older schemas omit the field.
  const v2 =
    version >= 31
      ? await db
          .prepare(
            "SELECT consumed_at FROM forecast_v2_consumed_interactions ORDER BY consumed_at DESC LIMIT 1",
          )
          .first<{ consumed_at: string }>()
      : undefined;
  return {
    schemaVersion: version,
    latestInteraction: audit ? { result: audit.result, receivedAt: audit.received_at } : null,
    ...(v2 === undefined
      ? {}
      : { latestV2Interaction: v2 ? { consumedAt: v2.consumed_at } : null }),
  };
}
