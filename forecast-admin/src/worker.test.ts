import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import migration30 from "../../forecast-collector/migrations/0030_monitor_streams.sql?raw";
import migration31 from "../../forecast-collector/migrations/0031_calendar_decisions.sql?raw";
import migration32 from "../../forecast-collector/migrations/0032_grant_occurrences.sql?raw";
import migration33 from "../../forecast-collector/migrations/0033_calendar_snapshots.sql?raw";
import { executeTestSql } from "../../shared/testD1Sql.ts";
import usageSchema from "../../usage-guard/schema.sql?raw";
import {
  ACCESS_AUD,
  accessClaims,
  calendarFixture,
  createAccessKeys,
  encodeJson,
  SCHEMA_LEDGER_SQL,
  type SeedOptions,
  seedCalendar,
  seedUsageGuard,
  signAccessToken,
  TEAM_DOMAIN,
} from "../test/fixtures.ts";
import worker, { type AdminEnv, createAdminHandler } from "./worker.ts";

// 2026-10-18 19:00 KST, a Sunday: game day T = 2026-10-18, T+2 is a Tuesday.
const NOW = Date.parse("2026-10-18T10:00:00.000Z");
const URL_ROOT = "https://forecast-admin-staging.nikkecollection.com/";
const IP = "203.0.113.9";
type TestEnv = AdminEnv & { FORECAST_DB: D1Database; USAGE_GUARD_DB: D1Database };

let keys: Awaited<ReturnType<typeof createAccessKeys>>;
let otherKeys: Awaited<ReturnType<typeof createAccessKeys>>;
let testEnv: TestEnv;
let clock: number;
let jwksResponse: () => Response;
let jwksFetch: ReturnType<typeof vi.fn>;
let handler: ReturnType<typeof createAdminHandler>;

beforeAll(async () => {
  keys = await createAccessKeys();
  otherKeys = await createAccessKeys();
});

beforeEach(async () => {
  await reset();
  testEnv = { ...(env as unknown as TestEnv) };
  // D1 parses each complete script, including `;` inside trigger bodies.
  for (const sql of [SCHEMA_LEDGER_SQL, migration30, migration31, migration32, migration33])
    await executeTestSql(testEnv.FORECAST_DB, sql, applyD1Migrations);
  await executeTestSql(testEnv.USAGE_GUARD_DB, usageSchema, applyD1Migrations);
  await seedUsageGuard(testEnv.USAGE_GUARD_DB, NOW);
  clock = NOW;
  jwksResponse = () => Response.json(keys.jwks);
  jwksFetch = vi.fn(async (input: RequestInfo | URL) =>
    String(input) === `${TEAM_DOMAIN}/cdn-cgi/access/certs`
      ? jwksResponse()
      : new Response("unexpected", { status: 404 }),
  );
  handler = createAdminHandler({ fetch: jwksFetch as unknown as typeof fetch, now: () => clock });
});

const validToken = (overrides: Record<string, unknown> = {}) =>
  signAccessToken(keys.privateKey, accessClaims(clock, overrides));

async function call(
  token: string | null,
  options: { path?: string; method?: string; env?: Partial<AdminEnv>; ip?: string | null } = {},
) {
  const headers = new Headers();
  if (options.ip !== null) headers.set("CF-Connecting-IP", options.ip ?? IP);
  if (token !== null) headers.set("Cf-Access-Jwt-Assertion", token);
  const response = await handler(
    new Request(new URL(options.path ?? "/", URL_ROOT), {
      method: options.method ?? "GET",
      headers,
    }),
    { ...testEnv, ...options.env },
  );
  return { response, body: await response.text() };
}

async function seeded(options: SeedOptions = {}) {
  await seedCalendar(testEnv.FORECAST_DB, NOW, options);
  return call(await validToken());
}

