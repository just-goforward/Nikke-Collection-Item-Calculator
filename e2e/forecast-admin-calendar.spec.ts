import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { build } from "esbuild";
import { Miniflare, Response } from "miniflare";
import {
  ACCESS_AUD,
  ADMIN_EMAIL,
  accessClaims,
  applySql,
  calendarFixture,
  createAccessKeys,
  SCHEMA_LEDGER_SQL,
  seedCalendar,
  seedUsageGuard,
  signAccessToken,
  TEAM_DOMAIN,
} from "../forecast-admin/test/fixtures.ts";

// T11: read-only admin calendar in local workerd (Miniflare) with seeded local D1.
// Outbound traffic is answered locally (JWKS) or rejected; no network is used.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
let mf: Miniflare | undefined;
let origin: string;
let token: string;
let nowMs: number;
let range: { start: string; end: string };

test.beforeAll(async () => {
  nowMs = Date.now();
  const keys = await createAccessKeys();
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../forecast-admin/src/worker.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
    logLevel: "silent",
  });
  const contents = bundle.outputFiles[0]?.text;
  if (!contents) throw new Error("bundle_missing");
  const text = (value: string) => ({ type: "text" as const, value });
  const limiter = (namespace: string) => ({
    type: "rate-limit" as const,
    namespace,
    simple: { limit: 1000, period: 60 as const },
  });
  mf = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    cf: false,
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: "forecast-admin-e2e",
          compatibilityDate: "2026-08-22",
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents } },
          },
          env: {
            FORECAST_DB: { type: "d1" },
            USAGE_GUARD_DB: { type: "d1" },
            ADMIN_IP_RATE_LIMITER: limiter("419108"),
            ADMIN_IDENTITY_RATE_LIMITER: limiter("419109"),
            ACCESS_TEAM_DOMAIN: text(TEAM_DOMAIN),
            ACCESS_AUD: text(ACCESS_AUD),
            ADMIN_ALLOWED_EMAILS: text(ADMIN_EMAIL),
          },
        },
        dev: {
          stripCfConnectingIp: false,
          outboundService: {
            type: "fetcher",
            handler: (request) => {
              if (request.url !== `${TEAM_DOMAIN}/cdn-cgi/access/certs`)
                throw new Error(`Unexpected network access: ${request.url}`);
              return Response.json(keys.jwks);
            },
          },
        },
      },
    ],
  });
  origin = (await mf.ready).origin;
  const forecast = await mf.getD1Database("FORECAST_DB");
  await applySql(forecast, SCHEMA_LEDGER_SQL);
  for (const file of [
    "0030_monitor_streams",
    "0031_calendar_decisions",
    "0032_grant_occurrences",
    "0033_calendar_snapshots",
  ])
    await applySql(forecast, read(`../forecast-collector/migrations/${file}.sql`));
  ({ range } = await seedCalendar(forecast, nowMs, { version: 3 }));
  const guard = await mf.getD1Database("USAGE_GUARD_DB");
  await applySql(guard, read("../usage-guard/schema.sql"));
  await seedUsageGuard(guard, nowMs);
  token = await signAccessToken(
    keys.privateKey,
    accessClaims(nowMs, { exp: Math.floor(nowMs / 1000) + 3600 }),
  );
});

test.afterAll(async () => {
  await mf?.dispose();
});

async function authenticate(page: Page) {
  await page.setExtraHTTPHeaders({
    "Cf-Access-Jwt-Assertion": token,
    "CF-Connecting-IP": "203.0.113.7",
  });
}

/** Expected KST label computed independently with Intl, not with the Worker's formatter. */
function kstLabel(iso: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Seoul",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(iso))
      .map((part) => [part.type, part.value]),
  );
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts["weekday"] ?? "");
  return `${parts["month"]}/${parts["day"]}(${"일월화수목금토"[weekday]}) ${parts["hour"]}:${parts["minute"]}`;
}

