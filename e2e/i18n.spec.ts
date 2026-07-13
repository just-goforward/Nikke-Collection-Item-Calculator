import { expect, type Page } from "@playwright/test";
import { type PreviewServer, preview } from "vite";
import { test } from "./test";

const PORT = 4277;
const LANGUAGE_STORAGE_KEY = "collection-kit-calculator.language";
let previewServer: PreviewServer | null = null;

function createGate() {
  let release = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function prepareLocale(page: Page, languages: string[], savedLocale?: "ko" | "en" | "ja") {
  await page.addInitScript(
    ({ languageStorageKey, navigatorLanguages, storedLocale }) => {
      const seedKey = `${languageStorageKey}.test-seeded`;
      if (!sessionStorage.getItem(seedKey)) {
        if (storedLocale) localStorage.setItem(languageStorageKey, storedLocale);
        else localStorage.removeItem(languageStorageKey);
        sessionStorage.setItem(seedKey, "1");
      }
      Object.defineProperty(navigator, "languages", {
        configurable: true,
        get: () => navigatorLanguages,
      });
      Object.defineProperty(navigator, "language", {
        configurable: true,
        get: () => navigatorLanguages[0] ?? "ko-KR",
      });
    },
    {
      languageStorageKey: LANGUAGE_STORAGE_KEY,
      navigatorLanguages: languages,
      storedLocale: savedLocale,
    },
  );
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    .toBe(true);
}

async function clickVisibleTab(page: Page, name: string) {
  const tabs = page.getByRole("tab", { name });
  for (let index = 0; index < (await tabs.count()); index += 1) {
    const tab = tabs.nth(index);
    if (!(await tab.isVisible())) continue;
    await tab.click();
    return;
  }
  throw new Error(`No visible tab named ${name}.`);
}

async function actionCountLayout(page: Page) {
  const layouts = await page.locator(".table-wrap .action-chip-text").evaluateAll((nodes) =>
    nodes.map((node) => {
      const count = node.querySelector<HTMLElement>(".action-chip-count");
      if (!count) throw new Error("Missing candidate action count.");
      const style = getComputedStyle(node);
      return {
        gridTemplateColumns: style.gridTemplateColumns,
        offset: Math.round(count.getBoundingClientRect().left - node.getBoundingClientRect().left),
        width: Math.round(node.getBoundingClientRect().width),
      };
    }),
  );
  expect(layouts.length).toBeGreaterThanOrEqual(3);
  expect(new Set(layouts.map(({ offset }) => offset)).size).toBe(1);
  return layouts[0];
}

test.beforeAll(async () => {
  previewServer = await preview({
    base: "./",
    configFile: false,
    preview: { host: "127.0.0.1", port: PORT, strictPort: true },
    root: process.cwd(),
  });
});

test.afterAll(async () => {
  if (!previewServer) return;
  await new Promise<void>((resolve, reject) => {
    previewServer?.httpServer.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  previewServer = null;
});

test("browser language selects Japanese and its font before app use", async ({ page }) => {
  await prepareLocale(page, ["ja-JP", "en-US"]);
  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);

  const html = page.locator("html");
  await expect(html).toHaveAttribute("lang", "ja");
  await expect(html).toHaveAttribute("data-locale", "ja");
  await expect(page).toHaveTitle("コレクション強化計算機");
  await expect(page.getByRole("heading", { name: "コレクション強化計算機" })).toBeVisible();
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    /お手入れキット/,
  );
  await expect(page.locator("#locale-font-stylesheet")).toHaveAttribute(
    "href",
    /pretendardvariable-jp-dynamic-subset\.min\.css$/,
  );
  await expect
    .poll(() => page.locator("body").evaluate((body) => getComputedStyle(body).fontFamily))
    .toContain("Pretendard JP Variable");
});

test("initial UI waits for its locale font stylesheet before the first render", async ({
  page,
}) => {
  await page.unroute("https://cdn.jsdelivr.net/**");
  const fontRequest = createGate();
  const releaseFont = createGate();
  await page.route("https://cdn.jsdelivr.net/**", async (route) => {
    if (route.request().url().includes("pretendardvariable-jp-dynamic-subset")) {
      fontRequest.release();
      await releaseFont.promise;
    }
    await route.fulfill({ body: "", contentType: "text/css", status: 200 });
  });
  await prepareLocale(page, ["ja-JP"]);
  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`, { waitUntil: "commit" });
  await fontRequest.promise;

  await expect(page.getByRole("heading", { name: "コレクション強化計算機" })).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveAttribute("data-locale-font-ready", "true");

  releaseFont.release();
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByRole("heading", { name: "コレクション強化計算機" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-locale-font-ready", "true");
});

test("language changes only after the next locale font is ready", async ({ page }) => {
  await prepareLocale(page, ["en-US"]);
  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);
  await page.unroute("https://cdn.jsdelivr.net/**");
  const fontRequest = createGate();
  const releaseFont = createGate();
  await page.route("https://cdn.jsdelivr.net/**", async (route) => {
    if (route.request().url().includes("pretendardvariable-jp-dynamic-subset")) {
      fontRequest.release();
      await releaseFont.promise;
    }
    await route.fulfill({ body: "", contentType: "text/css", status: 200 });
  });

  await page.getByRole("button", { name: "Select language" }).click();
  await page.getByRole("option", { name: "日本語" }).click();
  await fontRequest.promise;
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(
    page.getByRole("heading", { name: "Collection Item Upgrade Calculator" }),
  ).toBeVisible();

  releaseFont.release();
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.getByRole("heading", { name: "コレクション強化計算機" })).toBeVisible();
});

test("saved language overrides the browser language and persists after reload", async ({
  page,
}) => {
  await prepareLocale(page, ["ja-JP"], "en");
  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);

  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(
    page.getByRole("heading", { name: "Collection Item Upgrade Calculator" }),
  ).toBeVisible();
  await expect(page.locator("label:has(#blueStock) > span")).toContainText("Beginner Kit");
  await expect(page.locator("label:has(#purpleStock) > span")).toContainText("Intermediate Kit");
  await expect(page.locator("label:has(#yellowStock) > span")).toContainText("Elite Kit");
  await page.getByRole("button", { name: "Select language" }).click();
  await page.getByRole("option", { name: "日本語" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.locator("label:has(#blueStock) > span")).toContainText("初心者用キット");
  await expect(page.locator("label:has(#purpleStock) > span")).toContainText("中級者用キット");
  await expect(page.locator("label:has(#yellowStock) > span")).toContainText("上級者用キット");
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), LANGUAGE_STORAGE_KEY))
    .toBe("ja");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.getByRole("heading", { name: "コレクション強化計算機" })).toBeVisible();
});

test("an existing calculation result switches language without recalculation", async ({ page }) => {
  await prepareLocale(page, ["en-US"]);
  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);
  await page.locator('[data-grade="SR"]').click();
  await page.locator('[data-level="10"]').click();
  await page.locator("#yellowStock").fill("100");
  await page.locator("#calculateButton").click();
  await expect(page.getByText("Chance to reach SR 15").first()).toBeVisible({ timeout: 20_000 });
  const actionCount = Number(
    (await page.locator(".next-action .action-chip-count").first().textContent())?.match(
      /\d+/,
    )?.[0],
  );
  expect(actionCount).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Select language" }).click();
  await page.getByRole("option", { name: "日本語" }).click();

  await expect(page.getByText("SR15到達率").first()).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "候補" })).toBeVisible();
  await expect(page.locator(".next-action .action-chip-name").first()).toContainText(
    "上級者用お手入れキット",
  );
  await expect(page.locator(".next-action .action-chip-count").first()).toContainText(
    String(actionCount),
  );
});

test("Japanese outcome actions never overlap their copy in narrow desktop layouts", async ({
  page,
}) => {
  await page.setViewportSize({ width: 981, height: 900 });
  await prepareLocale(page, ["ja-JP"]);
  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);
  await page.locator('[data-grade="SR"]').click();
  await page.locator('[data-level="10"]').click();
  for (const inputId of ["blueStock", "purpleStock", "yellowStock"]) {
    await page.locator(`#${inputId}`).fill("100");
  }
  await page.locator("#calculateButton").click();
  await expect(page.locator(".outcome-panel")).toBeVisible({ timeout: 20_000 });

  for (const width of [768, 981, 1000, 1100, 1200]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.locator(".outcome-panel").evaluate((panel) => {
      const copy = panel.querySelector<HTMLElement>(".outcome-copy");
      const actions = panel.querySelector<HTMLElement>(".outcome-action-group");
      const title = panel.querySelector<HTMLElement>(".outcome-title-text");
      const prompt = panel.querySelector<HTMLElement>(".change-note");
      if (!copy || !actions || !title || !prompt) {
        throw new Error("Missing outcome layout target.");
      }
      const panelRect = panel.getBoundingClientRect();
      const copyRect = copy.getBoundingClientRect();
      const actionsRect = actions.getBoundingClientRect();
      const titleRect = title.getBoundingClientRect();
      const promptRect = prompt.getBoundingClientRect();
      const stacked = actionsRect.top >= copyRect.bottom - 1;
      return {
        contentOverflow: Math.max(0, titleRect.right, promptRect.right) - panelRect.right,
        horizontalOverlap: stacked
          ? 0
          : Math.max(0, Math.max(titleRect.right, promptRect.right) - actionsRect.left),
        panelWidth: Math.round(panelRect.width),
        promptFits: prompt.scrollWidth <= prompt.clientWidth + 1,
        stacked,
        titleFits: title.scrollWidth <= title.clientWidth + 1,
      };
    });

    expect(layout.stacked).toBe(layout.panelWidth <= 600);
    expect(layout.horizontalOverlap).toBeLessThanOrEqual(1);
    expect(layout.contentOverflow).toBeLessThanOrEqual(1);
    expect(layout.promptFits).toBe(true);
    expect(layout.titleFits).toBe(true);
    await expectNoHorizontalOverflow(page);
  }
});

