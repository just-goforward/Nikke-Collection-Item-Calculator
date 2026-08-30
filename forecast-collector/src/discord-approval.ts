import type { CollectorEnv } from "./types";

const DISCORD_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;
const DISCORD_INTERACTION_MAX_BYTES = 64 * 1024;
const TEST_APPROVAL_TTL_MS = 30 * 60 * 1000;
const STAGING_ADOPTION_TTL_MS = 24 * 60 * 60 * 1000;
const CUSTOM_ID_PREFIX = "forecast_test_approve:";
const STAGING_CUSTOM_ID_PREFIX = "forecast_staging_approve:";
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

export type DiscordStagingAdoptionInput = {
  requestKey: string;
  forecastId: string;
  payloadHash: string;
  sourcePullRequestNumber: number;
  sourcePullRequestUrl: string;
  sourceHeadSha: string;
  registrySha: string;
  researchRunId: number;
  researchRunUrl: string;
  researchArtifactName: string;
  researchArtifactDigest: string;
};

type DiscordStagingAdoptionRow = {
  approval_id: string;
  request_key: string;
  forecast_id: string;
  payload_hash: string;
  source_pull_request_number: number;
  source_pull_request_url: string;
  source_head_sha: string;
  registry_sha: string;
  research_run_id: number;
  research_run_url: string;
  research_artifact_name: string;
  research_artifact_digest: string;
  state: "pending" | "approved" | "adoption_pr_created" | "expired";
  created_at: string;
  expires_at: string;
  approved_at: string | null;
  approver_user_id: string | null;
  interaction_id: string | null;
  adoption_pull_request_number: number | null;
  adoption_pull_request_url: string | null;
  staging_url: string | null;
  processed_at: string | null;
  discord_channel_id: string | null;
  discord_message_id: string | null;
};

