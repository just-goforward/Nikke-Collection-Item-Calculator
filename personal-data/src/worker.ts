import {
  consumeOAuthTransaction,
  cookie,
  cookieValue,
  FLOW_COOKIE,
  FLOW_TTL_MS,
  identityHash,
  randomToken,
  readSession,
  revokeAll,
  SESSION_COOKIE,
  SESSION_IDLE_MS,
  SESSION_MAX_MS,
  type SessionAccount,
  sha256,
  touchSession,
} from "./auth";
import { consentBody, getConsent, putConsent, queueDeletion, resumeDeletion } from "./consent";
import type { Archive, PersonalExport, SelfPercentile, StageSummary } from "./contracts";
import { googleProvider, settings } from "./google";
import {
  body,
  exactKeys,
  HttpError,
  opBody,
  requireAccountContext,
  response,
  sameOrigin,
  workspaceBody,
} from "./http";
import {
  getWorkspace,
  provisioningStatements,
  putWorkspace,
  type WorkspaceRow,
  workspaceRead,
  workspaceResult,
} from "./store";
import type { PersonalEnv } from "./types";

const routes: Record<string, readonly string[]> = {
  "/auth/login/google": ["POST"],
  "/auth/callback/google": ["GET", "POST"],
  "/auth/logout": ["POST"],
  "/v1/account": ["GET", "DELETE"],
  "/v1/workspace": ["GET", "PUT"],
  "/v1/export": ["GET"],
  "/v1/consent": ["GET", "PUT"],
  "/v1/sessions/revoke-all": ["POST"],
  "/v1/statistics": ["GET"],
  "/v1/self-percentile": ["GET"],
  // Existing site's exact allowlist; no wildcard forwarding is required.
  "/api/auth/session": ["GET", "DELETE"],
  "/api/auth/logout": ["POST"],
  "/api/personal/settings": ["GET", "PUT"],
};
const aliases: Record<string, string> = {
  "/api/auth/session": "/v1/account",
  "/api/auth/logout": "/auth/logout",
  "/api/personal/settings": "/v1/consent",
};

