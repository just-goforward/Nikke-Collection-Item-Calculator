import { readdirSync, readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { type PreviewServer, preview } from "vite";
import { certifiedMessages } from "../src/certifiedUi/messages";
import { enMessages } from "../src/i18n/messages.en";
import { jaMessages } from "../src/i18n/messages.ja";
import { koMessages } from "../src/i18n/messages.ko";
import {
  expectApprovedReviewHealthAttempts,
  isReviewCollector,
  type ReviewHealthAttempt,
  type ReviewHealthMode,
  reviewHealthUrl,
  serveReviewHealth,
} from "./reviewHealth";
import { closePreviewServer } from "./test";

let server: PreviewServer | null = null;
let reviewHealthMode: ReviewHealthMode = "blocked";
const healthAttempts = new WeakMap<Page, ReviewHealthAttempt[]>();
const externalAttempts = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page, context }) => {
  reviewHealthMode = "blocked";
  const attempts: ReviewHealthAttempt[] = [];
  healthAttempts.set(page, attempts);
  const external: string[] = [];
  externalAttempts.set(page, external);
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !isReviewCollector(url))
      external.push(`${request.method()} ${url.origin}${url.pathname}`);
  });
  // Keep browser verification local; only the approved metadata GET is answered by a local mock.
  await context.route(
    (url) => !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
    (route) => route.abort("blockedbyclient"),
  );
  await serveReviewHealth(context, () => reviewHealthMode, attempts);
});
test.afterEach(async ({ page }, testInfo) => {
  const attempts = healthAttempts.get(page) ?? [];
  await testInfo.attach("review-health-attempts", {
    body: JSON.stringify(attempts),
    contentType: "application/json",
  });
  await testInfo.attach("blocked-external-attempts", {
    body: JSON.stringify(externalAttempts.get(page) ?? []),
    contentType: "application/json",
  });
  expectApprovedReviewHealthAttempts(attempts, "only the credential-free approved GET may run");
});
test.beforeAll(async () => {
  server = await preview({
    configFile: false,
    ...(process.env["SOLVER_A_VITE_CACHE_DIR"]
      ? { cacheDir: process.env["SOLVER_A_VITE_CACHE_DIR"] }
      : {}),
    root: process.cwd(),
    preview: {
      host: "127.0.0.1",
      port: Number(process.env["E2E_SMOKE_PORT"] ?? 4273),
      strictPort: true,
    },
  });
});
test.afterAll(async () => {
  await closePreviewServer(server);
  server = null;
});

function certifiedAssetPaths() {
  const boundary = JSON.parse(readFileSync("dist/.vite/certified-boundary.json", "utf8")) as {
    certifiedFiles: string[];
  };
  return new Set([
    ...boundary.certifiedFiles,
    "certified_solver.wasm",
    ...readdirSync("dist/assets")
      .filter((file) => /^browserWorker-.*\.js$/.test(file))
      .map((file) => `assets/${file}`),
  ]);
}

