import type { CollectorEnv } from "./types";

const DISCORD_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;
const DISCORD_INTERACTION_MAX_BYTES = 64 * 1024;
const TEST_APPROVAL_TTL_MS = 30 * 60 * 1000;
const CUSTOM_ID_PREFIX = "forecast_test_approve:";
const REPOSITORY_PATH = "/just-goforward/Nikke-Collection-Item-Calculator";

export type DiscordApprovalTestInput = {
  requestKey: string;
  candidateId: string;
  forecastId: string;
  payloadHash: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  headSha: string;
};

type DiscordApprovalTestRow = {
  approval_id: string;
  request_key: string;
  candidate_id: string;
  forecast_id: string;
  payload_hash: string;
  pull_request_number: number;
  pull_request_url: string;
  head_sha: string;
  state: "pending" | "test_approved" | "expired";
  created_at: string;
  expires_at: string;
  approved_at: string | null;
  approver_user_id: string | null;
  interaction_id: string | null;
};

type DiscordInteraction = {
  id?: unknown;
  application_id?: unknown;
  type?: unknown;
  guild_id?: unknown;
  channel_id?: unknown;
  member?: { user?: { id?: unknown } };
  user?: { id?: unknown };
  data?: { custom_id?: unknown; component_type?: unknown };
};