describe("authentication (A11, fail closed)", () => {
  it("returns 401 without an Access assertion and never fetches keys", async () => {
    const { response, body } = await call(null);
    expect(response.status).toBe(401);
    expect(body).toContain("인증 필요");
    expect(jwksFetch).not.toHaveBeenCalled();
  });

  it("wires the default export to the same fail-closed path", async () => {
    const response = await worker.fetch(
      new Request(URL_ROOT, { headers: { "CF-Connecting-IP": IP } }),
      testEnv,
    );
    expect(response.status).toBe(401);
  });

  it("accepts a valid RS256 token from the allow-listed identity (case-insensitive)", async () => {
    const { response } = await call(await validToken({ email: "Admin@Example.COM" }));
    expect(response.status).toBe(200);
    expect(jwksFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["forged signature", () => signAccessToken(otherKeys.privateKey, accessClaims(NOW))],
    [
      "unsigned alg=none",
      async () => `${encodeJson({ alg: "none", typ: "JWT" })}.${encodeJson(accessClaims(NOW))}.`,
    ],
    [
      "empty RS256 signature",
      async () =>
        `${encodeJson({ alg: "RS256", kid: "test-kid" })}.${encodeJson(accessClaims(NOW))}.`,
    ],
    [
      "alg=none header with a real signature",
      async () =>
        signAccessToken(keys.privateKey, accessClaims(NOW), { alg: "none", kid: "test-kid" }),
    ],
    [
      "HS256 header",
      async () =>
        signAccessToken(keys.privateKey, accessClaims(NOW), { alg: "HS256", kid: "test-kid" }),
    ],
    [
      "tampered payload",
      async () => {
        const [header, , signature] = (await validToken()).split(".");
        return `${header}.${encodeJson(accessClaims(NOW, { email: "other@example.com" }))}.${signature}`;
      },
    ],
    ["expired", () => validToken({ exp: Math.floor(NOW / 1000) - 3600 })],
    ["not yet valid", () => validToken({ nbf: Math.floor(NOW / 1000) + 3600 })],
    ["wrong audience", () => validToken({ aud: ["b".repeat(64)] })],
    ["wrong issuer", () => validToken({ iss: "https://evil.cloudflareaccess.com" })],
    ["missing email", () => validToken({ email: undefined })],
    ["malformed", async () => "not-a-jwt"],
  ])("rejects a %s token with 401", async (_name, makeToken) => {
    await seedCalendar(testEnv.FORECAST_DB, NOW);
    const { response, body } = await call(await makeToken());
    expect(response.status).toBe(401);
    expect(body).not.toContain("운영 달력 (");
  });

  it("returns 403 for a valid token outside the allow-list", async () => {
    const { response, body } = await call(await validToken({ email: "intruder@example.com" }));
    expect(response.status).toBe(403);
    expect(body).toContain("접근 권한 없음");
  });

  it.each([
    ["placeholder allow-list", { ADMIN_ALLOWED_EMAILS: "unset" }],
    ["empty allow-list", { ADMIN_ALLOWED_EMAILS: " , " }],
    ["placeholder audience", { ACCESS_AUD: "unset" }],
    ["non-Access team domain", { ACCESS_TEAM_DOMAIN: "https://example.com" }],
  ])("fails closed with 503 on a %s", async (_name, override) => {
    const { response } = await call(await validToken(), { env: override });
    expect(response.status).toBe(503);
    expect(jwksFetch).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when the team keys cannot be fetched", async () => {
    jwksResponse = () => new Response("down", { status: 500 });
    expect((await call(await validToken())).response.status).toBe(503);
    jwksResponse = () => new Response(null, { status: 302, headers: { Location: "https://x" } });
    clock += 31_000;
    expect((await call(await validToken())).response.status).toBe(503);
  });

  it("looks keys up by kid with a throttled refresh for unknown kids", async () => {
    expect((await call(await validToken())).response.status).toBe(200);
    const unknown = await signAccessToken(otherKeys.privateKey, accessClaims(clock), {
      alg: "RS256",
      kid: "rotated-kid",
    });
    expect((await call(unknown)).response.status).toBe(401);
    expect(jwksFetch).toHaveBeenCalledTimes(1);
    // After the refresh interval the published rotation is picked up.
    jwksResponse = () =>
      Response.json({
        keys: [...keys.jwks.keys, { ...otherKeys.jwks.keys[0], kid: "rotated-kid" }],
      });
    clock += 31_000;
    const rotated = await signAccessToken(otherKeys.privateKey, accessClaims(clock), {
      alg: "RS256",
      kid: "rotated-kid",
    });
    expect((await call(rotated)).response.status).toBe(200);
    expect(jwksFetch).toHaveBeenCalledTimes(2);
  });
});

describe("limits and guard order", () => {
  function recording(results: { ip?: boolean; identity?: boolean } = {}) {
    const calls: string[] = [];
    const limiter = (name: string, success: boolean) => ({
      async limit({ key }: { key: string }) {
        calls.push(`${name}:${key}`);
        return { success };
      },
    });
    const overrides: Partial<AdminEnv> = {
      ADMIN_IP_RATE_LIMITER: limiter("ip", results.ip ?? true),
      ADMIN_IDENTITY_RATE_LIMITER: limiter("identity", results.identity ?? true),
      USAGE_GUARD_DB: {
        withSession: (constraint) => {
          calls.push("guard");
          return testEnv.USAGE_GUARD_DB.withSession(constraint);
        },
      },
      FORECAST_DB: {
        withSession: (constraint) => {
          calls.push("forecast");
          return testEnv.FORECAST_DB.withSession(constraint);
        },
      },
    };
    return { calls, overrides };
  }

  it("applies the IP limit before any authentication work", async () => {
    const { calls, overrides } = recording({ ip: false });
    const { response } = await call(await validToken(), { env: overrides });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(calls).toEqual([`ip:${IP}`]);
    expect(jwksFetch).not.toHaveBeenCalled();
  });

  it("treats a missing client IP as limited", async () => {
    const { calls, overrides } = recording();
    expect((await call(await validToken(), { env: overrides, ip: null })).response.status).toBe(
      429,
    );
    expect(calls).toEqual([]);
  });

  it("does not consume the identity limit for unauthenticated or non-allow-listed callers", async () => {
    const { calls, overrides } = recording();
    expect((await call(null, { env: overrides })).response.status).toBe(401);
    expect(
      (await call(await validToken({ email: "intruder@example.com" }), { env: overrides })).response
        .status,
    ).toBe(403);
    expect(calls).toEqual([`ip:${IP}`, `ip:${IP}`]);
  });

  it("applies the identity limit before Usage Guard and the calendar read", async () => {
    const { calls, overrides } = recording({ identity: false });
    expect((await call(await validToken(), { env: overrides })).response.status).toBe(429);
    expect(calls).toEqual([`ip:${IP}`, "identity:admin@example.com"]);
  });

  it("checks Usage Guard before the single calendar read", async () => {
    await seedCalendar(testEnv.FORECAST_DB, NOW);
    const { calls, overrides } = recording();
    expect((await call(await validToken(), { env: overrides })).response.status).toBe(200);
    expect(calls).toEqual([`ip:${IP}`, "identity:admin@example.com", "guard", "forecast"]);
  });

  it("stops before the calendar read when Usage Guard denies admin reads", async () => {
    await seedUsageGuard(testEnv.USAGE_GUARD_DB, NOW, "hard_stop");
    const { calls, overrides } = recording();
    const { response, body } = await call(await validToken(), { env: overrides });
    expect(response.status).toBe(503);
    expect(body).toContain("사용량 보호");
    expect(calls).not.toContain("forecast");
  });
});

describe("response contract", () => {
  it("sets strict security headers on every response", async () => {
    for (const { response, body } of [await call(null), await seeded()]) {
      const csp = response.headers.get("Content-Security-Policy") ?? "";
      expect(csp).toMatch(/^default-src 'none'; style-src 'sha256-[A-Za-z0-9+/]+=*'; /);
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain("unsafe");
      expect(csp).not.toContain("script-src");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      expect(body).not.toMatch(/<script/i);
      const style = /<style>([\s\S]*?)<\/style>/.exec(body)?.[1] ?? "";
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(style));
      expect(csp).toContain(`'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`);
    }
  });

  it("routes only GET/HEAD / after authentication", async () => {
    const token = await validToken();
    expect((await call(token, { path: "/other" })).response.status).toBe(404);
    const post = await call(token, { method: "POST" });
    expect(post.response.status).toBe(405);
    expect(post.response.headers.get("Allow")).toBe("GET, HEAD");
    await seedCalendar(testEnv.FORECAST_DB, NOW);
    const head = await call(token, { method: "HEAD" });
    expect(head.response.status).toBe(200);
    expect(head.body).toBe("");
  });

  it("escapes event titles through the single HTML encoder", async () => {
    const { response, body } = await seeded({
      titles: {
        "solo-s42": '<script>alert("x")</script>',
        "collab-1": '"><img src=x onerror=alert(1)>',
      },
    });
    expect(response.status).toBe(200);
    expect(body).not.toMatch(/<script/i);
    expect(body).not.toContain("<img");
    expect(body).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(body).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
  });
});

