import { expect, type Page } from "@playwright/test";
import { type PreviewServer, preview } from "vite";
import { test, waitForSignal, withCleanup } from "./test";

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

async function selectStoredLocale(page: Page, locale: "ko" | "en" | "ja") {
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
    key: LANGUAGE_STORAGE_KEY,
    value: locale,
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
}

async function visibleTextLayout(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((nodes) =>
    nodes
      .filter((node) => {
        const element = node as HTMLElement;
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && element.offsetParent;
      })
      .map((node) => {
        const element = node as HTMLElement;
        const range = document.createRange();
        range.selectNodeContents(element);
        const lineTops = [...range.getClientRects()]
          .filter((rect) => rect.width > 0 && rect.height > 0)
          .map((rect) => Math.round(rect.top * 2) / 2)
          .filter((top, index, values) => index === 0 || Math.abs(top - values[index - 1]) > 1);
        return {
          clientHeight: element.clientHeight,
          clientWidth: element.clientWidth,
          lineCount: lineTops.length,
          scrollHeight: element.scrollHeight,
          scrollWidth: element.scrollWidth,
          text: element.textContent?.trim() ?? "",
        };
      }),
  );
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
  const offsets = layouts.map(({ offset }) => offset);
  expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThanOrEqual(1);
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
  await withCleanup(async () => {
    await waitForSignal(fontRequest.promise, "the initial locale font request");
    await expect(page.getByRole("heading", { name: "コレクション強化計算機" })).toHaveCount(0);
    await expect(page.locator("html")).not.toHaveAttribute("data-locale-font-ready", "true");
  }, releaseFont.release);
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
  await withCleanup(async () => {
    await waitForSignal(fontRequest.promise, "the changed locale font request");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(
      page.getByRole("heading", { name: "Collection Item Upgrade Calculator" }),
    ).toBeVisible();
  }, releaseFont.release);
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
      const actionButtons = [...panel.querySelectorAll<HTMLElement>(".outcome-buttons button")];
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
        actionWidth: actionsRect.width,
        minButtonWidth: Math.min(...actionButtons.map(({ offsetWidth }) => offsetWidth)),
        contentOverflow: Math.max(0, titleRect.right, promptRect.right) - panelRect.right,
        dataLayout: panel.getAttribute("data-layout"),
        horizontalOverlap: stacked
          ? 0
          : Math.max(0, Math.max(titleRect.right, promptRect.right) - actionsRect.left),
        panelWidth: Math.round(panelRect.width),
        promptFits: prompt.scrollWidth <= prompt.clientWidth + 1,
        stacked,
        titleFits: title.scrollWidth <= title.clientWidth + 1,
      };
    });

    expect(layout.dataLayout).toBe("inline");
    expect(layout.stacked).toBe(layout.dataLayout === "stacked");
    expect(layout.horizontalOverlap).toBeLessThanOrEqual(1);
    expect(layout.actionWidth).toBeGreaterThanOrEqual(259);
    expect(layout.minButtonWidth).toBeGreaterThanOrEqual(120);
    expect(layout.contentOverflow).toBeLessThanOrEqual(1);
    expect(layout.promptFits).toBe(true);
    expect(layout.titleFits).toBe(true);
    await expectNoHorizontalOverflow(page);
  }
});