type DiscordInteraction = {
  id?: unknown;
  application_id?: unknown;
  token?: unknown;
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

export async function createDiscordStagingAdoption(
  db: D1Database,
  value: unknown,
  nowMs = Date.now(),
  createId: () => string = () => crypto.randomUUID(),
) {
  const input = parseDiscordStagingAdoptionInput(value);
  const existing = await readActiveStagingAdoptionByIdentity(db, input);
  if (existing) {
    return publicStagingAdoption(existing);
  }
  const approvalId = `discord-staging-${createId()}`;
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + STAGING_ADOPTION_TTL_MS).toISOString();
  await db
    .prepare(
      `INSERT OR IGNORE INTO discord_staging_adoptions (
         approval_id, request_key, forecast_id, payload_hash,
         source_pull_request_number, source_pull_request_url, source_head_sha,
         registry_sha, research_run_id, research_run_url,
         research_artifact_name, research_artifact_digest,
         state, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .bind(
      approvalId,
      input.requestKey,
      input.forecastId,
      input.payloadHash,
      input.sourcePullRequestNumber,
      input.sourcePullRequestUrl,
      input.sourceHeadSha,
      input.registrySha,
      input.researchRunId,
      input.researchRunUrl,
      input.researchArtifactName,
      input.researchArtifactDigest,
      createdAt,
      expiresAt,
    )
    .run();
  const stored = await readStagingAdoptionByRequestKey(db, input.requestKey);
  if (!stored) throw new Error("discord_staging_adoption_not_created");
  if (!sameStagingAdoptionInput(stored, input)) {
    throw new Error("discord_staging_request_key_conflict");
  }
  return publicStagingAdoption(stored);
}

export async function listApprovedDiscordStagingAdoptions(db: D1Database, limit: number) {
  const safeLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 20) : 5;
  const rows = await db
    .prepare(
      `SELECT current.* FROM discord_staging_adoptions AS current
       WHERE current.state = 'approved' AND current.expires_at > ?
         AND current.approval_id = (
           SELECT duplicate.approval_id
           FROM discord_staging_adoptions AS duplicate
           WHERE duplicate.forecast_id = current.forecast_id
             AND duplicate.source_pull_request_number = current.source_pull_request_number
             AND duplicate.source_head_sha = current.source_head_sha
             AND duplicate.research_run_id = current.research_run_id
             AND duplicate.research_artifact_name = current.research_artifact_name
             AND duplicate.research_artifact_digest = current.research_artifact_digest
             AND duplicate.state = 'approved' AND duplicate.expires_at > ?
           ORDER BY duplicate.approved_at ASC, duplicate.created_at ASC
           LIMIT 1
         )
         AND NOT EXISTS (
           SELECT 1 FROM discord_staging_adoptions AS completed
           WHERE completed.forecast_id = current.forecast_id
             AND completed.source_pull_request_number = current.source_pull_request_number
             AND completed.source_head_sha = current.source_head_sha
             AND completed.research_run_id = current.research_run_id
             AND completed.research_artifact_name = current.research_artifact_name
             AND completed.research_artifact_digest = current.research_artifact_digest
             AND completed.state = 'adoption_pr_created'
         )
       ORDER BY current.approved_at ASC LIMIT ?`,
    )
    .bind(new Date().toISOString(), new Date().toISOString(), safeLimit)
    .all<DiscordStagingAdoptionRow>();
  return rows.results.map(publicStagingAdoption);
}

export async function recordDiscordStagingAdoptionMessage(
  db: D1Database,
  approvalId: string,
  value: unknown,
) {
  const input = parseStagingAdoptionMessage(value);
  const before = await readStagingAdoptionById(db, approvalId);
  if (!before) return null;
  if (before.discord_channel_id || before.discord_message_id) {
    if (
      before.discord_channel_id !== input.discordChannelId ||
      before.discord_message_id !== input.discordMessageId
    ) {
      throw new Error("discord_staging_message_conflict");
    }
    return publicStagingAdoption(before);
  }
  if (before.state !== "pending") throw new Error("discord_staging_message_not_pending");
  const update = await db
    .prepare(
      `UPDATE discord_staging_adoptions
       SET discord_channel_id = ?, discord_message_id = ?
       WHERE approval_id = ? AND state = 'pending'
         AND discord_channel_id IS NULL AND discord_message_id IS NULL`,
    )
    .bind(input.discordChannelId, input.discordMessageId, approvalId)
    .run();
  if (Number(update.meta.changes ?? 0) !== 1) {
    throw new Error("discord_staging_message_race");
  }
  const stored = await readStagingAdoptionById(db, approvalId);
  if (!stored) throw new Error("discord_staging_message_missing_after_update");
  return publicStagingAdoption(stored);
}

export async function markDiscordStagingAdoptionProcessed(
  db: D1Database,
  approvalId: string,
  value: unknown,
  nowMs = Date.now(),
) {
  const input = parseStagingAdoptionResult(value);
  const before = await readStagingAdoptionById(db, approvalId);
  if (!before) return null;
  if (before.state === "adoption_pr_created") {
    if (!sameStagingAdoptionResult(before, input)) {
      throw new Error("discord_staging_result_conflict");
    }
    return publicStagingAdoption(before);
  }
  if (before.state !== "approved") throw new Error("discord_staging_not_approved");
  const processedAt = new Date(nowMs).toISOString();
  const update = await db
    .prepare(
      `UPDATE discord_staging_adoptions
       SET state = 'adoption_pr_created', adoption_pull_request_number = ?,
           adoption_pull_request_url = ?, staging_url = ?, processed_at = ?
       WHERE approval_id = ? AND state = 'approved'`,
    )
    .bind(
      input.adoptionPullRequestNumber,
      input.adoptionPullRequestUrl,
      input.stagingUrl,
      processedAt,
      approvalId,
    )
    .run();
  if (Number(update.meta.changes ?? 0) !== 1) {
    throw new Error("discord_staging_process_race");
  }
  const stored = await readStagingAdoptionById(db, approvalId);
  if (!stored) throw new Error("discord_staging_result_missing");
  return publicStagingAdoption(stored);
}

export async function handleDiscordInteraction(
  request: Request,
  env: CollectorEnv,
  _context: ExecutionContext,
  nowMs = Date.now(),
) {
  if (
    env.ENVIRONMENT === "production" ||
    (env.DISCORD_APPROVAL_MODE !== "test" && env.DISCORD_APPROVAL_MODE !== "staging_adoption")
  ) {
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
    return ephemeral("허용된 Discord 채널에서만 승인할 수 있습니다.");
  }
  const userId = interaction.member?.user?.id ?? interaction.user?.id;
  if (userId !== configuration.approverUserId) {
    return ephemeral("이 승인을 수행할 권한이 없습니다.");
  }
  const interactionId = stringMatching(interaction.id, /^\d{1,24}$/);
  const customId = stringMatching(interaction.data?.custom_id, /^[a-z_:-]{1,64}[0-9a-f-]{36}$/);
  const interactionToken = boundedString(interaction.token, 512);
  if (!interactionId || !customId || !interactionToken) {
    return ephemeral("유효하지 않은 승인 버튼입니다.");
  }
  if (customId.startsWith(STAGING_CUSTOM_ID_PREFIX)) {
    if (env.DISCORD_APPROVAL_MODE !== "staging_adoption") {
      return ephemeral("현재 staging 승인 기능은 비활성 상태입니다.");
    }
    console.log(
      JSON.stringify({
        event: "discord_interaction_acknowledged",
        interactionId,
        approvalMode: "staging_adoption",
      }),
    );
    return completeDiscordStagingAdoption(
      env.FORECAST_DB,
      customId.slice(STAGING_CUSTOM_ID_PREFIX.length),
      customId,
      interactionId,
      configuration,
      nowMs,
    );
  }
  if (
    !customId.startsWith(CUSTOM_ID_PREFIX) ||
    (env.DISCORD_APPROVAL_MODE !== "test" && env.DISCORD_APPROVAL_MODE !== "staging_adoption")
  ) {
    return ephemeral("현재 테스트 승인 기능은 비활성 상태입니다.");
  }
  return completeDiscordTestApproval(
    env.FORECAST_DB,
    customId.slice(CUSTOM_ID_PREFIX.length),
    customId,
    interactionId,
    configuration,
    nowMs,
  );
}

async function completeDiscordStagingAdoption(
  db: D1Database,
  approvalId: string,
  customId: string,
  interactionId: string,
  configuration: NonNullable<ReturnType<typeof readDiscordConfiguration>>,
  nowMs: number,
) {
  try {
    const result = await approveDiscordStagingAdoption(
      db,
      approvalId,
      interactionId,
      configuration.approverUserId,
      nowMs,
    );
    const data =
      result.outcome === "approved" || result.outcome === "already_approved"
        ? stagingApprovedData(result.approval, customId)
        : unavailableApprovalData(
            result.outcome === "expired"
              ? "staging 승인 버튼이 만료되었습니다. 새 승인 카드를 요청하십시오."
              : "staging 승인 대상을 확인할 수 없습니다. 새 승인 카드를 요청하십시오.",
          );
    console.log(
      JSON.stringify({
        event: "discord_staging_approval_completed",
        approvalId,
        outcome: result.outcome,
      }),
    );
    return updateMessage(data);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "discord_staging_approval_failed",
        approvalId,
        message: error instanceof Error ? error.message : "unknown_error",
      }),
    );
    return updateMessage(approvalFailureData());
  }
}

async function completeDiscordTestApproval(
  db: D1Database,
  approvalId: string,
  customId: string,
  interactionId: string,
  configuration: NonNullable<ReturnType<typeof readDiscordConfiguration>>,
  nowMs: number,
) {
  try {
    const result = await approveDiscordTest(
      db,
      approvalId,
      interactionId,
      configuration.approverUserId,
      nowMs,
    );
    const data =
      result.outcome === "approved" || result.outcome === "already_approved"
        ? approvedData(result.approval, customId)
        : unavailableApprovalData(
            result.outcome === "expired"
              ? "테스트 승인 버튼이 만료되었습니다."
              : "테스트 승인 대상을 찾을 수 없습니다.",
          );
    console.log(
      JSON.stringify({
        event: "discord_test_approval_completed",
        approvalId,
        outcome: result.outcome,
      }),
    );
    return updateMessage(data);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "discord_test_approval_failed",
        approvalId,
        message: error instanceof Error ? error.message : "unknown_error",
      }),
    );
    return updateMessage(approvalFailureData());
  }
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

function parseDiscordStagingAdoptionInput(value: unknown): DiscordStagingAdoptionInput {
  if (!isRecord(value)) throw new Error("invalid_discord_staging_adoption");
  const input = {
    requestKey: stringMatching(value["requestKey"], /^[0-9a-f]{64}$/),
    forecastId: stringMatching(value["forecastId"], /^supply-\d{4}-\d{2}-\d{2}-v\d+$/),
    payloadHash: stringMatching(value["payloadHash"], /^[0-9a-f]{64}$/),
    sourcePullRequestNumber: positiveInteger(value["sourcePullRequestNumber"]),
    sourcePullRequestUrl: stringMatching(value["sourcePullRequestUrl"], /^https:\/\/github\.com\//),
    sourceHeadSha: stringMatching(value["sourceHeadSha"], /^[0-9a-f]{40}$/),
    registrySha: stringMatching(value["registrySha"], /^[0-9a-f]{40}$/),
    researchRunId: positiveInteger(value["researchRunId"]),
    researchRunUrl: stringMatching(value["researchRunUrl"], /^https:\/\/github\.com\//),
    researchArtifactName: stringMatching(
      value["researchArtifactName"],
      /^dynamic-hp-exact-gate-summary-[1-9][0-9]*$/,
    ),
    researchArtifactDigest: stringMatching(value["researchArtifactDigest"], /^[0-9a-f]{64}$/),
  };
  if (Object.values(input).some((entry) => entry === null)) {
    throw new Error("invalid_discord_staging_adoption");
  }
  assertRepositoryUrl(
    input.sourcePullRequestUrl as string,
    `/pull/${input.sourcePullRequestNumber}`,
    "invalid_discord_staging_source_pr_url",
  );
  assertRepositoryUrl(
    input.researchRunUrl as string,
    `/actions/runs/${input.researchRunId}`,
    "invalid_discord_staging_research_url",
  );
  return input as DiscordStagingAdoptionInput;
}

function parseStagingAdoptionResult(value: unknown) {
  if (!isRecord(value)) throw new Error("invalid_discord_staging_result");
  const result = {
    adoptionPullRequestNumber: positiveInteger(value["adoptionPullRequestNumber"]),
    adoptionPullRequestUrl: stringMatching(
      value["adoptionPullRequestUrl"],
      /^https:\/\/github\.com\//,
    ),
    stagingUrl: stringMatching(
      value["stagingUrl"],
      /^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\/?$/,
    ),
  };
  if (Object.values(result).some((entry) => entry === null)) {
    throw new Error("invalid_discord_staging_result");
  }
  assertRepositoryUrl(
    result.adoptionPullRequestUrl as string,
    `/pull/${result.adoptionPullRequestNumber}`,
    "invalid_discord_staging_adoption_pr_url",
  );
  return result as {
    adoptionPullRequestNumber: number;
    adoptionPullRequestUrl: string;
    stagingUrl: string;
  };
}

function parseStagingAdoptionMessage(value: unknown) {
  if (!isRecord(value)) throw new Error("invalid_discord_staging_message");
  const input = {
    discordChannelId: stringMatching(value["discordChannelId"], /^\d{1,24}$/),
    discordMessageId: stringMatching(value["discordMessageId"], /^\d{1,24}$/),
  };
  if (Object.values(input).some((entry) => entry === null)) {
    throw new Error("invalid_discord_staging_message");
  }
  return input as { discordChannelId: string; discordMessageId: string };
}

function assertRepositoryUrl(value: string, suffix: string, error: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.pathname !== `${REPOSITORY_PATH}${suffix}` ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(error);
  }
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

async function approveDiscordStagingAdoption(
  db: D1Database,
  approvalId: string,
  interactionId: string,
  approverUserId: string,
  nowMs: number,
) {
  const now = new Date(nowMs).toISOString();
  const before = await readStagingAdoptionById(db, approvalId);
  if (!before) return { outcome: "missing" as const };
  if (before.state === "approved" || before.state === "adoption_pr_created") {
    return { outcome: "already_approved" as const, approval: publicStagingAdoption(before) };
  }
  if (Date.parse(before.expires_at) <= nowMs) {
    await db
      .prepare(
        "UPDATE discord_staging_adoptions SET state = 'expired' WHERE approval_id = ? AND state = 'pending'",
      )
      .bind(approvalId)
      .run();
    return { outcome: "expired" as const };
  }
  const update = await db
    .prepare(
      `UPDATE discord_staging_adoptions
       SET state = 'approved', approved_at = ?, approver_user_id = ?, interaction_id = ?
       WHERE approval_id = ? AND state = 'pending' AND expires_at > ?`,
    )
    .bind(now, approverUserId, interactionId, approvalId, now)
    .run();
  if (Number(update.meta.changes ?? 0) !== 1) {
    const after = await readStagingAdoptionById(db, approvalId);
    return after?.state === "approved" || after?.state === "adoption_pr_created"
      ? { outcome: "already_approved" as const, approval: publicStagingAdoption(after) }
      : { outcome: "missing" as const };
  }
  const approved = await readStagingAdoptionById(db, approvalId);
  if (!approved) throw new Error("discord_staging_approval_missing_after_update");
  return { outcome: "approved" as const, approval: publicStagingAdoption(approved) };
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

async function readStagingAdoptionByRequestKey(db: D1Database, requestKey: string) {
  return db
    .prepare("SELECT * FROM discord_staging_adoptions WHERE request_key = ?")
    .bind(requestKey)
    .first<DiscordStagingAdoptionRow>();
}

async function readActiveStagingAdoptionByIdentity(
  db: D1Database,
  input: DiscordStagingAdoptionInput,
) {
  return db
    .prepare(
      `SELECT * FROM discord_staging_adoptions
       WHERE forecast_id = ?
         AND source_pull_request_number = ?
         AND source_head_sha = ?
         AND research_run_id = ?
         AND research_artifact_name = ?
         AND research_artifact_digest = ?
         AND state IN ('pending', 'approved', 'adoption_pr_created')
       ORDER BY CASE state
         WHEN 'adoption_pr_created' THEN 0
         WHEN 'approved' THEN 1
         ELSE 2
       END, created_at DESC
       LIMIT 1`,
    )
    .bind(
      input.forecastId,
      input.sourcePullRequestNumber,
      input.sourceHeadSha,
      input.researchRunId,
      input.researchArtifactName,
      input.researchArtifactDigest,
    )
    .first<DiscordStagingAdoptionRow>();
}

async function readStagingAdoptionById(db: D1Database, approvalId: string) {
  return db
    .prepare("SELECT * FROM discord_staging_adoptions WHERE approval_id = ?")
    .bind(approvalId)
    .first<DiscordStagingAdoptionRow>();
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

function publicStagingAdoption(row: DiscordStagingAdoptionRow) {
  return {
    approvalId: row.approval_id,
    customId: `${STAGING_CUSTOM_ID_PREFIX}${row.approval_id}`,
    forecastId: row.forecast_id,
    payloadHash: row.payload_hash,
    sourcePullRequestNumber: row.source_pull_request_number,
    sourcePullRequestUrl: row.source_pull_request_url,
    sourceHeadSha: row.source_head_sha,
    registrySha: row.registry_sha,
    researchRunId: row.research_run_id,
    researchRunUrl: row.research_run_url,
    researchArtifactName: row.research_artifact_name,
    researchArtifactDigest: row.research_artifact_digest,
    state: row.state,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    approvedAt: row.approved_at,
    adoptionPullRequestNumber: row.adoption_pull_request_number,
    adoptionPullRequestUrl: row.adoption_pull_request_url,
    stagingUrl: row.staging_url,
    processedAt: row.processed_at,
    discordChannelId: row.discord_channel_id,
    discordMessageId: row.discord_message_id,
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

function sameStagingAdoptionInput(
  row: DiscordStagingAdoptionRow,
  input: DiscordStagingAdoptionInput,
) {
  return (
    row.forecast_id === input.forecastId &&
    row.payload_hash === input.payloadHash &&
    row.source_pull_request_number === input.sourcePullRequestNumber &&
    row.source_pull_request_url === input.sourcePullRequestUrl &&
    row.source_head_sha === input.sourceHeadSha &&
    row.registry_sha === input.registrySha &&
    row.research_run_id === input.researchRunId &&
    row.research_run_url === input.researchRunUrl &&
    row.research_artifact_name === input.researchArtifactName &&
    row.research_artifact_digest === input.researchArtifactDigest
  );
}

function sameStagingAdoptionResult(
  row: DiscordStagingAdoptionRow,
  input: ReturnType<typeof parseStagingAdoptionResult>,
) {
  return (
    row.adoption_pull_request_number === input.adoptionPullRequestNumber &&
    row.adoption_pull_request_url === input.adoptionPullRequestUrl &&
    row.staging_url === input.stagingUrl
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

function approvedData(approval: ReturnType<typeof publicApproval>, customId: string) {
  return {
    content:
      `Forecast \`${approval.forecastId}\`의 Discord 승인 응답 테스트가 완료되었습니다.\n` +
      "D1에는 `test_approved`만 기록되었으며 staging·production Forecast와 GitHub PR은 변경되지 않았습니다.",
    allowed_mentions: { parse: [] },
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 3,
            label: "테스트 승인 완료",
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
  };
}