export function createWorker(fetchImpl: typeof fetch = fetch, now: () => number = Date.now) {
  const provider = googleProvider(fetchImpl);

  async function optionalAccount(
    request: Request,
    env: PersonalEnv,
  ): Promise<SessionAccount | null> {
    const raw = cookieValue(request, SESSION_COOKIE);
    const account = raw && (await readSession(env.PERSONAL_DB, raw, now()));
    if (!account) return null;
    const tombstone = await env.PRIVACY_CONTROL_DB.prepare(
      "SELECT 1 AS denied FROM tombstones WHERE kind = 'deletion' AND user_id = ? LIMIT 1",
    )
      .bind(account.userId)
      .first();
    if (tombstone) return null;
    return account;
  }

  async function authorize(request: Request, env: PersonalEnv): Promise<SessionAccount> {
    const account = await optionalAccount(request, env);
    if (!account) throw new HttpError(401, "unauthenticated");
    return account;
  }

  async function login(request: Request, env: PersonalEnv): Promise<Response> {
    exactKeys(await body(request), []);
    const time = now();
    const bucket = Math.floor(time / 60_000);
    const rateKey = await sha256(request.headers.get("CF-Connecting-IP") ?? "missing-ingress-ip");
    const rate = await env.PERSONAL_DB.batch([
      env.PERSONAL_DB.prepare("DELETE FROM oauth_transactions WHERE expires_at <= ?").bind(time),
      env.PERSONAL_DB.prepare(
        "DELETE FROM sessions WHERE idle_expires_at <= ? OR max_expires_at <= ?",
      ).bind(time, time),
      env.PERSONAL_DB.prepare("DELETE FROM identity_deletion_fences WHERE expires_at <= ?").bind(
        time,
      ),
      env.PERSONAL_DB.prepare("DELETE FROM login_rates WHERE bucket < ?").bind(bucket),
      ...[rateKey, "global"].map((key) =>
        env.PERSONAL_DB.prepare(
          `INSERT INTO login_rates VALUES (?, ?, 1)
         ON CONFLICT(rate_key, bucket) DO UPDATE SET hits = hits + 1 RETURNING hits`,
        ).bind(key, bucket),
      ),
    ]);
    if (
      Number(rate[rate.length - 2]?.results[0]?.["hits"]) > 10 ||
      Number(rate[rate.length - 1]?.results[0]?.["hits"]) > 100
    ) {
      throw new HttpError(429, "rate_limited");
    }
    const state = randomToken();
    const browser = randomToken();
    const nonce = randomToken();
    const verifier = provider.verifier();
    const target = await provider.authorizationUrl(env, state, nonce, verifier);
    const inserted = await env.PERSONAL_DB.prepare(
      `INSERT INTO oauth_transactions
       (state_hash, browser_hash, verifier, return_path, created_at, expires_at, nonce, started_epoch)
       SELECT ?, ?, ?, '/', ?, ?, ?, epoch FROM auth_control WHERE singleton = 1
       AND (SELECT count(*) FROM oauth_transactions) < 300`,
    )
      .bind(await sha256(state), await sha256(browser), verifier, time, time + FLOW_TTL_MS, nonce)
      .run();
    if (inserted.meta.changes !== 1) throw new HttpError(429, "rate_limited");
    return response({ authorizationUrl: target.href }, 200, {
      "Set-Cookie": cookie(FLOW_COOKIE, browser, FLOW_TTL_MS / 1_000),
    });
  }

  async function callback(request: Request, env: PersonalEnv): Promise<Response> {
    const input = await body(request);
    exactKeys(input, ["parameters"]);
    if (
      typeof input["parameters"] !== "string" ||
      input["parameters"].length > 8_192 ||
      !input["parameters"].startsWith("?")
    )
      throw new HttpError(400, "auth_failed");
    const url = new URL(settings(env).redirectUri);
    url.search = input["parameters"];
    const states = url.searchParams.getAll("state");
    const browser = cookieValue(request, FLOW_COOKIE);
    if (
      url.href.length > 8_192 ||
      states.length !== 1 ||
      !states[0] ||
      !/^[a-f0-9]{64}$/.test(states[0]) ||
      !browser
    )
      throw new HttpError(400, "auth_failed");
    const state = states[0];
    const pending = await consumeOAuthTransaction(
      env.PERSONAL_DB,
      await sha256(state),
      await sha256(browser),
      now(),
    );
    if (!pending) throw new HttpError(400, "auth_failed");
    try {
      const codes = url.searchParams.getAll("code");
      const issuers = url.searchParams.getAll("iss");
      if (
        codes.length !== 1 ||
        !codes[0] ||
        issuers.length > 1 ||
        (issuers[0] !== undefined && issuers[0] !== "https://accounts.google.com")
      ) {
        throw new HttpError(400, "auth_failed");
      }
      const identity = await provider.exchange(env, url, state, pending);
      const current = await optionalAccount(request, env);
      if (
        current &&
        (current.identity.issuer !== identity.issuer || current.identity.sub !== identity.sub)
      ) {
        throw new HttpError(409, "account_switch_requires_logout");
      }
      const hash = await identityHash(identity);
      const existing = await env.PERSONAL_DB.prepare(
        "SELECT i.user_id, a.blocked FROM identities i JOIN accounts a USING(user_id) WHERE i.issuer = ? AND i.subject = ?",
      )
        .bind(identity.issuer, identity.sub)
        .first<{ user_id: string; blocked: number }>();
      if (existing?.blocked && !(await resumeDeletion(env, existing.user_id))) {
        throw new HttpError(503, "service_unavailable");
      }
      const raw = randomToken();
      const tokenHash = await sha256(raw);
      const time = now();
      const provisioning = await provisioningStatements(
        env.PERSONAL_DB,
        identity,
        crypto.randomUUID(),
        time,
        false,
        pending.started_epoch,
      );
      const results = await env.PERSONAL_DB.batch([
        ...provisioning,
        env.PERSONAL_DB.prepare(
          `INSERT INTO sessions
           (token_hash, user_id, created_at, idle_expires_at, max_expires_at, auth_epoch)
           SELECT ?, a.user_id, ?, ?, ?, a.auth_epoch FROM accounts a JOIN identities i USING(user_id)
           WHERE i.issuer = ? AND i.subject = ? AND a.blocked = 0 AND a.auth_epoch <= ?
           AND NOT EXISTS (SELECT 1 FROM identity_deletion_fences
                           WHERE identity_hash = ? AND deleted_epoch > ? AND expires_at > ?)`,
        ).bind(
          tokenHash,
          time,
          time + SESSION_IDLE_MS,
          time + SESSION_MAX_MS,
          identity.issuer,
          identity.sub,
          pending.started_epoch,
          hash,
          pending.started_epoch,
          time,
        ),
        env.PERSONAL_DB.prepare(
          `UPDATE accounts SET last_active_at = max(last_active_at, ?)
           WHERE user_id = (SELECT user_id FROM sessions WHERE token_hash = ?)`,
        ).bind(time, tokenHash),
        env.PERSONAL_DB.prepare("SELECT user_id FROM sessions WHERE token_hash = ?").bind(
          tokenHash,
        ),
        env.PERSONAL_DB.prepare("SELECT count(*) AS n FROM accounts"),
      ]);
      if (!results[results.length - 2]?.results[0]) {
        if (
          Number(results[results.length - 1]?.results[0]?.["n"]) >= 150 &&
          !results[provisioning.length - 1]?.results[0]
        )
          throw new HttpError(403, "beta_full");
        throw new HttpError(401, "auth_failed");
      }
      const headers = new Headers();
      headers.append("Set-Cookie", cookie(FLOW_COOKIE, "", 0));
      headers.append("Set-Cookie", cookie(SESSION_COOKIE, raw, SESSION_IDLE_MS / 1_000));
      return response({ redirect: "/" }, 200, headers);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(401, "auth_failed");
    }
  }

  async function activity(request: Request, env: PersonalEnv, result: Response): Promise<Response> {
    const raw = cookieValue(request, SESSION_COOKIE);
    if (!raw || !(await touchSession(env.PERSONAL_DB, raw, now()))) return result;
    const account = await readSession(env.PERSONAL_DB, raw, now());
    if (account)
      result.headers.append(
        "Set-Cookie",
        cookie(
          SESSION_COOKIE,
          raw,
          Math.min(SESSION_IDLE_MS, account.maxExpiresAt - now()) / 1_000,
        ),
      );
    return result;
  }

  return {
    async fetch(request: Request, env: PersonalEnv): Promise<Response> {
      const path = new URL(request.url).pathname;
      try {
        const allowed = routes[path];
        if (!allowed) throw new HttpError(404, "not_found");
        if (!allowed.includes(request.method)) throw new HttpError(405, "method_not_allowed");
        const config = settings(env);
        if (new URL(request.url).origin !== config.origin)
          throw new HttpError(400, "origin_rejected");
        if (!["GET", "HEAD"].includes(request.method)) sameOrigin(request, config.origin);
        if (path === "/auth/callback/google" && request.method === "GET") {
          // Google navigates cross-site. GET is inert; only this same-origin POST consumes the flow.
          const nonce = randomToken();
          const html = `<!doctype html><meta charset="utf-8"><title>Google login</title>
<body>Completing login…<script nonce="${nonce}">
(async () => {
  const parameters = location.search;
  history.replaceState(null, "", "/auth/callback/google");
  try {
    const r = await fetch("/auth/callback/google", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({parameters})
    });
    const data = await r.json();
    if (r.ok && data.redirect === "/") location.replace("/");
    else document.body.textContent = data.error === "account_switch_requires_logout"
      ? "Log out before signing in to a different account." : "Login failed. Start again.";
  } catch { document.body.textContent = "Login failed. Start again."; }
})();
</script>`;
          return new Response(html, {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
              "Referrer-Policy": "no-referrer",
              "X-Content-Type-Options": "nosniff",
              "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
            },
          });
        }
        if (path === "/auth/login/google") return await login(request, env);
        if (path === "/auth/callback/google") return await callback(request, env);
        const effective = aliases[path] ?? path;
        if (effective === "/v1/statistics") {
          const release = await env.PUBLIC_AGGREGATE_DB.prepare(
            `SELECT r.payload FROM privacy_fence f JOIN current_release p ON p.singleton = f.singleton
             JOIN weekly_releases r ON r.release_id = p.release_id
             WHERE f.singleton = 1 AND f.blocked = 0 AND p.fence_generation = f.generation
             AND r.fence_generation = f.generation`,
          ).first<{ payload: string }>();
          return release
            ? response(JSON.parse(release.payload))
            : response({ error: "privacy_fenced" }, 503);
        }
        // Site's DELETE session alias logs out THIS session, never deletes the account.
        if (
          effective === "/auth/logout" ||
          (path === "/api/auth/session" && request.method === "DELETE")
        ) {
          if (request.body) exactKeys(await body(request), []);
          const raw = cookieValue(request, SESSION_COOKIE);
          if (raw)
            await env.PERSONAL_DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
              .bind(await sha256(raw))
              .run();
          return response({ loggedOut: true }, 200, {
            "Set-Cookie": cookie(SESSION_COOKIE, "", 0),
          });
        }
        const account = await authorize(request, env);
        if (
          (effective === "/v1/account" && request.method === "DELETE") ||
          (effective === "/v1/consent" && request.method === "PUT") ||
          (effective === "/v1/workspace" && request.method === "PUT") ||
          effective === "/v1/sessions/revoke-all"
        ) {
          requireAccountContext(request, account.userId);
        }
        if (effective === "/v1/account" && request.method === "GET") {
          return response({
            authenticated: true,
            account: { userId: account.userId, generation: account.authEpoch },
            consent: await getConsent(env, account.userId),
          });
        }
        if (effective === "/v1/account" && request.method === "DELETE") {
          const result = await queueDeletion(env, account, opBody(await body(request)), now());
          return response(result, 202, { "Set-Cookie": cookie(SESSION_COOKIE, "", 0) });
        }
        if (effective === "/v1/sessions/revoke-all") {
          opBody(await body(request));
          await revokeAll(env.PERSONAL_DB, account.userId);
          return response({ revoked: true }, 200, { "Set-Cookie": cookie(SESSION_COOKIE, "", 0) });
        }
        if (effective === "/v1/consent") {
          if (request.method === "GET") return response(await getConsent(env, account.userId));
          return activity(
            request,
            env,
            response(await putConsent(env, account, consentBody(await body(request)), now())),
          );
        }
        if (effective === "/v1/workspace") {
          if (request.method === "GET")
            return response(await getWorkspace(env.PERSONAL_DB, account.userId));
          const input = workspaceBody(await body(request));
          const result = await putWorkspace(env.PERSONAL_DB, account.userId, input, now());
          if (result.status === "saved") return activity(request, env, response(result));
          return response(result, result.status === "archive_quota_reached" ? 422 : 409);
        }
        if (effective === "/v1/self-percentile") {
          const consent = await getConsent(env, account.userId);
          const releases = await env.PUBLIC_AGGREGATE_DB.batch([
            env.PUBLIC_AGGREGATE_DB.prepare(
              `SELECT r.release_id FROM weekly_releases r JOIN privacy_fence f
               ON r.fence_generation = f.generation WHERE f.singleton = 1 AND f.blocked = 0`,
            ),
          ]);
          const validReleases = (releases[0]?.results ?? []).map((row) =>
            String(row["release_id"]),
          );
          const ranks = consent.participation
            ? await env.PERSONAL_DB.batch([
                env.PERSONAL_DB.prepare(
                  "SELECT payload FROM self_percentiles WHERE user_id = ? AND release_id IN (SELECT value FROM json_each(?))",
                ).bind(account.userId, JSON.stringify(validReleases)),
              ])
            : [];
          const percentiles = (ranks[0]?.results ?? []).map(
            (row) => JSON.parse(String(row["payload"])) as SelfPercentile,
          );
          return response({ results: percentiles });
        }
        if (effective === "/v1/export") {
          const consent = await getConsent(env, account.userId);
          const data = await env.PERSONAL_DB.batch([
            workspaceRead(env.PERSONAL_DB, account.userId),
            env.PERSONAL_DB.prepare("SELECT summary FROM stage_summaries WHERE user_id = ?").bind(
              account.userId,
            ),
            env.PERSONAL_DB.prepare("SELECT payload FROM pending_archives WHERE user_id = ?").bind(
              account.userId,
            ),
            env.PERSONAL_DB.prepare("SELECT payload FROM self_percentiles WHERE user_id = ?").bind(
              account.userId,
            ),
            env.PERSONAL_DB.prepare(
              "SELECT created_at, last_active_at FROM accounts WHERE user_id = ?",
            ).bind(account.userId),
          ]);
          const workspace = workspaceResult(
            (data[0]?.results[0] as unknown as WorkspaceRow | undefined) ?? null,
          );
          const metadata = data[4]?.results[0] as
            | { created_at: number; last_active_at: number }
            | undefined;
          if (!workspace || !metadata) throw new HttpError(401, "unauthenticated");
          return response({
            schemaVersion: 1,
            exportedAt: now(),
            workspace,
            consent,
            account: {
              userId: account.userId,
              createdAt: metadata.created_at,
              lastActiveAt: metadata.last_active_at,
            },
            selfPercentiles: (data[3]?.results ?? []).map(
              (row) => JSON.parse(String(row["payload"])) as SelfPercentile,
            ),
            stages: (data[1]?.results ?? []).map(
              (row) => JSON.parse(String(row["summary"])) as StageSummary,
            ),
            pendingArchives: (data[2]?.results ?? []).map(
              (row) => JSON.parse(String(row["payload"])) as Archive,
            ),
          } satisfies PersonalExport);
        }
        throw new HttpError(404, "not_found");
      } catch (error) {
        // No exception, headers, callback URL, query, code, IP, token or user data logging.
        const result =
          error instanceof HttpError
            ? response({ error: error.reason }, error.status)
            : response({ error: "service_unavailable" }, 503);
        if (path === "/auth/callback/google")
          result.headers.append("Set-Cookie", cookie(FLOW_COOKIE, "", 0));
        return result;
      }
    },
    async scheduled(controller: { scheduledTime: number }, env: PersonalEnv): Promise<void> {
      const time = controller.scheduledTime;
      try {
        await env.PERSONAL_DB.batch([
          env.PERSONAL_DB.prepare(
            "DELETE FROM identity_deletion_fences WHERE expires_at <= ?",
          ).bind(time),
          env.PERSONAL_DB.prepare("DELETE FROM oauth_transactions WHERE expires_at <= ?").bind(
            time,
          ),
          env.PERSONAL_DB.prepare(
            "DELETE FROM sessions WHERE idle_expires_at <= ? OR max_expires_at <= ?",
          ).bind(time, time),
        ]);
      } catch {
        throw new Error("maintenance_failed");
      }
    },
  };
}

export default createWorker();
