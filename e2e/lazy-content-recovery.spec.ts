import { expect, type Page } from "@playwright/test";
import { type PreviewServer, preview } from "vite";
import { test as base, closePreviewServer, createGate, waitForSignal } from "./test";

const PORT = 4294;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const RECOVERY_KEY = "nikke:legacy-reload-input:v1";
let server: PreviewServer | null = null;

// These are shipped-dist UI tests. Network failures are injected only into the
// named lazy chunks; statistics are disabled and unexpected service calls fail.
const test = base.extend<{ localOnly: undefined }>({
  localOnly: [
    async ({ page }, use) => {
      const unexpected: string[] = [];
      await page.route(/^https?:\/\//, async (route) => {
        const url = new URL(route.request().url());
        if (url.hostname === "cdn.jsdelivr.net") {
          await route.fulfill({ body: "", contentType: "text/css", status: 200 });
        } else if (url.origin === ORIGIN && !url.pathname.startsWith("/api/")) {
          await route.fallback();
        } else {
          unexpected.push(route.request().url());
          await route.abort("blockedbyclient");
        }
      });
      await use(undefined);
      expect(unexpected, "lazy recovery fixtures must not query real services").toEqual([]);
    },
    { auto: true },
  ],
});

test.beforeAll(async () => {
  server = await preview({
    configFile: false,
    root: process.cwd(),
    preview: { host: "127.0.0.1", port: PORT, strictPort: true },
  });
});

test.afterAll(async () => {
  await closePreviewServer(server);
  server = null;
});

async function visit(page: Page) {
  await page.goto(`${ORIGIN}/?statsEnv=disabled`);
  await expect(page.getByRole("button", { name: "0단계", exact: true })).toBeVisible();
}

async function prepareModal(page: Page) {
  await visit(page);
  await page
    .getByRole("group", { name: "소장품 등급" })
    .getByRole("button", { name: "SR", exact: true })
    .click();
  await page.getByRole("button", { name: "14단계", exact: true }).click();
  await page.getByLabel("초심자용 키트").fill("100");
  await page.getByLabel("중급자용 키트").fill("20");
  await page.getByLabel("상급자용 키트").fill("20");
  await page.getByRole("button", { name: "계산", exact: true }).click();
  await expect(page.locator(".next-action")).toBeVisible();
}

async function openModal(page: Page) {
  await page.getByRole("button", { name: "대성공 O", exact: true }).first().click();
  await page.getByRole("button", { name: "대성공 O 확정", exact: true }).first().click();
}

async function expectReleasedFocus(page: Page) {
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".app-shell")).not.toHaveAttribute("inert", "");
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const active = document.activeElement;
        return (
          active instanceof HTMLElement &&
          active.offsetParent !== null &&
          active.matches("button:not([disabled])")
        );
      }),
    )
    .toBe(true);
}

function expectRetryUrls(requests: string[], generations: (string | null)[]) {
  expect(requests).toHaveLength(generations.length);
  expect(new Set(requests.map((url) => new URL(url).pathname)).size).toBe(1);
  expect(requests.map((url) => new URL(url).searchParams.get("retry"))).toEqual(generations);
}

test("recommendation loading is deferred and reset cancels a late completion", async ({ page }) => {
  let requests = 0;
  const paused = createGate();
  const started = createGate();
  await page.route("**/assets/RecommendationContent-*.js*", async (route) => {
    requests += 1;
    started.release();
    await paused.promise;
    await route.continue();
  });
  try {
    await visit(page);
    expect(requests).toBe(0);
    await page.getByLabel("초심자용 키트").fill("20");
    await page.getByRole("button", { name: "계산", exact: true }).click();
    await waitForSignal(started.promise, "recommendation lazy chunk");
    await expect(page.locator(".result-panel").getByRole("status")).toHaveText(
      "추천 화면 준비 중.",
    );
    await expect(page.getByLabel("초심자용 키트")).toHaveValue("20");
    await page.getByRole("button", { name: "초기화", exact: true }).click();
    await expect(page.locator(".empty-result")).toBeVisible();
    const response = page.waitForResponse(/\/assets\/RecommendationContent-.*\.js$/);
    paused.release();
    await response;
    await expect(page.locator(".next-action")).toHaveCount(0);
    await expect(page.locator(".empty-result")).toBeVisible();
    await expect(page.getByLabel("초심자용 키트")).toHaveValue("");
    expect(requests).toBe(1);
  } finally {
    paused.release();
  }
});