function stagingApprovedData(approval: ReturnType<typeof publicStagingAdoption>, customId: string) {
  return {
    content:
      `Forecast \`${approval.forecastId}\`의 staging 적용 승인이 기록되었습니다.\n` +
      "GitHub Actions가 adoption PR 생성과 staging 배포를 진행합니다. production 환경은 변경되지 않습니다.",
    allowed_mentions: { parse: [] },
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 3,
            label: "staging 적용 승인 완료",
            custom_id: customId,
            disabled: true,
          },
          {
            type: 2,
            style: 5,
            label: "H/p 인증 결과 열기",
            url: approval.researchRunUrl,
          },
        ],
      },
    ],
  };
}

function unavailableApprovalData(content: string) {
  return {
    content,
    allowed_mentions: { parse: [] },
    components: [],
  };
}

function approvalFailureData() {
  return {
    content: "승인 기록 중 오류가 발생했습니다. 버튼을 다시 누르거나 새 승인 카드를 요청하십시오.",
    allowed_mentions: { parse: [] },
  };
}

function updateMessage(data: Record<string, unknown>) {
  return interactionJson({ type: 7, data });
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

function boundedString(value: unknown, maxLength: number) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return null;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return null;
  }
  return value;
}

function hexBytes(value: string) {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function stringMatching(value: unknown, pattern: RegExp) {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function positiveInteger(value: unknown) {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