const SESSION_KEY = "collection-certified-staging-v1:session";
async function openStaging(page: Page) {
  await page.goto("/?statsEnv=staging&engine=certified");
  await expect(page.locator("main[data-engine-profile='certified-staging-v1']")).toBeVisible();
  await page.locator("header select").selectOption("en");
  await expect(
    page.getByRole("button", { name: "Calculate current stock and recommended day" }),
  ).toBeEnabled();
}
async function setAlmostComplete(page: Page, pieces = 19) {
  await page.getByLabel("R / SR", { exact: true }).selectOption("SR");
  await page.getByLabel("Level", { exact: true }).fill("14");
  await page.getByLabel("Experience", { exact: true }).fill("2900");
  await page.getByLabel("Pieces in stock Blue", { exact: true }).fill(String(pieces));
}
async function calculate(page: Page) {
  await page
    .getByRole("button", { name: "Calculate current stock and recommended day", exact: true })
    .click();
  await expect(page.locator(".cert-probability")).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole("button", { name: "Calculate current stock and recommended day", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
}

test("staging uses one profile and renders all three supported languages", async ({ page }) => {
  await openStaging(page);
  await expect(
    page.getByRole("heading", { name: "Past and future expected supply" }),
  ).toBeVisible();
  for (const locale of ["ko", "ja", "en"] as const) {
    await page.locator("header select").selectOption(locale);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(page.locator("h1")).not.toBeEmpty();
    await expect(page.locator("[data-forecast-review='unknown']")).toHaveText(
      certifiedMessages[locale].reviewUnknown,
    );
    await expect(
      page.getByText(certifiedMessages[locale].uncertain, { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".cert-supply table tbody tr")).toHaveCount(3);
    await expect(page.getByTestId("certified-waiting")).toContainText(
      certifiedMessages[locale].magnitudeUncomputed,
    );
  }
  await expect(
    page.getByText("Historical records are incomplete.", { exact: false }),
  ).toBeVisible();
  await expect(page.locator(".cert-supply table")).toContainText("N/A");
  expect(healthAttempts.get(page)?.map(({ mode }) => mode)).toEqual(["blocked"]);
});

for (const locale of ["en", "ja"] as const) {
  test(`direct ${locale} certified route uses its locale and the actual Worker`, async ({
    page,
  }) => {
    const words = certifiedMessages[locale];
    await page.goto(`/${locale}/?statsEnv=staging&engine=certified`);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(page.locator("main[data-engine-profile='certified-staging-v1']")).toBeVisible();
    await expect(page.getByRole("button", { name: words.calculate, exact: true })).toBeEnabled();
    await page.getByLabel("R / SR", { exact: true }).selectOption("SR");
    await page.getByLabel(words.level, { exact: true }).fill("14");
    await page.getByLabel(words.exp, { exact: true }).fill("2900");
    await page.getByLabel(`${words.stock} ${words.blue}`, { exact: true }).fill("19");
    await page.getByRole("button", { name: words.calculate, exact: true }).click();
    await expect(page.locator(".cert-probability")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("certified-current")).toContainText("100");
    await expect(page.getByTestId("certified-waiting")).toContainText(words.magnitudeUncomputed);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.locator("[data-forecast-review='unknown']")).toHaveText(words.reviewUnknown);
    await expect(page.getByText(words.uncertain, { exact: true })).toBeVisible();
  });
}

test("offline review notice preserves approved calculation and uncertain supply policy", async ({
  page,
}) => {
  reviewHealthMode = "failed";
  await openStaging(page);
  const notice = page.locator("[data-forecast-review='unknown']");
  await expect(notice).toHaveText(certifiedMessages.en.reviewUnknown);
  await expect(
    page.locator("[data-forecast-review='review_pending'], [data-forecast-review='current']"),
  ).toHaveCount(0);
  await expect(page.getByText(certifiedMessages.en.uncertain, { exact: true })).toBeVisible();
  await setAlmostComplete(page);
  await calculate(page);
  await expect(page.getByTestId("certified-current")).toContainText("100");
  await expect(page.getByTestId("certified-waiting")).toContainText(
    certifiedMessages.en.magnitudeUncomputed,
  );
  await expect(notice).toHaveText(certifiedMessages.en.reviewUnknown);
  await expect(page.getByText(certifiedMessages.en.uncertain, { exact: true })).toBeVisible();
  expect(healthAttempts.get(page)?.map(({ mode }) => mode)).toEqual(["failed"]);
  await page.reload();
  await page.locator("header select").selectOption("en");
  await expect(notice).toHaveText(certifiedMessages.en.reviewUnknown);
  await expect(page.getByText(certifiedMessages.en.uncertain, { exact: true })).toBeVisible();
  expect(healthAttempts.get(page)?.map(({ mode }) => mode)).toEqual(["failed", "failed"]);
});

test("approved review metadata shows pending, hides current, and keeps the approved calculation", async ({
  page,
}) => {
  const words = certifiedMessages.en;
  reviewHealthMode = "pending";
  await openStaging(page);
  await expect(page.locator("[data-forecast-review='review_pending']")).toHaveText(
    words.reviewPending,
  );
  await expect(page.locator("[data-forecast-review='unknown']")).toHaveCount(0);
  await expect(page.getByText(words.uncertain, { exact: true })).toBeVisible();
  await setAlmostComplete(page);
  await calculate(page);
  await expect(page.getByTestId("certified-current")).toContainText("100");
  await expect(page.getByTestId("certified-waiting")).toContainText(words.magnitudeUncomputed);
  reviewHealthMode = "current";
  const current = page.waitForResponse((response) => response.url() === reviewHealthUrl);
  await page.reload();
  await (await current).finished();
  await page.locator("header select").selectOption("en");
  await setAlmostComplete(page);
  await calculate(page);
  await expect(page.getByTestId("certified-current")).toContainText("100");
  await expect(page.getByTestId("certified-waiting")).toContainText(words.magnitudeUncomputed);
  await expect(page.locator("[data-forecast-review]")).toHaveCount(0);
  await expect(page.getByText(words.uncertain, { exact: true })).toBeVisible();
  expect(healthAttempts.get(page)?.map(({ mode }) => mode)).toEqual(["pending", "current"]);
});

test("real Worker computes, records one outcome, and preserves raw remainders after reload", async ({
  page,
}) => {
  await openStaging(page);
  await setAlmostComplete(page);
  await calculate(page);
  await expect(page.getByTestId("certified-current")).toContainText("100");
  await page.getByRole("button", { name: "Record normal result", exact: true }).click();
  await expect(page.getByLabel("Pieces in stock Blue", { exact: true })).toHaveValue("9");
  await expect(page.getByLabel("Level", { exact: true })).toHaveValue("15");
  await page.reload();
  await page.locator("header select").selectOption("en");
  await expect(page.getByLabel("Pieces in stock Blue", { exact: true })).toHaveValue("9");
  await calculate(page);
  await expect(page.getByTestId("certified-current")).toContainText("SR 15 is complete.");
  const unreceived = page.getByRole("button", {
    name: "Already included in entered stock",
    exact: true,
  });
  while (await unreceived.count()) {
    const count = await unreceived.count();
    await unreceived.first().click();
    await expect(unreceived).toHaveCount(count - 1);
  }
  await calculate(page);
  await expect(page.getByTestId("certified-waiting")).toContainText("Now");
});

test("a claim already included in stock records an identity without adding or inventing pieces", async ({
  page,
}) => {
  await openStaging(page);
  await page.getByLabel("Pieces in stock Blue", { exact: true }).fill("40");
  const first = page.locator(".cert-claim").first();
  await expect(first).toBeVisible();
  await first
    .getByRole("button", { name: "Already included in entered stock", exact: true })
    .click();
  await expect(page.getByLabel("Pieces in stock Blue", { exact: true })).toHaveValue("40");
  const ledger = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? "null"),
    SESSION_KEY,
  );
  expect(ledger.receipts).toHaveLength(1);
  expect(ledger.receipts[0]).toMatchObject({ pieces: null, alreadyInStock: true });
  expect(ledger.stock).toEqual([40, 0, 0]);
  await page.reload();
  const restored = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? "null"),
    SESSION_KEY,
  );
  expect(restored.receipts).toEqual(ledger.receipts);
});

