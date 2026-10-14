/** Local tests only; the production entrypoint never imports this module. */
import { sha256 } from "./auth";

export const TEST_ORIGIN = "https://app.example";
export const TEST_CLIENT = "local-client";
export const TEST_SECRET = "local-only-test-value";
const ISSUER = "https://accounts.google.com";
const TOKEN = "https://oauth2.googleapis.com/token";
const JWKS = "https://www.googleapis.com/oauth2/v3/certs";

function base64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
function encoded(value: unknown): string {
  return base64(new TextEncoder().encode(JSON.stringify(value)));
}

interface Authorization {
  nonce: string;
  challenge: string;
  redirect: string;
  claims: Record<string, unknown>;
  missing: string[];
  badSignature: boolean;
  kid: string;
  failExchange: boolean;
}

export async function fakeIssuer() {
  const algorithm = {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  };
  const first = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  const second = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  const firstJwk = {
    ...(await crypto.subtle.exportKey("jwk", first.publicKey)),
    kid: "k1",
    alg: "RS256",
    use: "sig",
  };
  const secondJwk = {
    ...(await crypto.subtle.exportKey("jwk", second.publicKey)),
    kid: "k2",
    alg: "RS256",
    use: "sig",
  };
  let published = [firstJwk];
  let signing = first.privateKey;
  let activeKid = "k1";
  const codes = new Map<string, Authorization>();
  const exchanges: string[] = [];
  const counts = { discovery: 0, jwks: 0, token: 0 };
  let outage: "discovery" | "jwks" | "token" | null = null;
  let hang: "discovery" | null = null;
  let metadataOverride: Record<string, unknown> = {};
  let pause: { entered: () => void; wait: Promise<void> } | null = null;
  const json = (value: unknown, status = 200) => Response.json(value, { status });

  function authorize(
    authorizationUrl: string,
    options: {
      claims?: Record<string, unknown>;
      missing?: string[];
      badSignature?: boolean;
      kid?: string;
      failExchange?: boolean;
      challenge?: string;
    } = {},
  ): string {
    const url = new URL(authorizationUrl);
    const code = crypto.randomUUID();
    const redirect = url.searchParams.get("redirect_uri") ?? "";
    codes.set(code, {
      nonce: url.searchParams.get("nonce") ?? "",
      challenge: options.challenge ?? url.searchParams.get("code_challenge") ?? "",
      redirect,
      claims: options.claims ?? {},
      missing: options.missing ?? [],
      badSignature: options.badSignature ?? false,
      kid: options.kid ?? activeKid,
      failExchange: options.failExchange ?? false,
    });
    const callback = new URL(redirect);
    callback.searchParams.set("state", url.searchParams.get("state") ?? "");
    callback.searchParams.set("code", code);
    callback.searchParams.set("iss", ISSUER);
    return callback.href;
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.href === `${ISSUER}/.well-known/openid-configuration`) {
      counts.discovery++;
      if (hang === "discovery") {
        await new Promise<never>((_, reject) => {
          request.signal.addEventListener("abort", () => reject(new Error("local_timeout")), {
            once: true,
          });
        });
      }
      if (outage === "discovery") return json({}, 503);
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/o/oauth2/v2/auth`,
        token_endpoint: TOKEN,
        jwks_uri: JWKS,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
        code_challenge_methods_supported: ["S256"],
        ...metadataOverride,
      });
    }
    if (url.href === JWKS) {
      counts.jwks++;
      return outage === "jwks" ? json({}, 503) : json({ keys: published });
    }
    if (url.href !== TOKEN) throw new Error("unexpected_test_outbound");
    counts.token++;
    const parameters = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));
    const code = parameters.get("code") ?? "";
    exchanges.push(code);
    const record = codes.get(code);
    const verifier = parameters.get("code_verifier") ?? "";
    const digest = await sha256(verifier);
    const challenge = base64(
      Uint8Array.from(digest.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16)),
    );
    if (
      !record ||
      parameters.get("client_id") !== TEST_CLIENT ||
      parameters.get("client_secret") !== TEST_SECRET ||
      parameters.get("redirect_uri") !== record.redirect ||
      record.challenge !== challenge ||
      record.failExchange ||
      outage === "token"
    )
      return json({ error: "invalid_grant" }, 400);
    if (pause) {
      const gate = pause;
      pause = null;
      gate.entered();
      await gate.wait;
    }
    const time = Math.floor(Date.now() / 1_000);
    const claims: Record<string, unknown> = {
      iss: ISSUER,
      sub: "alice",
      aud: TEST_CLIENT,
      nonce: record.nonce,
      iat: time,
      exp: time + 300,
      ...record.claims,
    };
    for (const name of record.missing) delete claims[name];
    const unsigned = `${encoded({ alg: "RS256", kid: record.kid })}.${encoded(claims)}`;
    const signature = await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      record.badSignature ? second.privateKey : signing,
      new TextEncoder().encode(unsigned),
    );
    return json({
      access_token: "ACCESS_TOKEN_CANARY",
      refresh_token: "REFRESH_TOKEN_CANARY",
      token_type: "Bearer",
      expires_in: 300,
      id_token: `${unsigned}.${base64(new Uint8Array(signature))}`,
    });
  };

  return {
    authorize,
    fetch: fetchImpl,
    exchanges,
    counts,
    outage(value: typeof outage) {
      outage = value;
    },
    hang(value: typeof hang) {
      hang = value;
    },
    metadata(value: Record<string, unknown>) {
      metadataOverride = value;
    },
    rotate() {
      signing = second.privateKey;
      activeKid = "k2";
      published = [secondJwk];
    },
    pauseNextExchange() {
      let release = () => {};
      let entered = () => {};
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      pause = { entered, wait };
      return { entered: enteredPromise, release };
    },
  };
}