test("candidate actions shorten without horizontal scrolling and align their counts", async ({
  page,
}) => {
  await prepareLocale(page, ["en-US"]);
  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);
  await page.locator('[data-grade="SR"]').click();
  await page.locator('[data-level="10"]').click();
  for (const inputId of ["blueStock", "purpleStock", "yellowStock"]) {
    await page.locator(`#${inputId}`).fill("100");
  }
  await page.locator("#calculateButton").click();
  await expect(page.getByText("Chance to reach SR 15").first()).toBeVisible({ timeout: 20_000 });

  const cases = [
    { width: 1366, names: /Maintenance Kit$/, separator: true },
    { width: 660, names: / Kit$/, separator: true },
    { width: 500, names: /^(Beginner|Intermediate|Elite)$/, separator: true },
    { width: 390, names: /^(Beginner|Intermediate|Elite)$/, separator: false },
    { width: 320, names: /^(Beginner|Intermediate|Elite)$/, separator: false },
  ];

  for (const scenario of cases) {
    await page.setViewportSize({ width: scenario.width, height: 900 });
    if (scenario.width <= 660) await clickVisibleTab(page, "Result");
    const visibleNames = page.locator(
      '.table-wrap .action-chip-name:visible:not([style*="display: none"])',
    );
    const names = await page
      .locator(".table-wrap .action-chip-name")
      .evaluateAll((nodes) =>
        nodes
          .filter((node) => getComputedStyle(node).display !== "none")
          .map((node) => node.textContent?.trim() ?? ""),
      );
    expect(names.length).toBeGreaterThanOrEqual(3);
    for (const name of names) expect(name).toMatch(scenario.names);
    await expect(visibleNames.first()).toBeVisible();

    const layout = await page.locator(".table-wrap").evaluate((wrap) => ({
      clientWidth: wrap.clientWidth,
      countStarts: [...wrap.querySelectorAll(".action-chip-count")].map((node) =>
        Math.round(node.getBoundingClientRect().left),
      ),
      scrollWidth: wrap.scrollWidth,
      separatorDisplays: [...wrap.querySelectorAll(".action-chip-separator")].map(
        (node) => getComputedStyle(node).display,
      ),
    }));
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
    expect(new Set(layout.countStarts).size).toBe(1);
    expect(
      layout.separatorDisplays.every((display) => (display === "none") !== scenario.separator),
    ).toBe(true);
    await expectNoHorizontalOverflow(page);
  }

  await page.setViewportSize({ width: 1366, height: 900 });
  const englishLayout = await actionCountLayout(page);

  await page.getByRole("button", { name: "Select language" }).click();
  await page.getByRole("option", { name: "日本語" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  const japaneseLayout = await actionCountLayout(page);

  await page.getByRole("button", { name: "言語を選択" }).click();
  await page.getByRole("option", { name: "한국어" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  const koreanLayout = await actionCountLayout(page);

  expect(englishLayout.offset).toBeGreaterThan(japaneseLayout.offset);
  expect(japaneseLayout.offset).toBeGreaterThan(koreanLayout.offset);
});

test("desktop control text uses explicit vertical centering contracts", async ({ page }) => {
  await prepareLocale(page, ["ko-KR"]);
  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);
  const contracts = await page.evaluate(() => {
    const styles = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing alignment target: ${selector}`);
      const style = getComputedStyle(element);
      return { alignItems: style.alignItems, display: style.display };
    };
    const opticalOffset = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing optical alignment target: ${selector}`);
      const style = getComputedStyle(element);
      return { position: style.position, top: style.top };
    };
    return {
      emptyGuide: styles(".empty-result li > span:last-child"),
      level: styles(".level-button"),
      opticalLabels: [
        opticalOffset('[data-theme-mode="system"] .topbar-optical-label'),
        opticalOffset('[role="tablist"] [role="tab"] .topbar-optical-label'),
        opticalOffset('[data-grade="R"] .state-grade-optical-label'),
      ],
      theme: styles('[data-theme-mode="system"]'),
      viewTab: styles('[role="tablist"] [role="tab"]'),
    };
  });
  for (const contract of [
    contracts.emptyGuide,
    contracts.level,
    contracts.theme,
    contracts.viewTab,
  ]) {
    expect(["flex", "grid", "inline-flex"]).toContain(contract.display);
    expect(contract.alignItems).toBe("center");
  }
  for (const opticalLabel of contracts.opticalLabels) {
    expect(opticalLabel).toEqual({ position: "relative", top: "1px" });
  }
});