test("R 15 requires conversion before recording another kit use", async ({ page }) => {
  await openStaging(page);
  await page.getByLabel("Level", { exact: true }).fill("15");
  await page.getByLabel("Pieces in stock Blue", { exact: true }).fill("29");
  await calculate(page);
  await expect(page.getByRole("button", { name: "Record normal result", exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: /^Convert R 15/ }).click();
  await expect(page.getByLabel("R / SR", { exact: true })).toHaveValue("SR");
  await expect(page.getByLabel("Level", { exact: true })).toHaveValue("5");
  await expect(page.getByLabel("Experience", { exact: true })).toHaveValue("0");
  await expect(page.getByLabel("Pieces in stock Blue", { exact: true })).toHaveValue("29");
  await calculate(page);
  await page.getByRole("button", { name: "Record normal result", exact: true }).click();
  await expect(page.getByLabel("Pieces in stock Blue", { exact: true })).toHaveValue("19");
  await expect(page.getByLabel("Experience", { exact: true })).toHaveValue("200");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("editing a running input supersedes its request and renders the newer current result", async ({
  page,
}) => {
  await openStaging(page);
  await page.getByLabel("Pieces in stock Blue", { exact: true }).fill("300");
  await page.getByLabel("Pieces in stock Purple", { exact: true }).fill("50");
  await page.getByLabel("Pieces in stock Yellow", { exact: true }).fill("20");
  await page
    .getByRole("button", { name: "Calculate current stock and recommended day", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "Calculating…", exact: true })).toBeVisible();
  await setAlmostComplete(page);
  await page.getByLabel("Pieces in stock Purple", { exact: true }).fill("0");
  await page.getByLabel("Pieces in stock Yellow", { exact: true }).fill("0");
  await calculate(page);
  await expect(page.getByTestId("certified-current")).toContainText("100");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

for (const path of [
  "/",
  "/en/",
  "/ja/",
  "/?statsEnv=production",
  "/?solverBackend=certified",
  "/?statsEnv=production&demoStats=1",
  "/?demoStats=1",
  "/?engine=certified",
  "/?statsEnv=staging",
  "/?statsEnv=staging&demoStats=1",
  "/?statsEnv=staging&engine=certified&demoStats=1",
  "/en/?statsEnv=staging&engine=certified&demoStats=1",
  "/ja/?statsEnv=staging&engine=certified&demoStats=1",
  "/?statsEnv=disabled&engine=certified",
  "/?statsEnv=production&engine=certified",
]) {
  test(`legacy route ${path} does not fetch the new engine`, async ({ page }) => {
    const forbidden = certifiedAssetPaths();
    const requests: string[] = [];
    const record = (request: { url(): string }) => requests.push(request.url());
    page.on("request", record);
    await page.goto(path);
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator("main[data-engine-profile]")).toHaveCount(0);
    await page.waitForLoadState("networkidle");
    page.off("request", record);
    expect(requests.filter((url) => forbidden.has(new URL(url).pathname.slice(1)))).toEqual([]);
    expect(healthAttempts.get(page)).toEqual([]);
  });
}

for (const [locale, path, words] of [
  ["ko", "/", koMessages],
  ["en", "/en/", enMessages],
  ["ja", "/ja/", jaMessages],
] as const) {
  test(`legacy ${locale} performs its actual production calculation with statistics disabled`, async ({
    page,
  }) => {
    const forbidden = certifiedAssetPaths();
    const requested: string[] = [];
    page.on("request", (request) => requested.push(request.url()));
    await page.goto(`${path}?statsEnv=disabled&engine=certified`);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await page
      .getByRole("group", { name: words["state.gradeAria"] })
      .getByRole("button", { name: "SR", exact: true })
      .click();
    await page
      .getByRole("button", { name: words["common.phase"].replace("{phase}", "14"), exact: true })
      .click();
    await page.getByLabel(words["state.currentExp"], { exact: true }).fill("2900");
    await page.getByLabel(words["state.currentExp"], { exact: true }).blur();
    await page.getByLabel(words["kit.bluePanel"]).fill("19");
    await page.getByRole("button", { name: words["common.calculate"], exact: true }).click();
    await expect(page.locator(".next-action .action-label").first()).toBeVisible();
    await expect(
      page.getByText(words["detail.sr15Probability"], { exact: true }).first(),
    ).toBeVisible();
    await expect(page.locator("main[data-engine-profile]")).toHaveCount(0);
    expect(requested.filter((url) => forbidden.has(new URL(url).pathname.slice(1)))).toEqual([]);
    expect(healthAttempts.get(page)).toEqual([]);
  });
}