export async function createDiscordApprovalTest(
  db: D1Database,
  value: unknown,
  nowMs = Date.now(),
  createId: () => string = () => crypto.randomUUID(),
) {
  const input = parseDiscordApprovalTestInput(value);
  const approvalId = `discord-test-${createId()}`;
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + TEST_APPROVAL_TTL_MS).toISOString();
  await db
    .prepare(
      `INSERT OR IGNORE INTO discord_approval_tests (
         approval_id, request_key, candidate_id, forecast_id, payload_hash,
         pull_request_number, pull_request_url, head_sha, state, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .bind(
      approvalId,
      input.requestKey,
      input.candidateId,
      input.forecastId,
      input.payloadHash,
      input.pullRequestNumber,
      input.pullRequestUrl,
      input.headSha,
      createdAt,
      expiresAt,
    )
    .run();
  const stored = await readApprovalByRequestKey(db, input.requestKey);
  if (!stored) throw new Error("discord_test_approval_not_created");
  if (!sameApprovalInput(stored, input)) throw new Error("discord_test_request_key_conflict");
  return publicApproval(stored);
}

export async function handleDiscordInteraction(
  request: Request,
  env: CollectorEnv,
  nowMs = Date.now(),
) {
  if (env.ENVIRONMENT === "production" || env.DISCORD_APPROVAL_MODE !== "test") {
    return new Response("Not found", { status: 404 });
  }
  const configuration = readDiscordConfiguration(env);
  if (!configuration) return new Response("Service unavailable", { status: 503 });

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > DISCORD_INTERACTION_MAX_BYTES) {
    return new Response("Payload too large", { status: 413 });
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > DISCORD_INTERACTION_MAX_BYTES) {
    return new Response("Payload too large", { status: 413 });
  }
  if (!(await verifyDiscordSignature(request.headers, body, configuration.publicKey, nowMs))) {
    return new Response("Invalid request signature", { status: 401 });
  }

  let interaction: DiscordInteraction;
  try {
    interaction = JSON.parse(body) as DiscordInteraction;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (interaction.application_id !== configuration.applicationId) {
    return new Response("Invalid application", { status: 401 });
  }
  if (interaction.type === 1) return interactionJson({ type: 1 });
  if (interaction.type !== 3 || interaction.data?.component_type !== 2) {
    return ephemeral("지원하지 않는 Discord interaction입니다.");
  }
  if (
    interaction.guild_id !== configuration.guildId ||
    interaction.channel_id !== configuration.channelId
  ) {
    return ephemeral("허용된 Discord 채널에서만 테스트 승인할 수 있습니다.");
  }
  const userId = interaction.member?.user?.id ?? interaction.user?.id;
  if (userId !== configuration.approverUserId) {
    return ephemeral("이 테스트 승인을 수행할 권한이 없습니다.");
  }
  const interactionId = stringMatching(interaction.id, /^\d{1,24}$/);
  const customId = stringMatching(
    interaction.data?.custom_id,
    /^forecast_test_approve:discord-test-[0-9a-f-]{36}$/,
  );
  if (!interactionId || !customId) return ephemeral("유효하지 않은 테스트 승인 버튼입니다.");
  const approvalId = customId.slice(CUSTOM_ID_PREFIX.length);
  const result = await approveDiscordTest(
    env.FORECAST_DB,
    approvalId,
    interactionId,
    configuration.approverUserId,
    nowMs,
  );
  if (result.outcome === "approved") return approvedMessage(result.approval, customId);
  if (result.outcome === "already_approved") {
    return ephemeral("이 Discord 테스트 승인은 이미 기록됐습니다.");
  }
  if (result.outcome === "expired") return ephemeral("테스트 승인 버튼이 만료됐습니다.");
  return ephemeral("테스트 승인 대상을 찾을 수 없습니다.");
}

async function verifyDiscordSignature(
  headers: Headers,
  body: string,
  publicKeyHex: string,
  nowMs = Date.now(),
) {
  const signatureHex = headers.get("x-signature-ed25519") ?? "";
  const timestamp = headers.get("x-signature-timestamp") ?? "";
  if (!/^[0-9a-f]{128}$/i.test(signatureHex) || !/^\d{10}$/.test(timestamp)) return false;
  if (!/^[0-9a-f]{64}$/i.test(publicKeyHex)) return false;
  const signedAt = Number(timestamp) * 1000;
  if (
    !Number.isFinite(signedAt) ||
    signedAt > nowMs + 60_000 ||
    nowMs - signedAt > DISCORD_SIGNATURE_MAX_AGE_MS
  ) {
    return false;
  }
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexBytes(publicKeyHex),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      hexBytes(signatureHex),
      new TextEncoder().encode(`${timestamp}${body}`),
    );
  } catch {
    return false;
  }
}

function parseDiscordApprovalTestInput(value: unknown): DiscordApprovalTestInput {
  if (!isRecord(value)) throw new Error("invalid_discord_test_approval");
  const input = {
    requestKey: stringMatching(value["requestKey"], /^[0-9a-f]{64}$/),
    candidateId: stringMatching(value["candidateId"], /^forecast-[a-z0-9-]{1,80}$/),
    forecastId: stringMatching(value["forecastId"], /^supply-[a-z0-9-]{1,80}$/),
    payloadHash: stringMatching(value["payloadHash"], /^[0-9a-f]{64}$/),
    pullRequestNumber:
      Number.isInteger(value["pullRequestNumber"]) && Number(value["pullRequestNumber"]) > 0
        ? Number(value["pullRequestNumber"])
        : null,
    pullRequestUrl: stringMatching(value["pullRequestUrl"], /^https:\/\/github\.com\//),
    headSha: stringMatching(value["headSha"], /^[0-9a-f]{40}$/),
  };
  if (Object.values(input).some((entry) => entry === null)) {
    throw new Error("invalid_discord_test_approval");
  }
  const pullRequestUrl = new URL(input.pullRequestUrl as string);
  const expectedPath = `${REPOSITORY_PATH}/pull/${input.pullRequestNumber}`;
  if (
    pullRequestUrl.protocol !== "https:" ||
    pullRequestUrl.hostname !== "github.com" ||
    pullRequestUrl.pathname !== expectedPath ||
    pullRequestUrl.search !== "" ||
    pullRequestUrl.hash !== ""
  ) {
    throw new Error("invalid_discord_test_pull_request_url");
  }
  return input as DiscordApprovalTestInput;
}

async function approveDiscordTest(
  db: D1Database,
  approvalId: string,
  interactionId: string,
  approverUserId: string,
  nowMs: number,
) {
  const now = new Date(nowMs).toISOString();
  const before = await readApprovalById(db, approvalId);
  if (!before) return { outcome: "missing" as const };
  if (before.state === "test_approved") {
    return { outcome: "already_approved" as const, approval: publicApproval(before) };
  }
  if (Date.parse(before.expires_at) <= nowMs) {
    await db
      .prepare(
        "UPDATE discord_approval_tests SET state = 'expired' WHERE approval_id = ? AND state = 'pending'",
      )
      .bind(approvalId)
      .run();
    return { outcome: "expired" as const };
  }
  const update = await db
    .prepare(
      `UPDATE discord_approval_tests
       SET state = 'test_approved', approved_at = ?, approver_user_id = ?, interaction_id = ?
       WHERE approval_id = ? AND state = 'pending' AND expires_at > ?`,
    )
    .bind(now, approverUserId, interactionId, approvalId, now)
    .run();
  if (Number(update.meta.changes ?? 0) !== 1) {
    const after = await readApprovalById(db, approvalId);
    return after?.state === "test_approved"
      ? { outcome: "already_approved" as const, approval: publicApproval(after) }
      : { outcome: "missing" as const };
  }
  const approved = await readApprovalById(db, approvalId);
  if (!approved) throw new Error("discord_test_approval_missing_after_update");
  return { outcome: "approved" as const, approval: publicApproval(approved) };
}

async function readApprovalByRequestKey(db: D1Database, requestKey: string) {
  return db
    .prepare("SELECT * FROM discord_approval_tests WHERE request_key = ?")
    .bind(requestKey)
    .first<DiscordApprovalTestRow>();
}

async function readApprovalById(db: D1Database, approvalId: string) {
  return db
    .prepare("SELECT * FROM discord_approval_tests WHERE approval_id = ?")
    .bind(approvalId)
    .first<DiscordApprovalTestRow>();
}

function publicApproval(row: DiscordApprovalTestRow) {
  return {
    approvalId: row.approval_id,
    customId: `${CUSTOM_ID_PREFIX}${row.approval_id}`,
    candidateId: row.candidate_id,
    forecastId: row.forecast_id,
    payloadHash: row.payload_hash,
    pullRequestNumber: row.pull_request_number,
    pullRequestUrl: row.pull_request_url,
    headSha: row.head_sha,
    state: row.state,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    approvedAt: row.approved_at,
  };
}

function sameApprovalInput(row: DiscordApprovalTestRow, input: DiscordApprovalTestInput) {
  return (
    row.candidate_id === input.candidateId &&
    row.forecast_id === input.forecastId &&
    row.payload_hash === input.payloadHash &&
    row.pull_request_number === input.pullRequestNumber &&
    row.pull_request_url === input.pullRequestUrl &&
    row.head_sha === input.headSha
  );
}

function readDiscordConfiguration(env: CollectorEnv) {
  const publicKey = stringMatching(env.DISCORD_PUBLIC_KEY, /^[0-9a-f]{64}$/i);
  const applicationId = stringMatching(env.DISCORD_APPLICATION_ID, /^\d{1,24}$/);
  const approverUserId = stringMatching(env.DISCORD_APPROVER_USER_ID, /^\d{1,24}$/);
  const guildId = stringMatching(env.DISCORD_GUILD_ID, /^\d{1,24}$/);
  const channelId = stringMatching(env.DISCORD_CHANNEL_ID, /^\d{1,24}$/);
  return publicKey && applicationId && approverUserId && guildId && channelId
    ? { publicKey, applicationId, approverUserId, guildId, channelId }
    : null;
}

function approvedMessage(approval: ReturnType<typeof publicApproval>, customId: string) {
  return interactionJson({
    type: 7,
    data: {
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 3,
              label: "확인 완료 (테스트)",
              custom_id: customId,
              disabled: true,
            },
            {
              type: 2,
              style: 5,
              label: "GitHub PR 열기",
              url: approval.pullRequestUrl,
            },
          ],
        },
      ],
    },
  });
}

function ephemeral(content: string) {
  return interactionJson({
    type: 4,
    data: { content, flags: 64, allowed_mentions: { parse: [] } },
  });
}

function interactionJson(value: unknown) {
  return Response.json(value, {
    headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
  });
}

function hexBytes(value: string) {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function stringMatching(value: unknown, pattern: RegExp) {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
