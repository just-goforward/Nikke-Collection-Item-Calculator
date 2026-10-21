import { errorCode } from "../../shared/errorCodes.ts";
import { publicationBytesHash as sha256Hex } from "../../shared/forecastPublicationBytes.ts";
import { assertUsageAllowed } from "../../shared/usageGuard.ts";
import type { InteractionRouterEnv } from "./types.ts";

type DecisionPayload = {
  env: "staging" | "production";
  eventId: string | null;
  sourceHash: string;
  sourceVersion: string;
  feedIds: number[];
  title: string;
  url: string;
  options: { id: string; label: string }[];
  extracted?: {
    complete?: boolean;
    startAt?: string;
    endAt?: string;
    segments?: unknown[];
    kits?: unknown[];
  };
};
type DecisionResult = (
  | { action: "opt"; optionId: string }
  | { action: "bok" | "bno" }
  | { action: "edit"; startAt: string; endAt: string }
) & { actorId: string; decidedAt: string; expectedRevision: number };

type V2Interaction = {
  id?: string;
  application_id?: string;
  token?: string;
  type?: number;
  guild_id?: string;
  channel_id?: string;
  member?: { user?: { id?: string } };
  message?: { id?: string };
  data?: { custom_id?: string; component_type?: number; components?: unknown[] };
};
const denied = () =>
  reply(4, {
    content:
      "만료되었거나 대기 중이 아닌 요청입니다. 이미 처리되었거나 최신 요청으로 대체되었을 수 있습니다.",
    flags: 64,
  });