test("recommendation failure keeps inputs and retries the same chunk only on request", async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route("**/assets/RecommendationContent-*.js*", async (route) => {
    requests.push(route.request().url());
    if (requests.length === 1) await route.abort("failed");
    else await route.continue();
  });
  await visit(page);
  expect(requests).toEqual([]);
  await page.getByLabel("초심자용 키트").fill("20");
  await page.getByRole("button", { name: "계산", exact: true }).click();
  const alert = page.locator(".result-panel").getByRole("alert");
  await expect(alert).toHaveText(/이 영역에 필요한 파일을 불러오지 못했습니다/);
  await expect(page.getByLabel("초심자용 키트")).toHaveValue("20");
  await expect(page.locator(".current-state-strip")).toContainText("R");
  expectRetryUrls(requests, [null]);
  await alert.getByRole("button", { name: "다시 불러오기", exact: true }).click();
  await expect(page.locator(".next-action")).toBeVisible();
  await expect(alert).toHaveCount(0);
  await expect(page.getByLabel("초심자용 키트")).toHaveValue("20");
  expectRetryUrls(requests, [null, "1"]);
});

test("recommendation retries are bounded and explicit reload restores inputs without results", async ({
  page,
}) => {
  const requests: string[] = [];
  let documents = 0;
  let recoveryRequests = 0;
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.resourceType() === "document") documents += 1;
    if (/\/assets\/legacyInputRecovery-.*\.js/.test(request.url())) recoveryRequests += 1;
  });
  await page.route(
    /\/assets\/(?:RecommendationContent|SuccessAttemptModal|legacyInputRecovery)-[^/?]+\.js(?:\?.*)?$/,
    (route) => {
      if (documents > 1) return route.continue();
      if (route.request().url().includes("RecommendationContent-"))
        requests.push(route.request().url());
      return route.fulfill({
        status: 404,
        contentType: "text/javascript",
        body: "removed deployment chunk",
      });
    },
  );
  await visit(page);
  await page
    .getByRole("group", { name: "소장품 등급" })
    .getByRole("button", { name: "SR", exact: true })
    .click();
  await page.getByRole("button", { name: "10단계", exact: true }).click();
  await page.getByLabel("현재 경험치", { exact: true }).fill("1200");
  await page.getByLabel("초심자용 키트").fill("123");
  await page.getByLabel("중급자용 키트").fill("24");
  await page.getByLabel("상급자용 키트").fill("50");
  await page.getByRole("button", { name: "계산", exact: true }).click();
  const alert = page.locator(".result-panel").getByRole("alert");
  for (let retry = 0; retry < 2; retry += 1) {
    await alert.getByRole("button", { name: "다시 불러오기", exact: true }).click();
  }
  await expect(alert).toContainText("미확정 사용 전 입력은 복원하지 않습니다.");
  await expect(alert.getByRole("button", { name: "다시 불러오기", exact: true })).toHaveCount(0);
  expectRetryUrls(requests, [null, "1", "2"]);
  expect(recoveryRequests).toBe(0);
  const reloaded = page.waitForEvent("domcontentloaded");
  await alert.getByRole("button", { name: "페이지 다시 불러오기", exact: true }).click();
  await reloaded;
  await expect(page.getByLabel("초심자용 키트")).toHaveValue("123");
  await expect(page.getByLabel("중급자용 키트")).toHaveValue("24");
  await expect(page.getByLabel("상급자용 키트")).toHaveValue("50");
  await expect(page.getByLabel("현재 경험치", { exact: true })).toHaveValue("1200");
  await expect(
    page
      .getByRole("group", { name: "소장품 등급" })
      .getByRole("button", { name: "SR", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "10단계", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator(".empty-result")).toBeVisible();
  await expect(page.locator(".next-action")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate((key) => sessionStorage.getItem(key), RECOVERY_KEY))
    .toBeNull();
  expect(documents).toBe(2);
  expect(recoveryRequests).toBeGreaterThan(0);
});

test("pending modal cancellation releases focus and late completion cannot reopen it", async ({
  page,
}) => {
  let requests = 0;
  const paused = createGate();
  const started = createGate();
  await page.route("**/assets/SuccessAttemptModal-*.js*", async (route) => {
    requests += 1;
    started.release();
    await paused.promise;
    await route.continue();
  });
  try {
    await prepareModal(page);
    expect(requests).toBe(0);
    await openModal(page);
    await waitForSignal(started.promise, "on-demand modal chunk");
    const dialog = page.getByRole("dialog");
    const cancel = dialog.getByRole("button", { name: "취소", exact: true });
    await expect(dialog.getByRole("status")).toHaveText("남은 키트 선택 준비 중.");
    await expect(cancel).toBeFocused();
    await expect(page.locator(".app-shell")).toHaveAttribute("inert", "");
    await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
    await page.keyboard.press("Tab");
    await expect(cancel).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(cancel).toBeFocused();
    await page.keyboard.press("Escape");
    await expectReleasedFocus(page);
    const response = page.waitForResponse(/\/assets\/SuccessAttemptModal-.*\.js$/);
    paused.release();
    await response;
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".current-state-strip")).toContainText("15단계");
    await expect(page.getByLabel("초심자용 키트")).toHaveValue("100");
    expect(requests).toBe(1);
  } finally {
    paused.release();
  }
});

