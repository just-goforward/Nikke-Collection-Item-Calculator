import { readBoundedJson } from "../../shared/boundedHttp.ts";
import { errorCode } from "../../shared/errorCodes.ts";

/** Cloudflare Access application token verification (fail closed).
 * RS256 only; keys come from `<team>/cdn-cgi/access/certs`, looked up by `kid`.
 */
export type AccessConfig = { teamDomain: string; aud: string; allowed: ReadonlySet<string> };
export type AccessIdentity = { email: string };

export class AccessError extends Error {
  constructor(readonly code: "invalid_token" | "jwks_unavailable") {
    super(code);
  }
}

const TEAM_DOMAIN = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const AUD = /^[0-9a-f]{64}$/;
const EMAIL = /^[^\s@,]{1,64}@[^\s@,]{1,189}\.[^\s@,]{1,63}$/;
const KID = /^[A-Za-z0-9._-]{1,128}$/;
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const MAX_TOKEN_CHARS = 8_192;
const MAX_JWKS_BYTES = 65_536;
const MAX_KEYS = 8;
const KEY_TTL_MS = 10 * 60_000;
const MIN_REFRESH_MS = 30_000;
const FETCH_TIMEOUT_MS = 5_000;
const CLOCK_SKEW_SECONDS = 30;
const ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const MIN_RSA_MODULUS_BITS = 2_048;

/** Returns null when any value is missing, a placeholder, or malformed. */
export function accessConfig(env: {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ADMIN_ALLOWED_EMAILS?: string;
}): AccessConfig | null {
  const teamDomain = env.ACCESS_TEAM_DOMAIN ?? "";
  const aud = env.ACCESS_AUD ?? "";
  const emails = (env.ADMIN_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (!TEAM_DOMAIN.test(teamDomain) || !AUD.test(aud) || emails.length === 0) return null;
  if (!emails.every((email) => EMAIL.test(email))) return null;
  return { teamDomain, aud, allowed: new Set(emails) };
}

function decodeSegment(segment: string): Uint8Array<ArrayBuffer> {
  if (!SEGMENT.test(segment)) throw new AccessError("invalid_token");
  const base64 = segment.replaceAll("-", "+").replaceAll("_", "/");
  let binary: string;
  try {
    binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  } catch {
    throw new AccessError("invalid_token");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

type DecodedJson = { ok: true; value: Record<string, unknown> } | { ok: false };

/** Malformed base64url, invalid UTF-8, and non-object JSON are all the same expected
 * invalid-token class (an unauthenticated caller's input), so the parse outcome is a typed
 * value that the caller converts to `AccessError("invalid_token")`. */
function tryDecodeJson(segment: string): DecodedJson {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(decodeSegment(segment)),
    );
    if (value && typeof value === "object" && !Array.isArray(value))
      return { ok: true, value: value as Record<string, unknown> };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

function decodeJson(segment: string): Record<string, unknown> {
  const decoded = tryDecodeJson(segment);
  if (!decoded.ok) throw new AccessError("invalid_token");
  return decoded.value;
}

type KeySet = { domain: string; fetchedAt: number; keys: Map<string, CryptoKey> };

/** Discarding an unread JWKS error body can itself reject, but that must not replace the
 * JWKS-unavailable outcome; the discard failure is recorded and the caller keeps failing closed. */
async function discardBody(response: Response) {
  try {
    await response.body?.cancel();
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "access_jwks_body_discard_failed",
        code: errorCode(error),
      }),
    );
  }
}

/** Returns null for a JWK this verifier cannot use (unimportable or too small).
 * Such a key is intentionally not indexed, so a token naming it fails closed as an
 * unknown `kid`; if every published key is unusable the JWKS is unavailable (503). */
async function importVerificationKey(modulus: string, exponent: string): Promise<CryptoKey | null> {
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: modulus, e: exponent, alg: "RS256", ext: true },
      ALGORITHM,
      false,
      ["verify"],
    );
    return (key.algorithm as RsaHashedKeyAlgorithm).modulusLength >= MIN_RSA_MODULUS_BITS
      ? key
      : null;
  } catch {
    return null;
  }
}

/** Factory lifetime = isolate. The key cache is bounded in entries and age, and an unknown
 * `kid` triggers at most one JWKS refresh per MIN_REFRESH_MS (single flight). */