test("mobile controls apply optical correction only to measured targets", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareLocale(page, ["ko-KR"]);
  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);

  const contracts = await page.evaluate(() => {
    const offset = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing mobile optical target: ${selector}`);
      const style = getComputedStyle(element);
      return { position: style.position, top: style.top };
    };
    return {
      grade: offset('[data-grade="R"] .state-grade-optical-label'),
      level: offset('[data-level="0"] .state-level-optical-label'),
      statusGrade: offset(".mobile-status-grade-optical-label"),
      tab: offset("#mobile-tab-input > span"),
      theme: offset(".mobile-theme-optical-label"),
    };
  });

  for (const target of [contracts.grade, contracts.level, contracts.statusGrade, contracts.theme]) {
    expect(target).toEqual({ position: "relative", top: "1px" });
  }
  expect(contracts.tab).toEqual({ position: "static", top: "auto" });
});

test("English and Japanese layouts do not overflow common phone, tablet, and desktop widths", async ({
  page,
}) => {
  await prepareLocale(page, ["en-US"]);
  for (const locale of ["en", "ja"] as const) {
    await page.goto(`http://127.0.0.1:${PORT}/?demoStats=1`);
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
      key: LANGUAGE_STORAGE_KEY,
      value: locale,
    });
    await page.reload();
    for (const width of [320, 390, 768, 1365]) {
      await page.setViewportSize({ width, height: 900 });
      await expectNoHorizontalOverflow(page);
      const statsLabel = locale === "en" ? "Stats" : "統計";
      await clickVisibleTab(page, statsLabel);
      await page
        .getByText(locale === "en" ? "Overall Super Success Rate" : "全体大成功率", {
          exact: true,
        })
        .waitFor({ state: "visible" });
      await expectNoHorizontalOverflow(page);
      const clippedSectionText = await page
        .locator(".stats-section-title > *")
        .evaluateAll((nodes) =>
          nodes
            .filter((node) => node.scrollWidth > node.clientWidth + 1)
            .map((node) => node.textContent),
        );
      expect(clippedSectionText).toEqual([]);
    }
  }
});
