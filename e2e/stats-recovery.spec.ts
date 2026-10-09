import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, type Route } from "@playwright/test";
import { type PreviewServer, preview } from "vite";
import { closePreviewServer, test } from "./test";

const PORT = 4293;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const STATS_ORIGIN = "https://stats-recovery.example.invalid";
let server: PreviewServer | null = null;
let stagingDocument = "";
let manifest: Record<string, { file: string; isDynamicEntry?: boolean; src?: string }>;

const emptyStats = {
  windowDays: 0,
  today: "2026-10-05",
  summary: {
    events: 0,
    attempts: 0,
    greatSuccesses: 0,
    greatSuccessRate: 0,
    todayEvents: 0,
    todayAttempts: 0,
    todayGreatSuccesses: 0,
    mostUsedKit: null,
    mostUsedKitPieces: 0,
  },
  byKit: [],
  levelKitStats: [],
  segmentStats: [],
  successAttemptDistribution: [],
};

test.beforeAll(async () => {
  const html = await readFile(path.join(process.cwd(), "dist/index.html"), "utf8");
  const config = / {6}window\.COLLECTION_STATS_CONFIG = \{[\s\S]*? {6}\};/g;
  expect(
    [...html.matchAll(config)],
    "built document has one replaceable stats config",
  ).toHaveLength(1);
  stagingDocument = html.replace(
    config,
    [
      "      window.COLLECTION_STATS_CONFIG = {",
      `        endpoint: "${STATS_ORIGIN}",`,
      '        turnstileSiteKey: "stats-recovery-mock",',
      `        staging: { endpoint: "${STATS_ORIGIN}", turnstileSiteKey: "stats-recovery-mock" },`,
      "      };",
    ].join("\n"),
  );
  manifest = JSON.parse(
    await readFile(path.join(process.cwd(), "dist/.vite/manifest.json"), "utf8"),
  );
  server = await preview({
    configFile: false,
    root: process.cwd(),
    base: "/",
    preview: { host: "127.0.0.1", port: PORT, strictPort: true },
  });
});

test.afterAll(async () => {
  await closePreviewServer(server);
  server = null;
});

async function fulfillStats(route: Route, body = JSON.stringify(emptyStats)) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "Access-Control-Allow-Origin": ORIGIN },
    body,
  });
}

async function installStatsRoutes(
  page: Page,
  onStats: (route: Route) => Promise<void>,
  blockedModule?: { pathname: string; record: () => void },
) {
  const unexpected: string[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      url.origin === STATS_ORIGIN &&
      url.pathname === "/api/stats" &&
      request.method() === "GET"
    ) {
      await onStats(route);
      return;
    }
    if (url.origin === ORIGIN) {
      if (blockedModule && url.pathname === blockedModule.pathname) {
        blockedModule.record();
        await route.abort("failed");
        return;
      }
      if (request.resourceType() === "document" && url.searchParams.get("statsEnv") === "staging") {
        await route.fulfill({ status: 200, contentType: "text/html", body: stagingDocument });
        return;
      }
      await route.continue();
      return;
    }
    if (url.origin === "https://cdn.jsdelivr.net" && request.resourceType() === "stylesheet") {
      await route.fulfill({ status: 200, contentType: "text/css", body: "" });
      return;
    }
    unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
    await route.abort("blockedbyclient");
  });
  return unexpected;
}

async function openStats(page: Page, query = "statsEnv=staging") {
  await page.setViewportSize({ width: 1365, height: 900 });
  await page.goto(`${ORIGIN}/?${query}`);
  await expect(page.getByRole("button", { name: "0단계", exact: true })).toBeVisible();
  await page.getByLabel("초심자용 키트").fill("73");
  await page.getByRole("tab", { name: "통계", exact: true }).click();
}

async function expectInputsRetained(page: Page) {
  await page.getByRole("tab", { name: "계산기", exact: true }).click();
  await expect(page.getByLabel("초심자용 키트")).toHaveValue("73");
  await expect(page.getByRole("button", { name: "계산", exact: true })).toBeEnabled();
}

for (const failure of [
  { kind: "invalid-schema", text: "통계 응답 형식이 올바르지 않습니다." },
  { kind: "fetch", text: "통계 서버에 연결하지 못했습니다." },
  { kind: "json", text: "통계 서버에 연결하지 못했습니다." },
] as const) {
  test(`stats ${failure.kind} failure is contained and an explicit retry preserves inputs`, async ({
    page,
  }) => {
    let requests = 0;
    const unexpected = await installStatsRoutes(page, async (route) => {
      requests += 1;
      if (requests > 1) {
        await fulfillStats(route);
      } else if (failure.kind === "fetch") {
        await route.abort("failed");
      } else {
        await fulfillStats(route, failure.kind === "json" ? "{" : '{"summary":null}');
      }
    });
    await openStats(page);
    const panel = page.locator("#globalStatsBox");
    await expect(panel.getByRole("alert")).toContainText(failure.text);
    await expect(panel.getByRole("button", { name: "다시 불러오기", exact: true })).toBeEnabled();
    expect(requests).toBe(1);
    await panel.getByRole("button", { name: "다시 불러오기", exact: true }).click();
    await expect(panel).toContainText("아직 집계된 통계가 없습니다.");
    await expect(panel.getByRole("alert")).toHaveCount(0);
    expect(requests).toBe(2);
    await expectInputsRetained(page);
    expect(unexpected).toEqual([]);
  });
}

for (const moduleFailure of [
  {
    source: "src/lib/demoStats.ts",
    query: "demoStats=1",
    text: "통계를 불러오지 못했습니다.",
    apiRequests: 0,
  },
  {
    source: "src/schemas.ts",
    query: "statsEnv=staging",
    text: "통계 서버에 연결하지 못했습니다.",
    apiRequests: 1,
  },
  {
    source: "src/lib/statsView.ts",
    query: "statsEnv=staging",
    text: "통계 서버에 연결하지 못했습니다.",
    apiRequests: 1,
  },
] as const) {
  test(`stats lazy import failure is contained for ${moduleFailure.source}`, async ({ page }) => {
    const entry = manifest[moduleFailure.source];
    expect(entry, `actual built dynamic entry for ${moduleFailure.source}`).toBeDefined();
    expect(entry?.isDynamicEntry).toBe(true);
    if (!entry) throw new Error(`Missing built dynamic entry: ${moduleFailure.source}`);
    const pathname = new URL(entry.file, `${ORIGIN}/`).pathname;
    let moduleRequests = 0;
    let apiRequests = 0;
    const unexpected = await installStatsRoutes(
      page,
      async (route) => {
        apiRequests += 1;
        await fulfillStats(route);
      },
      {
        pathname,
        record: () => {
          moduleRequests += 1;
        },
      },
    );
    await openStats(page, moduleFailure.query);
    const panel = page.locator("#globalStatsBox");
    await expect(panel.getByRole("alert")).toContainText(moduleFailure.text);
    await expect(panel.getByRole("button", { name: "다시 불러오기", exact: true })).toBeEnabled();
    expect(moduleRequests).toBe(1);
    expect(apiRequests).toBe(moduleFailure.apiRequests);
    await expectInputsRetained(page);
    expect(unexpected).toEqual([]);
  });
}
