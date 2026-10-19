import { expect, test } from "@playwright/test";
import { enMessages } from "../src/i18n/messages.en";
import { jaMessages } from "../src/i18n/messages.ja";
import { koMessages } from "../src/i18n/messages.ko";

test.beforeEach(async ({ context }) => {
  // Absolutely no live stats, Turnstile, font or collector requests during verification.
  await context.route(
    (url) => !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
    (route) => route.abort("blockedbyclient"),
  );
  await context.addInitScript(() => {
    const violations: string[] = [];
    Object.assign(window, { stagingCspViolations: violations });
    document.addEventListener("securitypolicyviolation", (event) => {
      violations.push(`${event.violatedDirective}: ${event.blockedURI}`);
    });
  });
});

// The local gateway has FORECAST_RUNTIME_MODE=off, so no approved runtime publication exists:
// staging must show only the certified calculator, fail closed, and never use bundled supply.
for (const [path, messages] of [
  ["/", koMessages],
  ["/en/", enMessages],
  ["/ja/", jaMessages],
] as const) {
  for (const query of [
    "",
    "?statsEnv=disabled",
    "?statsEnv=production&demoStats=1&engine=legacy",
  ]) {
    test(`${path}${query} serves only the certified calculator and fails closed with emitted CSP`, async ({
      page,
    }) => {
      const errors: string[] = [];
      const wasm: string[] = [];
      const forecastChecks: number[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("response", (response) => {
        const url = new URL(response.url());
        if (url.pathname.endsWith(".wasm") && response.ok()) wasm.push(url.pathname);
        if (url.pathname === "/api/forecast/version") forecastChecks.push(response.status());
      });
      const response = await page.goto(`${path}${query}`);
      expect(await page.evaluate(() => Reflect.get(window, "COLLECTION_ACCOUNT_CONFIG"))).toEqual({
        enabled: true,
      });
      expect(response?.headers()["content-security-policy"]).toContain("'wasm-unsafe-eval'");
      expect(response?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(response?.headers()["x-robots-tag"]).toContain("noindex");
      await expect(page.locator("html")).toHaveAttribute(
        "lang",
        path === "/" ? "ko" : path.slice(1, 3),
      );
      if (!query) await expect(page).toHaveURL(/statsEnv=staging/);
      await expect(page.locator("main[data-engine-profile='certified-staging-v3']")).toBeVisible();
      const unavailable = page.getByTestId("certified-forecast-unavailable");
      await expect(unavailable).toBeVisible();
      await expect(unavailable).toHaveAttribute("role", "alert");
      await expect(page.locator("#calculateButton")).toBeDisabled();
      await page
        .getByRole("group", { name: messages["state.gradeAria"] })
        .getByRole("button", { name: "SR", exact: true })
        .click();
      await page.locator("#blueStock").fill("19");
      await expect(page.locator("#calculateButton")).toBeDisabled();
      const checks = forecastChecks.length;
      await unavailable.getByRole("button").click();
      await expect.poll(() => forecastChecks.length).toBeGreaterThan(checks);
      await expect(unavailable).toBeVisible();
      await expect(page.locator("#calculateButton")).toBeDisabled();
      expect(forecastChecks.every((status) => status === 503)).toBe(true);
      await expect(page.locator(".cert-probability, .next-action")).toHaveCount(0);
      expect(wasm).toEqual([]);
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => Reflect.get(window, "stagingCspViolations"))).toEqual([]);
    });
  }
}

test("local staging build metadata is not publicly served", async ({ request }) => {
  for (const path of [
    "/.vite/manifest.json",
    "/.vite/certified-boundary.json",
    "/.vite/worker-boundary/src_worker.ts.json",
    "/.vite/worker-boundary/src_certifiedRuntime_browserWorker.ts.json",
  ]) {
    expect((await request.get(path)).status(), path).toBe(404);
  }
});

test("local staging robots and API boundaries", async ({ request }) => {
  const robots = await request.get("/robots.txt");
  expect(await robots.text()).toBe("User-agent: *\nDisallow: /\n");
  const admin = await request.get("/api/admin/solver-diagnostics");
  expect(admin.status()).toBe(404);
  const personal = await request.get("/api/auth/session");
  expect(personal.status()).toBe(503);
  expect(personal.headers()["cache-control"]).toBe("no-store");
});