test("failed modal traps focus, explicit retry loads choices, and cancel restores focus", async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route("**/assets/SuccessAttemptModal-*.js*", async (route) => {
    requests.push(route.request().url());
    if (requests.length === 1) await route.abort("failed");
    else await route.continue();
  });
  await prepareModal(page);
  await openModal(page);
  const dialog = page.getByRole("dialog");
  const cancel = dialog.getByRole("button", { name: "취소", exact: true });
  const retry = dialog.getByRole("button", { name: "다시 불러오기", exact: true });
  await expect(dialog.getByRole("alert")).toHaveText(
    "이 영역에 필요한 파일을 불러오지 못했습니다.",
  );
  await expect(cancel).toBeFocused();
  await expect(page.locator(".app-shell")).toHaveAttribute("inert", "");
  expectRetryUrls(requests, [null]);
  await page.keyboard.press("Tab");
  await expect(retry).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(cancel).toBeFocused();
  await retry.click();
  await expect(dialog).toHaveAttribute("aria-describedby", "attemptModalDescription");
  await expect(dialog.getByRole("button").first()).toBeFocused();
  await expect(page.getByLabel("초심자용 키트")).toHaveValue("100");
  expectRetryUrls(requests, [null, "1"]);
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  await expectReleasedFocus(page);
  await expect(page.locator(".current-state-strip")).toContainText("15단계");
  await expect(page.getByLabel("초심자용 키트")).toHaveValue("100");
});

test("exhausted modal retries reload only a pending marker, never unconfirmed pre-use inputs", async ({
  page,
}) => {
  const requests: string[] = [];
  let documents = 0;
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.resourceType() === "document") documents += 1;
  });
  await page.route("**/assets/SuccessAttemptModal-*.js*", (route) => {
    requests.push(route.request().url());
    return route.fulfill({
      status: 404,
      contentType: "text/javascript",
      body: "removed deployment chunk",
    });
  });
  await prepareModal(page);
  await openModal(page);
  const dialog = page.getByRole("dialog");
  for (let retry = 0; retry < 2; retry += 1) {
    await dialog.getByRole("button", { name: "다시 불러오기", exact: true }).click();
  }
  await expect(dialog.getByRole("alert")).toHaveText("미확정 사용 전 입력은 복원하지 않습니다.");
  expectRetryUrls(requests, [null, "1", "2"]);
  expect(
    await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "").input, RECOVERY_KEY),
  ).toBe("pending");
  const reloaded = page.waitForEvent("domcontentloaded");
  await dialog.getByRole("button", { name: "페이지 다시 불러오기", exact: true }).click();
  await reloaded;
  await expect
    .poll(() => page.evaluate((key) => sessionStorage.getItem(key), RECOVERY_KEY))
    .toBeNull();
  for (const label of ["초심자용 키트", "중급자용 키트", "상급자용 키트"])
    await expect(page.getByLabel(label)).toHaveValue("");
  await expect(page.getByRole("button", { name: "0단계", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator(".empty-result")).toBeVisible();
  await expect(page.locator("#stockEditNotice")).toContainText("게임의 현재 등급·단계·재고");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".app-shell")).not.toHaveAttribute("inert", "");
  expect(documents).toBe(2);
  expectRetryUrls(requests, [null, "1", "2"]);
});

test("module evaluation failure with unavailable storage refuses reload and remains cancellable", async ({
  page,
}) => {
  let documents = 0;
  let requests = 0;
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.resourceType() === "document") documents += 1;
  });
  await page.addInitScript((key) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new Error("R65 storage unavailable fixture");
      original.call(this, name, value);
    };
  }, RECOVERY_KEY);
  // This is an explicit module-evaluation failure fixture, not a claim about a
  // browser's native network-error text. A no-URL failure must not be rebound.
  await page.route("**/assets/SuccessAttemptModal-*.js*", (route) => {
    requests += 1;
    return route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: 'throw new TypeError("R65 module evaluation failure fixture");',
    });
  });
  await prepareModal(page);
  await openModal(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "다시 불러오기", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "페이지 다시 불러오기", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("새로고침하지 않았습니다");
  await expect(page.getByLabel("초심자용 키트")).toHaveValue("100");
  await expect(page.locator(".app-shell")).toHaveAttribute("inert", "");
  expect(documents).toBe(1);
  expect(requests).toBe(1);
  await page.keyboard.press("Escape");
  await expectReleasedFocus(page);
  await expect(page.locator(".current-state-strip")).toContainText("15단계");
  await expect(page.getByLabel("초심자용 키트")).toHaveValue("100");
});