export function createAccessVerifier(
  options: { fetch?: typeof fetch; now?: () => number } = {},
): (token: string, config: AccessConfig) => Promise<AccessIdentity> {
  const now = options.now ?? Date.now;
  let cache: KeySet | null = null;
  let pending: Promise<KeySet> | null = null;

  async function download(domain: string): Promise<KeySet> {
    const fetchImpl = options.fetch ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(`${domain}/cdn-cgi/access/certs`, {
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Accept: "application/json" },
      });
    } catch {
      throw new AccessError("jwks_unavailable");
    }
    if (response.status !== 200) {
      await discardBody(response);
      throw new AccessError("jwks_unavailable");
    }
    let body: unknown;
    try {
      body = await readBoundedJson(response, MAX_JWKS_BYTES, "jwks_too_large");
    } catch {
      throw new AccessError("jwks_unavailable");
    }
    const list = (body as { keys?: unknown } | null)?.keys;
    if (!Array.isArray(list)) throw new AccessError("jwks_unavailable");
    const keys = new Map<string, CryptoKey>();
    for (const entry of list) {
      if (keys.size >= MAX_KEYS) break;
      const jwk = (entry ?? {}) as Record<string, unknown>;
      if (
        jwk["kty"] !== "RSA" ||
        typeof jwk["kid"] !== "string" ||
        !KID.test(jwk["kid"]) ||
        (jwk["alg"] !== undefined && jwk["alg"] !== "RS256") ||
        (jwk["use"] !== undefined && jwk["use"] !== "sig") ||
        typeof jwk["n"] !== "string" ||
        typeof jwk["e"] !== "string"
      )
        continue;
      const key = await importVerificationKey(jwk["n"], jwk["e"]);
      if (key) keys.set(jwk["kid"], key);
    }
    if (keys.size === 0) throw new AccessError("jwks_unavailable");
    return { domain, fetchedAt: now(), keys };
  }

  function refresh(domain: string): Promise<KeySet> {
    if (pending) return pending;
    const flight = download(domain)
      .then((set) => {
        cache = set;
        return set;
      })
      .finally(() => {
        if (pending === flight) pending = null;
      });
    pending = flight;
    return flight;
  }

  async function lookup(domain: string, kid: string): Promise<CryptoKey | null> {
    const current = cache?.domain === domain ? cache : null;
    const age = current ? now() - current.fetchedAt : Number.POSITIVE_INFINITY;
    if (current && age >= 0 && age < KEY_TTL_MS) {
      const key = current.keys.get(kid);
      if (key) return key;
      if (age < MIN_REFRESH_MS) return null;
    }
    return (await refresh(domain)).keys.get(kid) ?? null;
  }

  return async (token, config) => {
    if (token.length > MAX_TOKEN_CHARS) throw new AccessError("invalid_token");
    const parts = token.split(".");
    if (parts.length !== 3) throw new AccessError("invalid_token");
    const [encodedHeader = "", encodedPayload = "", encodedSignature = ""] = parts;
    const header = decodeJson(encodedHeader);
    // Algorithm pinned: "none", HS*, ES*, PS* and critical extensions are rejected.
    if (
      header["alg"] !== "RS256" ||
      header["crit"] !== undefined ||
      (header["typ"] !== undefined && header["typ"] !== "JWT") ||
      typeof header["kid"] !== "string" ||
      !KID.test(header["kid"])
    )
      throw new AccessError("invalid_token");
    const payload = decodeJson(encodedPayload);
    const signature = decodeSegment(encodedSignature);
    const key = await lookup(config.teamDomain, header["kid"]);
    if (!key) throw new AccessError("invalid_token");
    const valid = await crypto.subtle.verify(
      ALGORITHM,
      key,
      signature,
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    );
    if (!valid) throw new AccessError("invalid_token");
    const seconds = now() / 1000;
    const aud = payload["aud"];
    const exp = payload["exp"];
    const nbf = payload["nbf"];
    const email = payload["email"];
    if (
      payload["iss"] !== config.teamDomain ||
      !(aud === config.aud || (Array.isArray(aud) && aud.includes(config.aud))) ||
      typeof exp !== "number" ||
      !Number.isFinite(exp) ||
      exp + CLOCK_SKEW_SECONDS <= seconds ||
      (nbf !== undefined && (typeof nbf !== "number" || nbf - CLOCK_SKEW_SECONDS > seconds)) ||
      typeof email !== "string" ||
      !EMAIL.test(email)
    )
      throw new AccessError("invalid_token");
    return { email: email.toLowerCase() };
  };
}
