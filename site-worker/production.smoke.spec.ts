import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { enMessages } from "../src/i18n/messages.en";
import { jaMessages } from "../src/i18n/messages.ja";
import { koMessages } from "../src/i18n/messages.ko";

const STATS = "https://nikkecollection.com";

test.beforeEach(async ({ context }) => {
  // No live stats, fonts, Turnstile, accounts or collector traffic.
  await context.route(
    (url) => !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
    (route) => route.abort("blockedbyclient"),
  );
});

for (const [path, messages] of [
  ["/", koMessages],
  ["/en/", enMessages],
  ["/ja/", jaMessages],
] as const) {
  test(`${path} is indexable, canonical, accounts-off and uses the legacy solver`, async ({
    page,
  }) => {
    const accountRequests: string[] = [];
    const errors: string[] = [];
    page.on("request", (request) => {
      if (/\/(?:auth|v1|api\/auth|api\/personal)(?:\/|$)/.test(new URL(request.url()).pathname)) {
        accountRequests.push(request.url());
      }
    });
    page.on("pageerror", (error) => errors.push(error.message));
    const response = await page.goto(`${path}?statsEnv=disabled`);
    expect(response?.headers()["content-security-policy"]).toBeUndefined();
    expect(response?.headers()["x-robots-tag"]).toBeUndefined();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      "index,follow,max-image-preview:large",
    );
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      `https://nikkecollection.com${path}`,
    );
    expect(
      await page.evaluate(() => Reflect.get(window, "COLLECTION_ACCOUNT_CONFIG")),
    ).toBeUndefined();
    expect(
      await page.evaluate(() => Reflect.get(window, "COLLECTION_STATS_CONFIG")?.endpoint),
    ).toBe(STATS);
    await expect(page.locator("main[data-engine-profile='certified-staging-v2']")).toHaveCount(0);
    await page
      .getByRole("group", { name: messages["state.gradeAria"] })
      .getByRole("button", { name: "SR", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: messages["state.phaseOptionAria"].replace("{phase}", "14"),
        exact: true,
      })
      .click();
    await page.locator("#currentExp").fill("2900");
    await page.locator("#currentExp").blur();
    await page.locator("#blueStock").fill("19");
    await page.locator("#calculateButton").click();
    await expect(page.locator(".next-action .action-label").first()).toBeVisible();
    expect(accountRequests).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("the production client uses the production site stats gateway", async ({ page }) => {
  const requests: string[] = [];
  await page.route(`${STATS}/**`, async (route) => {
    requests.push(route.request().url());
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "fixture_unavailable" }),
    });
  });
  // Loopback intentionally defaults stats to disabled; select production explicitly.
  await page.goto("/en/?statsEnv=production");
  await page.getByRole("tab", { name: enMessages["tab.stats"], exact: true }).first().click();
  await expect
    .poll(() => requests.some((url) => new URL(url).pathname === "/api/stats"))
    .toBe(true);
  expect(requests.every((url) => new URL(url).origin === STATS)).toBe(true);
  expect(
    await page.evaluate(() => Reflect.get(window, "COLLECTION_ACCOUNT_CONFIG")),
  ).toBeUndefined();
});

test("production robots, sitemap, HTML aliases and static cache behavior", async ({ request }) => {
  const robots = await request.get("/robots.txt");
  expect(await robots.text()).toBe(await readFile("public/robots.txt", "utf8"));
  expect(robots.headers()["x-robots-tag"]).toBeUndefined();
  expect(robots.headers()["cache-control"]).toBe("public, max-age=0, must-revalidate");
  expect(await (await request.head("/robots.txt")).text()).toBe("");
  const sitemap = await request.get("/sitemap.xml");
  expect(await sitemap.text()).toContain("<loc>https://nikkecollection.com/en/</loc>");
  for (const path of ["/", "/index.html", "/en", "/en/", "/en/index.html", "/ja/"]) {
    const html = await request.get(path);
    expect(html.status()).toBe(200);
    expect(html.headers()["cache-control"]).toBe("public, max-age=0, must-revalidate");
    expect(html.headers()["content-security-policy"]).toBeUndefined();
    expect(html.headers()["x-robots-tag"]).toBeUndefined();
  }
  const headers = await readFile("dist/_headers", "utf8");
  const paths = headers.split("\n").filter((line) => line.startsWith("/"));
  expect(paths.length).toBeGreaterThan(0);
  for (const path of paths) {
    const asset = await request.get(path);
    expect(asset.status()).toBe(200);
    expect(asset.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(asset.headers()["etag"]).toBeTruthy();
    const cached = await request.get(path, {
      headers: { "If-None-Match": asset.headers()["etag"] ?? "" },
    });
    expect(cached.status()).toBe(304);
  }
  for (const path of ["/solver_rs.wasm", "/certified_solver.wasm", "/sitemap.xml"]) {
    const asset = await request.get(path);
    expect(asset.status()).toBe(200);
    expect(asset.headers()["cache-control"]).toBe("public, max-age=0, must-revalidate");
  }
  expect((await request.get("/unknown-production-page")).status()).toBe(404);
  expect((await request.get("/_headers")).status()).toBe(404);
});

test("production build metadata is not publicly served", async ({ request }) => {
  for (const path of [
    "/.vite/manifest.json",
    "/.vite/certified-boundary.json",
    "/.vite/worker-boundary/src_worker.ts.json",
    "/.vite/worker-boundary/src_certifiedRuntime_browserWorker.ts.json",
    "/.vite/site-production.json",
  ]) {
    expect((await request.get(path)).status(), path).toBe(404);
  }
});

test("unbound production gateway never falls back to HTML and keeps health unavailable", async ({
  request,
}) => {
  // /api/stats is bound to STATS in production; locally the service is absent, but the gateway
  // must still answer from the Worker (never the HTML shell) and never cache the failure.
  const stats = await request.get("/api/stats");
  expect(stats.status()).toBeGreaterThanOrEqual(500);
  expect(stats.headers()["content-type"] ?? "").not.toContain("text/html");
  expect(await stats.text()).not.toContain("<html");
  for (const [path, status, error] of [
    ["/api/auth/session", 503, "service_not_configured"],
    ["/v1/account", 503, "service_not_configured"],
    ["/auth/callback/google", 503, "service_not_configured"],
    ["/api/health", 404, "not_found"],
    ["/v1/health", 404, "not_found"],
    ["/api/unknown", 404, "not_found"],
    ["/account", 404, "not_found"],
  ] as const) {
    const response = await request.get(path);
    expect(response.status()).toBe(status);
    expect(await response.json()).toEqual({ error });
    expect(response.headers()["cache-control"]).toBe("no-store");
    expect(response.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  }
  const invalid = await request.post("/api/stats");
  expect(invalid.status()).toBe(405);
  expect(await invalid.json()).toEqual({ error: "method_not_allowed" });
});
