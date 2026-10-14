import * as oidc from "openid-client";
import type { GoogleIdentity, PendingFlow } from "./auth";
import { HttpError } from "./http";
import type { PersonalEnv } from "./types";

const GOOGLE_ISSUER = "https://accounts.google.com";
const JWT_CLOCK_TOLERANCE_SECONDS = 30;
const OUTBOUND_TIMEOUT_SECONDS = 5;
const DISCOVERY = `${GOOGLE_ISSUER}/.well-known/openid-configuration`;
const TOKEN = "https://oauth2.googleapis.com/token";
const JWKS = "https://www.googleapis.com/oauth2/v3/certs";
const AUTHORIZATION = `${GOOGLE_ISSUER}/o/oauth2/v2/auth`;

export function settings(env: PersonalEnv) {
  if (!env.SITE_ORIGIN || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error("service_not_configured");
  }
  const origin = new URL(env.SITE_ORIGIN);
  if (origin.protocol !== "https:" || origin.origin !== env.SITE_ORIGIN) {
    throw new Error("service_not_configured");
  }
  return {
    origin: origin.origin,
    clientId: env.GOOGLE_CLIENT_ID,
    secret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: `${origin.origin}/auth/callback/google`,
  };
}

/** Factory lifetime = isolate. Tests inject outbound HTTP, never a different issuer. */
export function googleProvider(fetchImpl: typeof fetch = fetch) {
  let cached: { clientId: string; secret: string; promise: Promise<oidc.Configuration> } | null =
    null;
  const getFlights = new Map<string, Promise<Response>>();
  const outbound: oidc.CustomFetch = async (url, options) => {
    if (![DISCOVERY, TOKEN, JWKS].includes(url)) throw new Error("outbound_not_allowed");
    const perform = async () => {
      const result = await fetchImpl(url, {
        method: options.method,
        headers: options.headers,
        body:
          options.body instanceof Uint8Array
            ? new Uint8Array(options.body).buffer
            : (options.body ?? null),
        redirect: "manual",
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(OUTBOUND_TIMEOUT_SECONDS * 1_000)])
          : AbortSignal.timeout(OUTBOUND_TIMEOUT_SECONDS * 1_000),
      });
      // workerd has no redirect:"error"; reject manual redirects before the library can use them.
      if (result.status >= 300 && result.status < 400)
        throw new Error("outbound_redirect_rejected");
      return result;
    };
    if (url === TOKEN) return perform();
    let flight = getFlights.get(url);
    if (!flight) {
      flight = perform();
      getFlights.set(url, flight);
    }
    try {
      return (await flight).clone();
    } finally {
      // Retain a resolved JWKS flight until validation populates the library cache.
      if (url !== JWKS && getFlights.get(url) === flight) getFlights.delete(url);
    }
  };

  async function configuration(env: PersonalEnv): Promise<oidc.Configuration> {
    const { clientId, secret } = settings(env);
    if (cached?.clientId === clientId && cached.secret === secret) return cached.promise;
    const promise = oidc
      .discovery(
        new URL(GOOGLE_ISSUER),
        clientId,
        {
          client_secret: secret,
          id_token_signed_response_alg: "RS256",
          [oidc.clockTolerance]: JWT_CLOCK_TOLERANCE_SECONDS,
        },
        oidc.ClientSecretPost(secret),
        {
          [oidc.customFetch]: outbound,
          timeout: OUTBOUND_TIMEOUT_SECONDS,
          execute: [oidc.enableNonRepudiationChecks],
        },
      )
      .then((config) => {
        const metadata = config.serverMetadata();
        if (
          metadata.issuer !== GOOGLE_ISSUER ||
          metadata.authorization_endpoint !== AUTHORIZATION ||
          metadata.token_endpoint !== TOKEN ||
          metadata.jwks_uri !== JWKS
        ) {
          throw new Error("discovery_rejected");
        }
        return config;
      });
    const entry = { clientId, secret, promise };
    cached = entry;
    try {
      return await promise;
    } catch (error) {
      if (cached === entry) cached = null;
      throw error;
    }
  }

  return {
    async authorizationUrl(env: PersonalEnv, state: string, nonce: string, verifier: string) {
      return oidc.buildAuthorizationUrl(await configuration(env), {
        redirect_uri: settings(env).redirectUri,
        scope: "openid",
        state,
        nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
      });
    },
    verifier: oidc.randomPKCECodeVerifier,
    async exchange(
      env: PersonalEnv,
      url: URL,
      state: string,
      pending: PendingFlow,
    ): Promise<GoogleIdentity> {
      try {
        const tokens = await oidc.authorizationCodeGrant(await configuration(env), url, {
          expectedState: state,
          expectedNonce: pending.nonce,
          pkceCodeVerifier: pending.verifier,
          idTokenExpected: true,
        });
        const claims = tokens.claims();
        // Canonical issuer only; never rewrite a signed legacy claim.
        // oauth4webapi checks azp only with multiple audiences; enforce single aud too.
        if (
          claims?.iss !== GOOGLE_ISSUER ||
          typeof claims.sub !== "string" ||
          !claims.sub ||
          claims.sub.length > 255 ||
          (claims.azp !== undefined && claims.azp !== settings(env).clientId)
        ) {
          throw new Error("identity_rejected");
        }
        return { issuer: GOOGLE_ISSUER, sub: claims.sub };
      } catch (error) {
        // 6.8.8's canonical discovery configuration rejects a bare issuer before JWS checks.
        // Classify the known compatibility failure only; never accept or rewrite its claims.
        if (
          error instanceof oidc.ClientError &&
          error.code === "OAUTH_JWT_CLAIM_COMPARISON_FAILED" &&
          error.cause instanceof Error
        ) {
          const details = error.cause.cause as
            | {
                claim?: unknown;
                expected?: unknown;
                claims?: { iss?: unknown };
              }
            | undefined;
          if (
            details?.claim === "iss" &&
            details.expected === GOOGLE_ISSUER &&
            details.claims?.iss === "accounts.google.com"
          ) {
            throw new HttpError(401, "google_issuer_unsupported");
          }
        }
        throw error;
      } finally {
        getFlights.delete(JWKS);
      }
    },
  };
}