test("renders the KST calendar without scripts, independent of the browser time zone", async ({
  page,
}, testInfo) => {
  await authenticate(page);
  const response = await page.goto(`${origin}/`);
  expect(response?.status()).toBe(200);
  const headers = response?.headers() ?? {};
  expect(headers["content-security-policy"]).toContain("default-src 'none'");
  expect(headers["cache-control"]).toBe("no-store");
  expect(headers["x-robots-tag"]).toBe("noindex, nofollow");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(await page.locator("script").count()).toBe(0);
  expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe(
    testInfo.project.use.timezoneId,
  );

  const { today, day, events } = calendarFixture(nowMs);
  expect(range.start).toBe(today);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    `운영 달력 (${range.start} ~ ${range.end})`,
  );
  const days = page.locator("ol.days > li");
  const expectedDays =
    Math.round(
      (Date.parse(`${range.end}T00:00:00Z`) - Date.parse(`${range.start}T00:00:00Z`)) / 86_400_000,
    ) + 1;
  await expect(days).toHaveCount(expectedDays);
  await expect(days.first()).toHaveAttribute("id", `gd-${today}`);
  await expect(days.first()).toHaveAttribute("aria-current", "date");

  const predicted = events[1];
  await expect(page.locator(`#gd-${day(15)}`)).toContainText(
    `예측 · 솔로 레이드 · 시즌 43 · 1일차 · ${kstLabel(predicted.startsAt)} 시작`,
  );
  await expect(page.locator(`#gd-${day(22)}`)).toContainText("차순위 예측 · 시즌 43 (28일 간격)");
  await expect(page.locator(`#gd-${day(9)}`)).toContainText(
    `예상 공지 시점 · 시즌 43 오픈 공지 · ${kstLabel(predicted.provenance.expectedNoticeAt)} (예측)`,
  );
  await expect(page.locator(`#gd-${day(5)}`)).toContainText(
    `확정 · 콜라보 · 콜라보 이벤트 · 1일차 · ${kstLabel(events[3].startsAt)} 시작`,
  );
  await expect(page.locator(`#gd-${day(2)}`)).toContainText("결정 대기 · 지급일 결정 대기");
  await expect(
    page.getByText("협동작전 상점 · 관리 키트 상자 II ×10 (콜라보 기간 2배)").first(),
  ).toBeVisible();

  const layout = await page.evaluate(() => {
    const list = document.querySelector("ol.days");
    const first = list?.firstElementChild;
    if (!list || !first) throw new Error("calendar_missing");
    const style = getComputedStyle(list);
    return {
      display: style.display,
      columns: style.gridTemplateColumns.split(" ").filter(Boolean).length,
      firstColumn: getComputedStyle(first).gridColumnStart,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      weekdayHeader: getComputedStyle(document.querySelector(".dow-head") as Element).display,
    };
  });
  expect(layout.overflow).toBeLessThanOrEqual(0);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  if ((page.viewportSize()?.width ?? 0) >= 640) {
    expect(layout).toMatchObject({ display: "grid", columns: 7, weekdayHeader: "grid" });
    expect(layout.firstColumn).toBe(weekday === 0 ? "auto" : String(weekday + 1));
  } else {
    expect(layout).toMatchObject({ display: "block", weekdayHeader: "none" });
  }
});

test("has no axe violations (WCAG 2.1 A/AA)", async ({ page }) => {
  await authenticate(page);
  await page.goto(`${origin}/`);
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(result.violations).toEqual([]);
});

test("a superseded ?rev= link shows the latest calendar with a notice and keeps the day anchor", async ({
  page,
}) => {
  await authenticate(page);
  const target = calendarFixture(nowMs).day(20);
  await page.goto(`${origin}/?rev=2#gd-${target}`);
  await expect(page.getByRole("status")).toContainText("이 링크 이후 갱신됨");
  await expect(page.locator(`#gd-${target}`)).toBeInViewport();
});

test("rejects requests without a Cloudflare Access assertion", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "CF-Connecting-IP": "203.0.113.7" });
  const response = await page.goto(`${origin}/`);
  expect(response?.status()).toBe(401);
  await expect(page.locator("ol.days")).toHaveCount(0);
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(result.violations).toEqual([]);
});
