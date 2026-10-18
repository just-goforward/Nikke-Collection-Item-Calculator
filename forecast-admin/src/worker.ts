import { assertUsageAllowed } from "../../shared/usageGuard.ts";
import { AccessError, accessConfig, createAccessVerifier } from "./access.ts";
import { type ReadDatabase, readActiveCalendar } from "./calendar.ts";
import { renderCalendarPage, renderMessagePage, STYLE } from "./render.ts";

type RateLimiter = { limit(input: { key: string }): Promise<{ success: boolean }> };
type GuardDatabase = {
  withSession(constraint: "first-primary"): {
    prepare(sql: string): { first<T>(): Promise<T | null> };
  };
};

/** Staging-only bindings; the production forecast database is never bound. */
export type AdminEnv = {
  FORECAST_DB: ReadDatabase;
  USAGE_GUARD_DB: GuardDatabase;
  ADMIN_IP_RATE_LIMITER: RateLimiter;
  ADMIN_IDENTITY_RATE_LIMITER: RateLimiter;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ADMIN_ALLOWED_EMAILS?: string;
};

let styleHash: Promise<string> | null = null;
function cspStyleHash() {
  styleHash ??= crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(STYLE))
    .then((digest) => `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`);
  return styleHash;
}

async function page(status: number, body: string, request: Request, extra: HeadersInit = {}) {
  const headers = new Headers(extra);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set(
    "Content-Security-Policy",
    `default-src 'none'; style-src ${await cspStyleHash()}; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  );
  headers.set("Cache-Control", "no-store");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return new Response(request.method === "HEAD" ? null : body, { status, headers });
}

const message = (
  status: number,
  title: string,
  text: string,
  request: Request,
  extra?: HeadersInit,
) => page(status, renderMessagePage(title, text), request, extra);

async function allowed(limiter: RateLimiter, key: string) {
  try {
    return (await limiter.limit({ key })).success;
  } catch {
    return false;
  }
}

function requestedRevision(url: URL): number | null {
  const value = url.searchParams.get("rev");
  return value !== null && /^\d{1,15}$/.test(value) ? Number(value) : null;
}

/** Order: IP limit → Access JWT → allow-list → identity limit → route → Usage Guard → one read. */
export function createAdminHandler(options: { fetch?: typeof fetch; now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const verify = createAccessVerifier({ ...options, now });
  return async (request: Request, env: AdminEnv): Promise<Response> => {
    const ip = request.headers.get("CF-Connecting-IP");
    if (!ip || !(await allowed(env.ADMIN_IP_RATE_LIMITER, ip)))
      return message(429, "요청이 너무 많습니다", "잠시 후 다시 시도하세요.", request, {
        "Retry-After": "60",
      });
    const config = accessConfig(env);
    if (!config)
      return message(503, "설정되지 않음", "관리 페이지 접근 설정이 완료되지 않았습니다.", request);
    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token) return message(401, "인증 필요", "Cloudflare Access 인증이 필요합니다.", request);
    let email: string;
    try {
      email = (await verify(token, config)).email;
    } catch (error) {
      if (error instanceof AccessError && error.code === "jwks_unavailable")
        return message(503, "인증 확인 불가", "인증 키를 확인할 수 없습니다.", request);
      return message(401, "인증 필요", "Cloudflare Access 인증이 필요합니다.", request);
    }
    if (!config.allowed.has(email))
      return message(
        403,
        "접근 권한 없음",
        "이 계정은 관리 페이지 접근이 허용되지 않았습니다.",
        request,
      );
    if (!(await allowed(env.ADMIN_IDENTITY_RATE_LIMITER, email)))
      return message(429, "요청이 너무 많습니다", "잠시 후 다시 시도하세요.", request, {
        "Retry-After": "60",
      });
    const url = new URL(request.url);
    if (url.pathname !== "/") return message(404, "찾을 수 없음", "페이지가 없습니다.", request);
    if (request.method !== "GET" && request.method !== "HEAD")
      return message(405, "허용되지 않는 요청", "읽기 전용 페이지입니다.", request, {
        Allow: "GET, HEAD",
      });
    try {
      await assertUsageAllowed(
        env.USAGE_GUARD_DB.withSession("first-primary"),
        "admin_read",
        now(),
      );
    } catch {
      return message(503, "일시 중지", "사용량 보호 장치가 조회를 중지했습니다.", request);
    }
    try {
      const calendar = await readActiveCalendar(env.FORECAST_DB);
      return page(
        200,
        renderCalendarPage({ calendar, nowMs: now(), requestedRevision: requestedRevision(url) }),
        request,
      );
    } catch (error) {
      console.error(
        JSON.stringify({ event: "admin_calendar_unavailable", code: (error as Error).message }),
      );
      return message(503, "달력을 불러오지 못했습니다", "잠시 후 다시 시도하세요.", request);
    }
  };
}

const handler = createAdminHandler();

export default {
  fetch(request: Request, env: AdminEnv) {
    return handler(request, env);
  },
};