test("SR 14 outcome copy stays readable across every locale and responsive layout", async ({
  page,
}) => {
  await prepareLocale(page, ["en-US"], "en");
  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);

  for (const locale of ["ko", "ja", "en"] as const) {
    await selectStoredLocale(page, locale);
    await page.setViewportSize({ width: 981, height: 900 });
    await page.locator('[data-grade="R"]').click();
    await page.locator('[data-level="14"]').click();
    await page.locator("#blueStock").fill("100");
    await page.locator("#purpleStock").fill("20");
    await page.locator("#yellowStock").fill("20");
    await page.locator("#calculateButton").click();
    await expect(page.locator(".outcome-panel")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".outcome-panel")).toHaveAttribute(
      "data-layout",
      locale === "en" ? "stacked" : "inline",
    );

    const desktopCaptions = await visibleTextLayout(page, ".outcome-panel .outcome-choice-caption");
    expect(desktopCaptions).toHaveLength(2);
    for (const caption of desktopCaptions) {
      expect(caption.text.length).toBeGreaterThan(0);
      expect(caption.scrollHeight).toBeLessThanOrEqual(caption.clientHeight + 1);
      expect(caption.scrollWidth).toBeLessThanOrEqual(caption.clientWidth + 1);
      expect(caption.lineCount).toBe(1);
      expect(caption.clientHeight).toBeLessThanOrEqual(20);
    }

    await page.locator(".outcome-panel .fail-button").click();
    const pendingDesktop = await visibleTextLayout(page, ".outcome-panel .outcome-caption");
    expect(pendingDesktop).toHaveLength(1);
    expect(pendingDesktop[0]?.scrollHeight).toBeLessThanOrEqual(
      (pendingDesktop[0]?.clientHeight ?? 0) + 1,
    );
    expect(pendingDesktop[0]?.lineCount).toBe(1);
    expect(pendingDesktop[0]?.clientHeight).toBeLessThanOrEqual(20);
    await page.locator(".outcome-panel .outcome-buttons button").first().click();

    await page.setViewportSize({ width: 768, height: 900 });
    await page.locator(".outcome-panel .fail-button").click();
    const pendingTablet = await visibleTextLayout(page, ".outcome-panel .outcome-caption");
    expect(pendingTablet).toHaveLength(1);
    expect(pendingTablet[0]?.lineCount).toBeLessThanOrEqual(locale === "en" ? 2 : 1);
    expect(pendingTablet[0]?.clientHeight).toBeLessThanOrEqual(locale === "en" ? 40 : 20);
    await page.locator(".outcome-panel .outcome-buttons button").first().click();

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.locator("#mobile-tab-result").click();
      const toolbar = page.locator(".mobile-action-bar");
      const initialToolbarHeight = (await toolbar.boundingBox())?.height ?? 0;
      const initialButtonBoxes = await toolbar.locator("button").evaluateAll((buttons) =>
        buttons.map((button) => {
          const rect = button.getBoundingClientRect();
          return { height: rect.height, width: rect.width };
        }),
      );
      const mobileCaptions = await visibleTextLayout(
        page,
        ".mobile-action-bar .action-choice-caption",
      );
      expect(mobileCaptions).toHaveLength(2);
      for (const caption of mobileCaptions) {
        expect(caption.text.length).toBeGreaterThan(0);
        expect(caption.scrollHeight).toBeLessThanOrEqual(caption.clientHeight + 1);
        expect(caption.scrollWidth).toBeLessThanOrEqual(caption.clientWidth + 1);
        expect(caption.lineCount).toBe(1);
        expect(caption.clientHeight).toBeLessThanOrEqual(20);
      }

      if (locale !== "en") {
        const recommendation = await page
          .locator(".next-action .action-chip-large")
          .evaluate((chip) => {
            const name = chip.querySelector<HTMLElement>(".action-chip-name");
            const quantity = chip.querySelector<HTMLElement>(".action-chip-quantity");
            const full = chip.querySelector<HTMLElement>(".action-chip-name-full");
            const compact = chip.querySelector<HTMLElement>(".action-chip-name-mobile");
            const dot = chip.querySelector<HTMLElement>("i");
            const text = chip.querySelector<HTMLElement>(".action-chip-text");
            const parent = chip.parentElement;
            if (!name || !quantity || !full || !compact || !dot || !text || !parent) {
              throw new Error("Missing responsive recommendation label.");
            }
            const chipRect = chip.getBoundingClientRect();
            const dotRect = dot.getBoundingClientRect();
            const nameRect = name.getBoundingClientRect();
            const parentRect = parent.getBoundingClientRect();
            const quantityRect = quantity.getBoundingClientRect();
            const textRect = text.getBoundingClientRect();
            const lineHeight = Number.parseFloat(getComputedStyle(name).lineHeight);
            return {
              centerDelta: Math.abs(
                chipRect.left + chipRect.width / 2 - (parentRect.left + parentRect.width / 2),
              ),
              chipWidth: chipRect.width,
              compactDisplay: getComputedStyle(compact).display,
              dotTextGap: textRect.left - dotRect.right,
              fullDisplay: getComputedStyle(full).display,
              nameHeight: nameRect.height,
              nameQuantityTopDelta: Math.abs(nameRect.top - quantityRect.top),
              nameLineHeight: lineHeight,
              parentWidth: parentRect.width,
            };
          });
        expect(recommendation.fullDisplay).toBe("none");
        expect(recommendation.compactDisplay).not.toBe("none");
        expect(recommendation.centerDelta).toBeLessThanOrEqual(2);
        expect(recommendation.parentWidth - recommendation.chipWidth).toBeGreaterThanOrEqual(20);
        expect(recommendation.dotTextGap).toBeLessThanOrEqual(10);
        expect(recommendation.nameHeight).toBeLessThanOrEqual(recommendation.nameLineHeight + 1);
        expect(recommendation.nameQuantityTopDelta).toBeLessThanOrEqual(8);
      }

      await toolbar.locator(".fail-button").click();
      const pendingToolbarHeight = (await toolbar.boundingBox())?.height ?? 0;
      const pendingButtonBoxes = await toolbar.locator("button").evaluateAll((buttons) =>
        buttons.map((button) => {
          const rect = button.getBoundingClientRect();
          return { height: rect.height, width: rect.width };
        }),
      );
      expect(Math.abs(pendingToolbarHeight - initialToolbarHeight)).toBeLessThanOrEqual(1);
      expect(pendingButtonBoxes).toEqual(initialButtonBoxes);
      const pendingMobile = await visibleTextLayout(
        page,
        ".mobile-action-bar .action-choice-caption",
      );
      for (const caption of pendingMobile) {
        expect(caption.scrollHeight).toBeLessThanOrEqual(caption.clientHeight + 1);
        expect(caption.clientHeight).toBeLessThanOrEqual(20);
        if (caption.text.length > 0) expect(caption.lineCount).toBe(1);
      }
      await toolbar.locator("button").first().click();
      await expectNoHorizontalOverflow(page);
    }
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

  const actionNames = /^(Beginner|Intermediate|Elite)( Maintenance Kit| Kit)?$/;
  const cases = [
    { width: 1366, separator: true },
    { width: 660, separator: true },
    { width: 500, separator: true },
    { width: 390, separator: false },
    { width: 320, separator: false },
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
    for (const name of names) expect(name).toMatch(actionNames);
    await expect(visibleNames.first()).toBeVisible();

    const layout = await page.locator(".table-wrap").evaluate((wrap) => ({
      clientWidth: wrap.clientWidth,
      countStarts: [...wrap.querySelectorAll(".action-chip-count")].map((node) =>
        Math.round(node.getBoundingClientRect().left),
      ),
      longestNameRight: Math.max(
        ...[...wrap.querySelectorAll<HTMLElement>(".action-chip-name")]
          .filter((node) => getComputedStyle(node).display !== "none")
          .map((node) => node.getBoundingClientRect().right),
      ),
      scrollWidth: wrap.scrollWidth,
      separatorStarts: [...wrap.querySelectorAll<HTMLElement>(".action-chip-separator")]
        .filter((node) => getComputedStyle(node).display !== "none")
        .map((node) => node.getBoundingClientRect().left),
      separatorDisplays: [...wrap.querySelectorAll(".action-chip-separator")].map(
        (node) => getComputedStyle(node).display,
      ),
    }));
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
    expect(
      Math.max(...layout.countStarts) - Math.min(...layout.countStarts),
      `${scenario.width}px: ${JSON.stringify(layout)}`,
    ).toBeLessThanOrEqual(3);
    expect(
      layout.separatorDisplays.every((display) => (display === "none") !== scenario.separator),
    ).toBe(true);
    if (scenario.separator) {
      expect(
        Math.abs((layout.separatorStarts[0] ?? 0) - layout.longestNameRight),
      ).toBeLessThanOrEqual(1);
    } else {
      expect((layout.countStarts[0] ?? 0) - layout.longestNameRight).toBeLessThanOrEqual(8);
    }
    await expectNoHorizontalOverflow(page);
  }

  await page.setViewportSize({ width: 1366, height: 900 });
  await actionCountLayout(page);

  await page.getByRole("button", { name: "Select language" }).click();
  await page.getByRole("option", { name: "日本語" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.locator(".table-wrap .action-chip-name:visible").first()).toContainText(
    "キット",
  );
  await actionCountLayout(page);

  await page.getByRole("button", { name: "言語を選択" }).click();
  await page.getByRole("option", { name: "한국어" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  await expect(page.locator(".table-wrap .action-chip-name:visible").first()).toContainText("키트");
  await actionCountLayout(page);

  const localeWidths: Partial<
    Record<"ko" | "ja" | "en", Record<"mobile" | "tablet" | "desktop", number[]>>
  > = {};
  const captureLocaleWidths = async (locale: "ko" | "ja" | "en") => {
    const result = {} as Record<"mobile" | "tablet" | "desktop", number[]>;
    for (const [name, width] of [
      ["mobile", 390],
      ["tablet", 768],
      ["desktop", 1366],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      if (width <= 660) await page.locator("#mobile-tab-result").click();
      result[name] = await page
        .locator(".table-wrap thead th")
        .evaluateAll((cells) =>
          cells.map((cell) => Math.round(cell.getBoundingClientRect().width * 10) / 10),
        );
      await actionCountLayout(page);
      await expectNoHorizontalOverflow(page);
    }
    localeWidths[locale] = result;
  };
  await captureLocaleWidths("ko");
  await page.getByRole("button", { name: "언어 선택" }).click();
  await page.getByRole("option", { name: "日本語" }).click();
  await captureLocaleWidths("ja");
  await page.getByRole("button", { name: "言語を選択" }).click();
  await page.getByRole("option", { name: "English" }).click();
  await captureLocaleWidths("en");
  for (const viewport of ["mobile", "tablet", "desktop"] as const) {
    expect(localeWidths.en?.[viewport][1]).toBeGreaterThan(localeWidths.ja?.[viewport][1] ?? 0);
    expect(localeWidths.ja?.[viewport][1]).toBeGreaterThan(localeWidths.ko?.[viewport][1] ?? 0);
    expect(localeWidths.ko?.[viewport][3]).toBeGreaterThan(localeWidths.ja?.[viewport][3] ?? 0);
    expect(localeWidths.ja?.[viewport][3]).toBeGreaterThan(localeWidths.en?.[viewport][3] ?? 0);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#mobile-tab-result").click();
  await expect(page.locator(".table-wrap")).toHaveAttribute("data-action-label", "panel");
  await page.getByRole("button", { name: "Select language" }).click();
  await page.getByRole("option", { name: "日本語" }).click();
  await expect(page.locator(".table-wrap")).toHaveAttribute("data-action-label", "panel");
  await page.getByRole("button", { name: "言語を選択" }).click();
  await page.getByRole("option", { name: "한국어" }).click();
  await expect(page.locator(".table-wrap")).toHaveAttribute("data-action-label", "full");
  const candidatePadding = await page.locator(".table-wrap").evaluate((wrap) => {
    const header = wrap.querySelector<HTMLElement>("thead th:first-child");
    const body = wrap.querySelector<HTMLElement>("tbody td:first-child");
    if (!header || !body) throw new Error("Missing candidate column cells.");
    return {
      body: Number.parseFloat(getComputedStyle(body).paddingInlineStart),
      header: Number.parseFloat(getComputedStyle(header).paddingInlineStart),
      leftDelta: Math.abs(header.getBoundingClientRect().left - body.getBoundingClientRect().left),
    };
  });
  expect(candidatePadding.header).toBeGreaterThanOrEqual(8);
  expect(candidatePadding.body).toBe(candidatePadding.header);
  expect(candidatePadding.leftDelta).toBeLessThanOrEqual(1);
});

test("responsive density follows each locale's rendered content", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await prepareLocale(page, ["ko-KR"], "ko");
  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);

  const stockWidths: Record<"ko" | "ja" | "en", number> = { ko: 0, ja: 0, en: 0 };
  for (const locale of ["ko", "ja", "en"] as const) {
    await selectStoredLocale(page, locale);
    await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);
    await page.setViewportSize({ width: 768, height: 900 });
    const inputWidths = await page
      .locator(".input-column > section")
      .evaluateAll((sections) => sections.map((section) => section.getBoundingClientRect().width));
    expect(inputWidths).toHaveLength(2);
    stockWidths[locale] = inputWidths[1] ?? 0;

    await page.setViewportSize({ width: 661, height: 900 });
    const themeControls = await page.evaluate(() => {
      const menu = document.querySelector<HTMLElement>(".theme-menu-control");
      const segmented = document.querySelector<HTMLElement>(".theme-segment-control");
      if (!menu || !segmented) throw new Error("Missing theme controls.");
      return {
        menu: getComputedStyle(menu).display,
        segmented: getComputedStyle(segmented).display,
      };
    });
    if (locale === "ko") {
      expect(themeControls.segmented).not.toBe("none");
      expect(themeControls.menu).toBe("none");
    } else {
      expect(themeControls.segmented).toBe("none");
      expect(themeControls.menu).not.toBe("none");
    }

    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto(`http://127.0.0.1:${PORT}/?demoStats=1`);
    await clickVisibleTab(page, locale === "ko" ? "통계" : locale === "ja" ? "統計" : "Stats");
    await expect(page.locator(".stats-layout")).toBeVisible();
    const tabletColumns = await page.locator(".stats-layout").evaluate(
      (layout) =>
        getComputedStyle(layout)
          .gridTemplateColumns.split(" ")
          .filter((track) => Number.parseFloat(track) > 0).length,
    );
    expect(tabletColumns).toBe(locale === "en" ? 1 : 2);

    await page.setViewportSize({ width: 1280, height: 900 });
    const desktopColumns = await page.locator(".stats-layout").evaluate(
      (layout) =>
        getComputedStyle(layout)
          .gridTemplateColumns.split(" ")
          .filter((track) => Number.parseFloat(track) > 0).length,
    );
    expect(desktopColumns).toBe(2);
    await expectNoHorizontalOverflow(page);
  }

  expect(stockWidths.en).toBeGreaterThan(stockWidths.ja);
  expect(stockWidths.ja).toBeGreaterThan(stockWidths.ko);
});