describe("calendar content (P4–P9)", () => {
  it("renders the current game day through the same date next month", async () => {
    const { today, day } = calendarFixture(NOW);
    const { response, body } = await seeded();
    expect(response.status).toBe(200);
    expect(body).toContain("운영 달력 (2026-10-18 ~ 2026-11-18)");
    expect(body.match(/<li id="gd-/g)).toHaveLength(32);
    expect(body).toContain('<ol class="days" aria-labelledby="days-heading">');
    expect(body).toContain(`<li id="gd-${today}" class="start-0" aria-current="date">`);
    expect(body).toContain('id="gd-2026-11-18"');
    expect(body).not.toContain('id="gd-2026-11-19"');
    // Confirmed solo, day 7, with the inclusive 04:59 end on its last game day.
    expect(body).toContain("확정</span> · 솔로 레이드 · 시즌 42 · 7일차 · 10/19(월) 04:59 종료");
    // Predicted season plus the labeled alternative and expected notice.
    expect(body).toContain(
      `<li id="gd-${day(15)}" class=""><h3><time datetime="${day(15)}">11/2 (월)</time></h3><ul class="evs"><li class="ev k-solo st-predicted"><span class="badge">예측</span> · 솔로 레이드 · 시즌 43 · 1일차 · 11/2(월) 12:00 시작</li>`,
    );
    expect(body).toContain("차순위 예측</span> · 시즌 43 (28일 간격) · 11/9(월) 12:00 시작");
    expect(body).toContain("예상 공지 시점</span> · 시즌 43 오픈 공지 · 10/27(화) 17:00 (예측)");
    expect(body).toContain("시작 간격 중앙값 21일");
    // Maintenance and the collaboration that starts after it.
    expect(body).toContain(
      "확정</span> · 점검 · 정기 점검 · 10/23(금) 06:00 시작 · 10/23(금) 10:00 종료",
    );
    expect(body).toContain("확정</span> · 콜라보 · 콜라보 이벤트 · 1일차 · 10/23(금) 10:00 시작");
    expect(body).toContain("점검 완료 후 시작(점검 일정 기준)");
    // Co-op x5 before the collaboration, x10 inside it; per-day kit totals.
    expect(body).toContain(
      `<li id="gd-${day(2)}" class=""><h3><time datetime="${day(2)}">10/20 (화)</time>`,
    );
    expect(body).toContain("협동작전 상점</span> · 관리 키트 상자 II ×5</li>");
    expect(body).toContain("협동작전 상점</span> · 관리 키트 상자 II ×10 (콜라보 기간 2배)</li>");
    expect(body).toContain("공지 보상</span> · 점검 보상 · 상자 II 10 · 상자 2");
    expect(body).toContain('<p class="kits">관리 키트 합계: 상자 II 15 · 상자 2</p>');
    expect(body).toContain("결정 대기</span> · 지급일 결정 대기 · 게시글 6579018");
    // Tuesdays 10/20 (x5), 10/27, 11/3, 11/10, 11/17 (x10): 5 + 40 = 45 co-op, +10 grant.
    expect(body).toContain('<tr><td>협동작전 상점</td><td class="num">45</td>');
    expect(body).toContain('<td class="num">55</td><td class="num">2</td></tr>');
    expect(body).not.toContain("이 링크 이후 갱신됨");
    expect(body).not.toContain("갱신되지 않았습니다");
  });

  it.each([
    ["2", true],
    ["3", false],
    ["9", false],
    ["abc", false],
    ["-1", false],
  ])("treats ?rev=%s as display-only (superseded notice: %s)", async (rev, superseded) => {
    await seedCalendar(testEnv.FORECAST_DB, NOW, { version: 3 });
    const { response, body } = await call(await validToken(), { path: `/?rev=${rev}` });
    expect(response.status).toBe(200);
    expect(body.includes("이 링크 이후 갱신됨")).toBe(superseded);
  });

  it("shows the empty state when no calendar is active", async () => {
    const { response, body } = await call(await validToken());
    expect(response.status).toBe(200);
    expect(body).toContain("활성 달력이 아직 없습니다");
  });

  it("marks a snapshot that has not rolled to today as stale", async () => {
    const { response, body } = await seeded({ rangeShiftDays: 1 });
    expect(response.status).toBe(200);
    expect(body).toContain("달력이 오늘 기준으로 갱신되지 않았습니다");
    expect(body).toContain("저장된 범위 2026-10-17 ~ 2026-11-17");
    expect(body).toContain(
      '<li id="gd-2026-11-18" class=""><h3><time datetime="2026-11-18">11/18 (수)</time></h3><p class="missing">',
    );
  });

  it("shows the error state for an invalid snapshot payload", async () => {
    const { response, body } = await seeded({ brokenPayload: true });
    expect(response.status).toBe(503);
    expect(body).toContain("달력을 불러오지 못했습니다");
    expect(body).not.toContain("day_payload");
  });

  it("does not leak configuration in responses", async () => {
    const { body } = await seeded();
    expect(body).not.toContain(ACCESS_AUD);
    expect(body).not.toContain("admin@example.com");
  });
});
