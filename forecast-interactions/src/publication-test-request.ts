import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import type { InteractionRouterEnv } from "./types.ts";
import type { createInteractionWorker } from "./worker.ts";

/** Test-only signed request transport, retaining getters on the supplied environment. */
export async function requestPublicationInteraction(
  value: object,
  routerEnv: InteractionRouterEnv,
  discordKey: CryptoKeyPair,
  overrides: Partial<InteractionRouterEnv>,
  handler: ReturnType<typeof createInteractionWorker>,
) {
  const body = JSON.stringify(value);
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = await crypto.subtle.sign(
    "Ed25519",
    discordKey.privateKey,
    new TextEncoder().encode(timestamp + body),
  );
  const hex = Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const context = createExecutionContext();
  const response = await handler.fetch(
    new Request("https://router.test/discord/interactions", {
      method: "POST",
      body,
      headers: { "x-signature-ed25519": hex, "x-signature-timestamp": timestamp },
    }),
    Object.defineProperties(
      {},
      {
        ...Object.getOwnPropertyDescriptors(routerEnv),
        ...Object.getOwnPropertyDescriptors(overrides),
      },
    ) as InteractionRouterEnv,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}