test("candidate consumption uses available width before wrapping in narrow desktop columns", async ({
  page,
}) => {
  await page.setViewportSize({ width: 981, height: 1100 });
  await prepareLocale(page, ["ko-KR"], "ko");
  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);
  await page.locator('[data-grade="R"]').click();
  await page.locator('[data-level="8"]').click();
  await page.locator("#blueStock").fill("200");
  await page.locator("#purpleStock").fill("100");
  await page.locator("#yellowStock").fill("50");
  await page.locator("#calculateButton").click();
  await expect(page.locator(".table-wrap tbody tr").first()).toBeVisible({ timeout: 20_000 });

  for (const width of [981, 992, 1003]) {
    await page.setViewportSize({ width, height: 1100 });
    const breakdowns = await visibleTextLayout(
      page,
      ".table-wrap tbody td:nth-child(4) > span:nth-child(2)",
    );
    const naturalWidths = await page
      .locator(".table-wrap tbody td:nth-child(4) > span:nth-child(2)")
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const probe = document.createElement("span");
          const style = getComputedStyle(node);
          probe.textContent = node.textContent;
          Object.assign(probe.style, {
            font: style.font,
            letterSpacing: style.letterSpacing,
            position: "fixed",
            visibility: "hidden",
            whiteSpace: "nowrap",
          });
          document.body.append(probe);
          const width = probe.getBoundingClientRect().width;
          probe.remove();
          return width;
        }),
      );
    expect(breakdowns).toHaveLength(3);
    for (const [index, breakdown] of breakdowns.entries()) {
      expect(
        breakdown.lineCount,
        `${width}px: ${JSON.stringify({ breakdown, naturalWidth: naturalWidths[index] })}`,
      ).toBe(1);
      expect(breakdown.scrollWidth).toBeLessThanOrEqual(breakdown.clientWidth + 1);
    }
    const headers = await visibleTextLayout(page, ".table-wrap thead th");
    expect(headers).toHaveLength(4);
    for (const header of headers) expect(header.lineCount).toBe(1);

    const layout = await page.locator(".table-wrap").evaluate((wrap) => {
      const cells = Array.from(wrap.querySelectorAll<HTMLElement>("tbody tr:first-child td"));
      return {
        horizontalPadding: cells.map((cell) => {
          const style = getComputedStyle(cell);
          return {
            end: Number.parseFloat(style.paddingInlineEnd),
            start: Number.parseFloat(style.paddingInlineStart),
          };
        }),
        overflow: wrap.scrollWidth - wrap.clientWidth,
      };
    });
    expect(layout.overflow).toBeLessThanOrEqual(0);
    expect(layout.horizontalPadding).toEqual(
      Array.from({ length: 4 }, () => ({ end: 4, start: 4 })),
    );
  }
});

