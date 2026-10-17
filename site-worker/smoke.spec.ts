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

for (const [path, messages] of [
  ["/", koMessages],
  ["/en/", enMessages],
  ["/ja/", jaMessages],
] as const) {
  for (const certified of [false, true]) {
    test(`${path} ${certified ? "certified" : "existing"} solver works with emitted CSP`, async ({
      page,
    }) => {
      const errors: string[] = [];
      const wasm: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("response", (response) => {
        if (response.url().endsWith(".wasm") && response.ok()) wasm.push(response.url());
      });
      const response = await page.goto(
        `${path}?${certified ? "engine=certified" : "statsEnv=disabled"}`,
      );
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
      if (certified) {
        await expect(page).toHaveURL(/statsEnv=staging/);
        await expect(
          page.locator("main[data-engine-profile='certified-staging-v3']"),
        ).toBeVisible();
      } else {
        await expect(page.locator("main[data-engine-profile='certified-staging-v3']")).toHaveCount(
          0,
        );
      }
      await page
        .getByRole("group", { name: messages["state.gradeAria"] })
        .getByRole("button", { name: "SR", exact: true })
        .click();
      await page
        .getByRole("button", {
          name: messages["common.phase"].replace("{phase}", "14"),
          exact: true,
        })
        .click();
      await page.locator("#currentExp").fill("2900");
      await page.locator("#currentExp").blur();
      await page.locator("#blueStock").fill("19");
      await page.locator("#calculateButton").click();
      await expect(
        page.locator(certified ? ".cert-probability" : ".next-action .action-label").first(),
      ).toBeVisible();
      if (certified) expect(wasm.some((url) => url.endsWith("/certified_solver.wasm"))).toBe(true);
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