function reply(type: number, data: object) {
  return Response.json(
    { type, data: { ...data, allowed_mentions: { parse: [] } } },
    { headers: { "cache-control": "no-store" } },
  );
}
export function kstInput(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)) throw new Error("invalid_time");
  const iso = `${value.replace(" ", "T")}:00+09:00`;
  const at = Date.parse(iso);
  if (
    !Number.isFinite(at) ||
    new Date(at + 9 * 3600000).toISOString().slice(0, 16).replace("T", " ") !== value
  )
    throw new Error("invalid_time");
  return iso;
}
function prefill(value: string | undefined) {
  return value && Number.isFinite(Date.parse(value))
    ? new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 16).replace("T", " ")
    : "";
}
function fields(components: unknown[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const raw of components) {
    if (!raw || typeof raw !== "object") throw new Error("invalid_field");
    const nested = Reflect.get(raw, "components");
    const items = Array.isArray(nested) ? nested : [Reflect.get(raw, "component")];
    for (const item of items) {
      if (!item || typeof item !== "object") throw new Error("invalid_field");
      const id = Reflect.get(item, "custom_id"),
        value = Reflect.get(item, "value");
      if (!["start", "end"].includes(id) || typeof value !== "string" || result.has(id))
        throw new Error("invalid_field");
      result.set(id, value);
    }
  }
  return result;
}
function parseAction(interaction: V2Interaction, env: InteractionRouterEnv) {
  const id = interaction.data?.custom_id ?? "";
  const modal = id.startsWith("fv2m:");
  const match = modal
    ? /^fv2m:(s|p):([A-Za-z0-9_-]+):(0|[1-9]\d*)$/.exec(id)
    : /^fv2:(s|p):(opt|bok|bedit|bno):([A-Za-z0-9_-]+):(0|[1-9]\d*)(?::([A-Za-z0-9_-]+))?$/.exec(
        id,
      );
  if (!match || id.length > 100) throw new Error("invalid_action");
  const action = modal ? "edit" : match[2];
  const decisionId = match[modal ? 2 : 3];
  const revision = Number(match[modal ? 3 : 4]);
  const option = modal ? undefined : match[5];
  // V2 production mutations remain disabled, even on the legacy shared endpoint.
  if (match[1] !== "s" || env.FORECAST_ENVIRONMENT !== "staging") throw new Error("environment");
  if (!Number.isSafeInteger(revision) || (action === "opt" ? !option : option !== undefined))
    throw new Error("invalid_action");
  return { modal, action, decisionId, revision, option };
}
type Action = ReturnType<typeof parseAction>;
function permitsAction(
  type: string,
  action: string | undefined,
  payload: DecisionPayload,
  option: string | undefined,
) {
  if (action === "opt")
    return type !== "solo_review" && payload.options.some((o) => o.id === option);
  if (action === "bedit" || action === "edit")
    return ["solo_review", "collaboration", "maintenance"].includes(type);
  if (action === "bok") return type === "solo_review" && payload.extracted?.complete === true;
  return type === "solo_review";
}
function authorizeIdentity(interaction: V2Interaction, env: InteractionRouterEnv) {
  if (
    interaction.application_id !== env.DISCORD_APPLICATION_ID ||
    interaction.guild_id !== env.DISCORD_GUILD_ID ||
    interaction.channel_id !== env.DISCORD_APPROVAL_CHANNEL_ID ||
    interaction.member?.user?.id !== env.DISCORD_FORECAST_APPROVER_USER_ID ||
    !/^\d{1,24}$/.test(interaction.id ?? "") ||
    !/^\d{6,24}$/.test(interaction.message?.id ?? "")
  )
    throw new Error("unauthorized");
}
function authorizeType(interaction: V2Interaction, modal: boolean) {
  if (
    (modal
      ? interaction.type !== 5
      : interaction.type !== 3 || interaction.data?.component_type !== 2) ||
    (modal && !/^[A-Za-z0-9._-]{1,512}$/.test(interaction.token ?? ""))
  )
    throw new Error("invalid_type");
}
async function readDecision(db: D1Database, { decisionId, action, option }: Action) {
  const request = await db
    .prepare("SELECT * FROM forecast_v2_decision_requests WHERE decision_id=?")
    .bind(decisionId)
    .first<{
      payload_json: string;
      payload_hash: string;
      event_id: string | null;
      type: string;
    }>();
  if (!request || (await sha256Hex(request.payload_json)) !== request.payload_hash)
    throw new Error("invalid_request");
  const payload = JSON.parse(request.payload_json) as DecisionPayload;
  if (
    payload.env !== "staging" ||
    payload.eventId !== request.event_id ||
    !/^[0-9a-f]{64}$/.test(payload.sourceHash) ||
    !Array.isArray(payload.options) ||
    !permitsAction(request.type, action, payload, option)
  )
    throw new Error("invalid_payload");
  return { request, payload };
}
async function commitDecision(
  db: D1Database,
  interaction: V2Interaction,
  env: InteractionRouterEnv,
  action: Action,
  payloadHash: string,
  now: string,
  result: DecisionResult | undefined,
) {
  const { decisionId, revision } = action;
  const currentSource = `json_type(payload_json,'$.feedIds')='array'
      AND json_array_length(payload_json,'$.feedIds')>0
      AND NOT EXISTS (
        SELECT 1 FROM json_each(payload_json,'$.feedIds') feed
        WHERE NOT EXISTS (
          SELECT 1 FROM forecast_v2_post_versions v
          WHERE v.feed_id=CAST(feed.value AS TEXT)
            AND v.version_id=json_extract(payload_json,'$.sourceVersion')
            AND v.content_hash=json_extract(payload_json,'$.sourceHash')
            AND v.version_id=(SELECT latest.version_id FROM forecast_v2_post_versions latest
              WHERE latest.feed_id=v.feed_id
              ORDER BY julianday(latest.updated_date) DESC,julianday(latest.fetched_at) DESC,latest.version_id DESC LIMIT 1)
        ))`;
  const predicate = `${currentSource} AND decision_id=? AND status='pending' AND julianday(expires_at)>MAX(julianday(?),julianday('now'))
      AND expected_calendar_revision=? AND payload_hash=? AND json_extract(payload_json,'$.env')='staging'
      AND event_id IS json_extract(payload_json,'$.eventId')
      AND COALESCE((SELECT revision FROM forecast_v2_calendar_heads h WHERE h.event_id=forecast_v2_decision_requests.event_id),0)=?
      AND EXISTS(SELECT 1 FROM forecast_v2_notification_outbox o WHERE o.decision_id=forecast_v2_decision_requests.decision_id
        AND o.state='sent' AND o.message_id=? AND o.channel_id=? AND o.channel_role='approval')`;
  const args = [
    decisionId,
    now,
    revision,
    payloadHash,
    revision,
    interaction.message?.id,
    env.DISCORD_APPROVAL_CHANNEL_ID,
  ];
  await assertUsageAllowed(env.USAGE_GUARD_DB, "staging_automation");
  const statements = [
    db
      .prepare(`INSERT INTO forecast_v2_consumed_interactions(interaction_id,decision_id,consumed_at)
        SELECT ?,decision_id,? FROM forecast_v2_decision_requests WHERE ${predicate}`)
      .bind(interaction.id, now, ...args),
  ];
  if (result) {
    statements.push(
      db
        .prepare(`INSERT INTO forecast_v2_decision_results(decision_id,interaction_id,result_json,created_at)
          SELECT decision_id,?,?,? FROM forecast_v2_decision_requests WHERE ${predicate}`)
        .bind(interaction.id, JSON.stringify(result), now, ...args),
      db
        .prepare(`UPDATE forecast_v2_decision_requests SET status='resolved' WHERE decision_id=?
          AND EXISTS(SELECT 1 FROM forecast_v2_decision_results WHERE decision_id=? AND interaction_id=?)`)
        .bind(decisionId, decisionId, interaction.id),
    );
  }
  statements.push(
    db
      .prepare(`SELECT (${currentSource}) AS current_source
    FROM forecast_v2_decision_requests WHERE decision_id=?`)
      .bind(decisionId),
  );
  const committed = await db.batch<{ current_source: number }>(statements);
  if (committed[0]?.meta.changes !== 1 && committed.at(-1)?.results[0]?.current_source === 0)
    throw new Error("source_changed");
  return committed[0]?.meta.changes === 1;
}
function decisionResult(
  interaction: V2Interaction,
  env: InteractionRouterEnv,
  { action, option, revision }: Action,
  now: string,
): DecisionResult | undefined {
  const metadata = {
    actorId: env.DISCORD_FORECAST_APPROVER_USER_ID,
    decidedAt: now,
    expectedRevision: revision,
  };
  if (action === "edit") {
    const values = fields(interaction.data?.components ?? []);
    const startAt = kstInput(values.get("start") ?? ""),
      endAt = kstInput(values.get("end") ?? "");
    if (Date.parse(endAt) <= Date.parse(startAt)) throw new Error("invalid_range");
    return { action: "edit", startAt, endAt, ...metadata };
  } else if (action === "opt" && option) return { action: "opt", optionId: option, ...metadata };
  else if (action === "bok" || action === "bno") return { action, ...metadata };
  return undefined;
}
function editModal({ decisionId, revision }: Action, payload: DecisionPayload) {
  return reply(9, {
    custom_id: `fv2m:s:${decisionId}:${revision}`,
    title: "일정 수정",
    components: ["start", "end"].map((key) => ({
      type: 18,
      label: key === "start" ? "시작 (KST)" : "종료 (KST)",
      component: {
        type: 4,
        custom_id: key,
        style: 1,
        required: true,
        placeholder: "YYYY-MM-DD HH:mm",
        min_length: 16,
        max_length: 16,
        value: prefill(key === "start" ? payload.extracted?.startAt : payload.extracted?.endAt),
      },
    })),
  });
}
/** The webhook PATCH result is advisory; an unread body discard failure must not mask the
 * already-recorded decision, so it is logged instead of rejected. */