test("desktop control text uses the shared vertical centering contract", async ({ page }) => {
  await prepareLocale(page, ["ko-KR"]);
  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);
  await expect(page.locator('[data-theme-mode="system"]')).toBeAttached();
  const contracts = await page.evaluate(() => {
    const alignment = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing alignment target: ${selector}`);
      const label = element.querySelector<HTMLElement>("[data-align-role]");
      if (!label) throw new Error(`Missing aligned label: ${selector}`);
      const elementRect = element.getBoundingClientRect();
      const labelRect = label.getBoundingClientRect();
      return {
        centerDelta: Math.abs(
          labelRect.top + labelRect.height / 2 - (elementRect.top + elementRect.height / 2),
        ),
        role: label.dataset.alignRole,
      };
    };
    return {
      labels: [
        alignment('[data-theme-mode="system"]'),
        alignment('.view-tabs [role="tab"]'),
        alignment('[data-grade="R"]'),
        alignment('[data-level="0"]'),
        alignment(".current-state-strip .state-main"),
      ],
    };
  });
  for (const contract of contracts.labels) {
    expect(["segment", "status"]).toContain(contract.role);
    expect(contract.centerDelta).toBeLessThanOrEqual(1.1);
  }
});

test("mobile controls use shared roles without ad hoc positioning", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareLocale(page, ["ko-KR"]);
  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);

  const contracts = await page.evaluate(() => {
    const alignment = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing mobile alignment target: ${selector}`);
      const label = element.querySelector<HTMLElement>("[data-align-role]");
      if (!label) throw new Error(`Missing mobile aligned label: ${selector}`);
      const elementRect = element.getBoundingClientRect();
      const labelRect = label.getBoundingClientRect();
      return {
        centerDelta: Math.abs(
          labelRect.top + labelRect.height / 2 - (elementRect.top + elementRect.height / 2),
        ),
        role: label.dataset.alignRole,
      };
    };
    return {
      labels: [
        alignment('[data-grade="R"]'),
        alignment('[data-level="0"]'),
        alignment(".status-grade"),
        alignment(".status-level"),
        alignment("#mobile-tab-input"),
        alignment(".theme-menu-control > button"),
      ],
    };
  });

  for (const contract of contracts.labels) {
    expect(["segment", "status"]).toContain(contract.role);
    expect(contract.centerDelta).toBeLessThanOrEqual(1.1);
  }
});

