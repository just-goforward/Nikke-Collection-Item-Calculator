import { readBoundedText } from "./boundedHttp.ts";

export const DISCORD_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;
export const DISCORD_INTERACTION_MAX_BYTES = 64 * 1024;

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

/** Fail-closed Ed25519 verification. A malformed signature, stale timestamp, unusable
 * configured public key, or WebCrypto rejection all mean "not verified", which the caller
 * answers with 401; none of them may ever return true. An unusable *configured* public key
 * is a misconfiguration rather than an attacker-controlled input, so it is logged under a
 * fixed code while ordinary signature mismatches stay silent. */
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
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("raw", hexBytes(publicKeyHex), { name: "Ed25519" }, false, [
      "verify",
    ]);
  } catch {
    console.error(JSON.stringify({ event: "discord_public_key_unusable" }));
    return false;
  }
  try {
    // Awaited so a rejected verification (rather than a `false` result) also lands here
    // as "not verified"; both spell 401 at the caller.
    return await crypto.subtle.verify(
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
