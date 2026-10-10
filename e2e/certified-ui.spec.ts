import { readdirSync, readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
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
const APP_WORDS = { ko: koMessages, en: enMessages, ja: jaMessages } as const;
const LOCALE_LABELS = { ko: "한국어", en: "English", ja: "日本語" } as const;
const en = enMessages;
type Locale = keyof typeof APP_WORDS;
type KitName = "blue" | "purple" | "yellow";

/** The certified route uses the shared top bar language menu. */
async function selectLocale(page: Page, locale: Locale) {
  await page.locator("#language-menu-trigger").click();
  await page.getByRole("menuitemradio", { name: LOCALE_LABELS[locale], exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
}
async function openStaging(page: Page) {
  await page.goto("/?statsEnv=staging&engine=certified");
  await expect(page.locator("main[data-engine-profile='certified-staging-v1']")).toBeVisible();
  await selectLocale(page, "en");
  await expect(page.locator("#calculateButton")).toBeEnabled();
}
async function reopen(page: Page) {
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("main[data-engine-profile='certified-staging-v1']")).toBeVisible();
}
function stockInput(page: Page, kit: KitName) {
  return page.locator(`#${kit}Stock`);
}
function levelButton(page: Page, level: number, words: (typeof APP_WORDS)[Locale] = en) {
  return page.getByRole("button", {
    name: words["common.phase"].replace("{phase}", String(level)),
    exact: true,
  });
}
async function setCollectionState(
  page: Page,
  grade: "R" | "SR",
  level: number,
  exp: number,
  words: (typeof APP_WORDS)[Locale] = en,
) {
  await page
    .getByRole("group", { name: words["state.gradeAria"] })
    .getByRole("button", { name: grade, exact: true })
    .click();
  await levelButton(page, level, words).click();
  if (level === 15) return;
  await page.locator("#currentExp").fill(exp ? String(exp) : "");
  await page.locator("#currentExp").blur();
}
async function setStock(page: Page, stock: Partial<Record<KitName, number>>) {
  for (const [kit, pieces] of Object.entries(stock) as [KitName, number][])
    await stockInput(page, kit).fill(pieces ? String(pieces) : "");
}
async function expectCollectionState(page: Page, grade: "R" | "SR", level: number, exp: string) {
  await expect(
    page
      .getByRole("group", { name: en["state.gradeAria"] })
      .getByRole("button", { name: grade, exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(levelButton(page, level)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#currentExp")).toHaveValue(exp);
}
async function setAlmostComplete(page: Page, pieces = 19) {
  await setCollectionState(page, "SR", 14, 2900);
  await setStock(page, { blue: pieces });
}
async function accessibilityViolations(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return result.violations;
}
async function calculate(page: Page) {
  await page.locator("#calculateButton").click();
  await expect(page.locator(".cert-probability")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#calculateButton")).toHaveText(en["common.calculate"], {
    timeout: 15_000,
  });
}

test("certified route renders inside the shared calculator shell", async ({ page }) => {
  await openStaging(page);
  await expect(page.locator(".app-shell")).toHaveCount(1);
  await expect(page.locator("h1")).toHaveText(en["app.title"]);
  await expect(page.locator("#calculatorWorkspace")).toBeVisible();
  await expect(page.getByRole("tab", { name: en["top.calculator"] })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("group", { name: en["state.gradeAria"] })).toBeVisible();
  for (const kit of ["blue", "purple", "yellow"] as const)
    await expect(stockInput(page, kit)).toBeVisible();
  await expect(page.locator("#resetButton")).toBeVisible();
  await expect(page.getByTestId("certified-result")).toBeVisible();
  await expect(page.locator("footer.privacy-footer")).toBeVisible();
  await expect(page.locator("[data-forecast-review]")).toHaveCount(1);
  expect(await accessibilityViolations(page)).toEqual([]);
  await page.locator("button[data-theme-mode='dark']").first().click();
  await expect(page.locator("body")).toHaveClass(/theme-dark/);
  expect(await accessibilityViolations(page)).toEqual([]);
  await page.getByRole("tab", { name: en["top.stats"] }).click();
  await expect(page).toHaveURL(/statsEnv=staging&engine=certified#stats$/);
  await expect(page.locator("#statsWorkspace")).toBeVisible();
  await expect(page.locator("#calculatorWorkspace")).toBeHidden();
  await page.getByRole("tab", { name: en["top.calculator"] }).click();
  await expect(page.locator("#calculatorWorkspace")).toBeVisible();
  await expect(page.locator("main[data-engine-profile='certified-staging-v1']")).toBeVisible();
});

test("malformed saved data blocks calculation and offers explicit reset recovery", async ({
  page,
}) => {
  await openStaging(page);
  await page.evaluate((key) => localStorage.setItem(key, '{"kind":"broken"}'), SESSION_KEY);
  await reopen(page);
  await expect(page.locator("#calculateButton")).toBeDisabled();
  await expect(page.locator("#resetButton")).toBeDisabled();
  // Malformed storage is not a stock correction: no stock-edit prompt, only global recovery.
  await expect(page.locator("#stockEditNotice")).toBeHidden();
  await expect(page.getByTestId("certified-correction-pending")).toHaveCount(0);
  const recovery = page.getByRole("alert").getByRole("button", {
    name: en["common.reset"],
    exact: true,
  });
  await expect(recovery).toBeEnabled();
  await recovery.click();
  await expect(page.locator("#calculateButton")).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await reopen(page);
  await expect(page.locator("#calculateButton")).toBeEnabled();
  await setAlmostComplete(page);
  await calculate(page);
  await expect(page.getByTestId("certified-current")).toContainText("100");
});

test("mobile malformed-storage recovery stays global on the input tab", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openStaging(page);
  await page.evaluate((key) => localStorage.setItem(key, '{"kind":"broken"}'), SESSION_KEY);
  await reopen(page);
  const inputTab = page.getByRole("tab", { name: en["tab.input"], exact: true });
  await expect(inputTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#mobile-panel-input")).toBeVisible();
  await expect(page.locator("#stockEditNotice")).toBeHidden();
  await expect(inputTab.locator(".mobile-tab-dot")).toHaveCount(0);
  const bar = page.locator(".mobile-action-bar");
  await expect(bar).not.toHaveClass(/needs-stock-edit/);
  await expect(
    bar.getByRole("button", { name: en["common.stockEditRequired"], exact: true }),
  ).toHaveCount(0);
  const calculateLong = bar.getByRole("button", { name: en["common.calculateLong"], exact: true });
  await expect(calculateLong).toBeDisabled();
  const recovery = page.getByRole("alert").getByRole("button", {
    name: en["common.reset"],
    exact: true,
  });
  await expect(recovery).toBeVisible();
  await expect(recovery).toBeEnabled();
  await recovery.click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(calculateLong).toBeEnabled();
  await expect(inputTab).toHaveAttribute("aria-selected", "true");
});

test("staging uses one profile and renders all three supported languages", async ({ page }) => {
  await openStaging(page);
  await expect(
    page.getByRole("heading", { name: "Past and future expected supply" }),
  ).toBeVisible();
  for (const locale of ["ko", "ja", "en"] as const) {
    await selectLocale(page, locale);
    await expect(page.locator("h1")).toHaveText(APP_WORDS[locale]["app.title"]);
    await expect(page.locator("#calculateButton")).toHaveText(
      APP_WORDS[locale]["common.calculate"],
    );
    await expect(page.locator("[data-forecast-review]")).toHaveCount(1);
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
    const appWords = APP_WORDS[locale];
    await page.goto(`/${locale}/?statsEnv=staging&engine=certified`);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(page.locator("main[data-engine-profile='certified-staging-v1']")).toBeVisible();
    await expect(page.locator("h1")).toHaveText(appWords["app.title"]);
    const calculateButton = page.getByRole("button", {
      name: appWords["common.calculate"],
      exact: true,
    });
    await expect(calculateButton).toBeEnabled();
    await setCollectionState(page, "SR", 14, 2900, appWords);
    await setStock(page, { blue: 19 });
    await calculateButton.click();
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
  await reopen(page);
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
  await reopen(page);
  await (await current).finished();
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
  await expect(stockInput(page, "blue")).toHaveValue("9");
  await expect(levelButton(page, 15)).toHaveAttribute("aria-pressed", "true");
  await reopen(page);
  await expect(stockInput(page, "blue")).toHaveValue("9");
  await expect(levelButton(page, 15)).toHaveAttribute("aria-pressed", "true");
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
  await setStock(page, { blue: 40 });
  const first = page.locator(".cert-claim").first();
  await expect(first).toBeVisible();
  await first
    .getByRole("button", { name: "Already included in entered stock", exact: true })
    .click();
  await expect(stockInput(page, "blue")).toHaveValue("40");
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
  await setCollectionState(page, "R", 15, 0);
  await setStock(page, { blue: 29 });
  await calculate(page);
  await expect(page.getByRole("button", { name: "Record normal result", exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: /^Convert R 15/ }).click();
  await expectCollectionState(page, "SR", 5, "");
  await expect(stockInput(page, "blue")).toHaveValue("29");
  await calculate(page);
  const recommendation = page.locator(".cert-recommendation");
  await expect(recommendation).toHaveAttribute("data-kit", "blue");
  // A normal result records the whole recommended batch: 10 pieces and 200 EXP per blue use.
  const uses = Number(await recommendation.getAttribute("data-uses"));
  expect([1, 2]).toContain(uses);
  await page.getByRole("button", { name: "Record normal result", exact: true }).click();
  await expect(stockInput(page, "blue")).toHaveValue(String(29 - 10 * uses));
  await expect(page.locator("#currentExp")).toHaveValue(String(200 * uses));
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a running calculation locks inputs and actions, cancels distinctly, and recomputes the newer input", async ({
  page,
}) => {
  await openStaging(page);
  await setStock(page, { blue: 300, purple: 50, yellow: 20 });
  await page.locator("#calculateButton").click();
  await expect(page.locator("#calculateButton")).toHaveText(en["common.calculating"]);
  await expect(page.locator("#calculateButton")).toBeDisabled();
  await expect(stockInput(page, "blue")).toBeDisabled();
  await expect(levelButton(page, 14)).toBeDisabled();
  await expect(page.locator("#resetButton")).toBeDisabled();
  await expect(page.getByTestId("certified-result")).toHaveAttribute("aria-busy", "true");
  await page.getByRole("button", { name: certifiedMessages.en.cancel, exact: true }).click();
  await expect(page.getByTestId("certified-run-cancelled")).toHaveText(
    certifiedMessages.en.cancelled,
  );
  await expect(page.getByTestId("certified-run-notice")).toHaveCount(0);
  await expect(page.locator("#calculateButton")).toHaveText(en["common.calculate"]);
  await expect(stockInput(page, "blue")).toBeEnabled();
  await setAlmostComplete(page);
  await setStock(page, { purple: 0, yellow: 0 });
  await expect(page.getByTestId("certified-run-cancelled")).toHaveCount(0);
  await calculate(page);
  await expect(page.getByTestId("certified-current")).toContainText("100");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("reset clears the whole certified session and undo restores it", async ({ page }) => {
  await openStaging(page);
  await setAlmostComplete(page);
  await page.locator("#resetButton").click();
  await expectCollectionState(page, "R", 0, "");
  await expect(stockInput(page, "blue")).toHaveValue("");
  await expect(page.getByRole("status").filter({ hasText: en["reset.done"] })).toBeVisible();
  await page.getByRole("button", { name: en["reset.undoAction"], exact: true }).click();
  await expectCollectionState(page, "SR", 14, "2900");
  await expect(stockInput(page, "blue")).toHaveValue("19");
  await calculate(page);
  await expect(page.getByTestId("certified-current")).toContainText("100");
});

test("mobile certified route uses the shared input, result and stats navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openStaging(page);
  const inputTab = page.getByRole("tab", { name: en["tab.input"], exact: true });
  const resultTab = page.getByRole("tab", { name: en["tab.result"], exact: true });
  const statsTab = page.getByRole("tab", { name: en["tab.stats"], exact: true });
  await expect(inputTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#mobile-panel-input")).toBeVisible();
  await expect(page.locator("#mobile-panel-result")).toBeHidden();
  await setAlmostComplete(page);
  await page
    .locator(".mobile-action-bar")
    .getByRole("button", { name: en["common.calculateLong"], exact: true })
    .click();
  await expect(resultTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".cert-probability")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("certified-current")).toContainText("100");
  await expect(page.locator(".cert-inline-actions").first()).toBeHidden();
  expect(await accessibilityViolations(page)).toEqual([]);
  const record = page.getByRole("button", { name: "Record normal result", exact: true });
  await expect(record).toHaveCount(1);
  await expect(
    page.locator(".mobile-action-bar").getByRole("button", { name: "Record normal result" }),
  ).toBeVisible();
  await record.click();
  await inputTab.click();
  await expect(page.locator("#mobile-panel-input")).toBeVisible();
  await expect(stockInput(page, "blue")).toHaveValue("9");
  await statsTab.click();
  await expect(page).toHaveURL(/#stats$/);
  await expect(page.locator("#statsWorkspace")).toBeVisible();
  await expect(page.locator("#mobile-panel-input")).toBeHidden();
  await expect(page.locator("[data-forecast-review='unknown']")).toBeVisible();
  await resultTab.click();
  await expect(page.locator("#mobile-panel-result")).toBeVisible();
  await expect(page.getByTestId("certified-result")).toBeVisible();
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