test("numeric placeholders use explicit balanced line boxes in every locale", async ({ page }) => {
  await prepareLocale(page, ["ko-KR"], "ko");
  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);

  for (const locale of ["ko", "ja", "en"] as const) {
    await selectStoredLocale(page, locale);
    await page.setViewportSize({ width: 768, height: 900 });
    await expect(page.locator("#currentExp")).toHaveCSS("line-height", "20px");
    await expect(page.locator("#blueStock")).toHaveCSS("line-height", "20px");

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#currentExp")).toHaveCSS("line-height", "20px");
    await expect(page.locator("#blueStock")).toHaveCSS("line-height", "20px");

    for (const selector of ["#currentExp", "#blueStock"]) {
      const padding = await page.locator(selector).evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          end: Number.parseFloat(style.paddingBlockEnd),
          start: Number.parseFloat(style.paddingBlockStart),
        };
      });
      expect(Math.abs(padding.start - padding.end)).toBeLessThanOrEqual(0.01);
    }
  }
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
      const overallSectionOverflow = await page
        .locator(".stats-overall-section")
        .evaluate((section) => {
          const sectionBounds = section.getBoundingClientRect();
          return Array.from(section.querySelectorAll<HTMLElement>("*"))
            .filter((element) => {
              const bounds = element.getBoundingClientRect();
              return (
                bounds.left < sectionBounds.left - 1 ||
                bounds.right > sectionBounds.right + 1 ||
                element.scrollWidth > element.clientWidth + 1
              );
            })
            .map((element) => element.textContent?.trim().slice(0, 80));
        });
      expect(overallSectionOverflow).toEqual([]);
    }
  }
});
