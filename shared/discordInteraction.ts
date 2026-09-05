import { readBoundedText } from "./boundedHttp.ts";
import { STAGING_FORECAST_REVIEW_URL } from "./runtimeEnvironment.ts";

export const DISCORD_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;
export const DISCORD_INTERACTION_MAX_BYTES = 64 * 1024;
export const CUSTOM_ID_PREFIX = "forecast_test_approve:";
export const STAGING_CUSTOM_ID_PREFIX = "forecast_staging_approve:";

export type DiscordInteraction = {
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

export type DiscordApprovalView = {
  forecastId: string;
  pullRequestUrl: string;
};

export type DiscordStagingAdoptionView = {
  forecastId: string;
  researchRunUrl: string;
};

export async function readVerifiedDiscordBody(request: Request, publicKey: string, nowMs: number) {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > DISCORD_INTERACTION_MAX_BYTES) {
    return new Response("Payload too large", { status: 413 });
  }
  let body: string;
  try {
    body = await readBoundedText(
      request,
      DISCORD_INTERACTION_MAX_BYTES,
      "discord_interaction_body_too_large",
    );
  } catch {
    return new Response("Payload too large", { status: 413 });
  }
  return (await verifyDiscordSignature(request.headers, body, publicKey, nowMs))
    ? body
    : new Response("Invalid request signature", { status: 401 });
}

export function parseDiscordInteraction(body: string, applicationId: string) {
  let interaction: DiscordInteraction;
  try {
    interaction = JSON.parse(body) as DiscordInteraction;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (interaction.application_id !== applicationId) {
    return new Response("Invalid application", { status: 401 });
  }
  if (
    interaction.type !== 1 &&
    (interaction.type !== 3 || interaction.data?.component_type !== 2)
  ) {
    return ephemeral("지원하지 않는 Discord interaction입니다.");
  }
  return interaction;
}

export function approvedData(approval: DiscordApprovalView, customId: string) {
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

export function stagingApprovedData(approval: DiscordStagingAdoptionView, customId: string) {
  return {
    content:
      `Forecast \`${approval.forecastId}\`의 staging 적용 승인이 기록되었습니다.\n` +
      "GitHub Actions가 adoption PR을 생성합니다. PR 병합과 Pages 배포 후 " +
      `${STAGING_FORECAST_REVIEW_URL}에서 검증할 수 있으며 기본 production 환경은 변경되지 않습니다.`,
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

export function unavailableApprovalData(content: string) {
  return {
    content,
    allowed_mentions: { parse: [] },
    components: [],
  };
}

export function approvalFailureData() {
  return {
    content: "승인 기록 중 오류가 발생했습니다. 버튼을 다시 누르거나 새 승인 카드를 요청하십시오.",
    allowed_mentions: { parse: [] },
  };
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