async function discardDiscordBody(response: Response) {
  try {
    await response.body?.cancel();
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "v2_message_body_discard_failed",
        code: errorCode(error),
      }),
    );
  }
}

function outcomeResponse(
  result: DecisionResult,
  modal: boolean,
  interaction: V2Interaction,
  env: InteractionRouterEnv,
  context: Pick<ExecutionContext, "waitUntil">,
) {
  const outcome =
    result.action === "edit"
      ? `일정 수정: ${result.startAt} → ${result.endAt}`
      : result.action === "opt"
        ? `선택: ${result.optionId}`
        : result.action === "bok"
          ? "추출 일정 확정"
          : "관련 없음";
  const content = `${outcome}\n관리자 결정이 기록되었습니다. 다음 처리에서 반영됩니다.`;
  if (!modal) return reply(7, { content, components: [] });
  context.waitUntil(
    fetch(
      `https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${encodeURIComponent(interaction.token ?? "")}/messages/@original`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, components: [], allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(8000),
      },
    )
      .then(async (response) => {
        await discardDiscordBody(response);
        if (!response.ok)
          console.warn(
            JSON.stringify({ event: "v2_message_update_failed", code: response.status }),
          );
      })
      .catch((error) => {
        console.warn(
          JSON.stringify({
            event: "v2_message_update_failed",
            code: errorCode(error),
          }),
        );
      }),
  );
  return reply(6, {});
}
export async function handleV2Interaction(
  interaction: V2Interaction,
  env: InteractionRouterEnv,
  context: Pick<ExecutionContext, "waitUntil">,
): Promise<Response> {
  try {
    const action = parseAction(interaction, env);
    authorizeIdentity(interaction, env);
    authorizeType(interaction, action.modal);
    const db = env.STAGING_FORECAST_DB;
    const { request, payload } = await readDecision(db, action);
    const now = new Date().toISOString();
    const result = decisionResult(interaction, env, action, now);
    if (!(await commitDecision(db, interaction, env, action, request.payload_hash, now, result)))
      return denied();
    if (!result) return editModal(action, payload);
    return outcomeResponse(result, action.modal, interaction, env, context);
  } catch (error) {
    if (error instanceof Error && error.message === "source_changed")
      return reply(4, {
        content: "공지가 수정되어 이 결정은 더 이상 유효하지 않습니다",
        flags: 64,
      });
    // Every rejection path (unauthorized, invalid action, stale request) answers with the
    // same public denial, so the internal reason is recorded for diagnosis.
    console.warn(
      JSON.stringify({
        event: "v2_interaction_rejected",
        code: errorCode(error),
      }),
    );
    return denied();
  }
}
