import { expect, type Page } from "@playwright/test";
import { type PreviewServer, preview } from "vite";
import { test } from "./test";

const PORT = 4281;
const LANGUAGE_STORAGE_KEY = "collection-kit-calculator.language";
let previewServer: PreviewServer | null = null;

const expectedCopy = {
  ko: {
    invalid: "음수와 소수는 입력할 수 없어 이전 값으로 되돌렸습니다.",
    max: "현재 등급에서 입력할 수 있는 최대값은 900이므로 입력값을 900으로 조정했습니다.",
    stockInvalid: "음수와 소수는 입력할 수 없어 이전 값으로 되돌렸습니다.",
    stockMax: "보유 키트는 최대 100,000개까지 입력할 수 있어 입력값을 100,000으로 조정했습니다.",
    step: "경험치는 100 단위로 입력해야 하므로 100으로 조정했습니다.",
    stepZero: "경험치는 100 단위로 입력해야 하므로 0으로 조정했습니다.",
  },
  ja: {
    invalid: "負の数と小数は入力できないため、以前の値に戻しました。",
    max: "現在の等級で入力できる上限は900のため、900に調整しました。",
    stockInvalid: "負の数と小数は入力できないため、以前の値に戻しました。",
    stockMax: "所持キットは最大100,000個までのため、100,000に調整しました。",
    step: "経験値は100単位で入力するため、100に調整しました。",
    stepZero: "経験値は100単位で入力するため、0に調整しました。",
  },
  en: {
    invalid: "Negative numbers and decimals are not allowed. The previous value was kept.",
    max: "The maximum for the current grade is 900, so the value was adjusted to 900.",
    stockInvalid: "Negative numbers and decimals are not allowed. The previous value was kept.",
    stockMax:
      "Maintenance Kit inventory is limited to 100,000, so the value was adjusted to 100,000.",
    step: "EXP must be entered in increments of 100, so the value was adjusted to 100.",
    stepZero: "EXP must be entered in increments of 100, so the value was adjusted to 0.",
  },
} as const;

async function selectLocale(page: Page, locale: keyof typeof expectedCopy) {
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
    key: LANGUAGE_STORAGE_KEY,
    value: locale,
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
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

test("current EXP keeps draft text until commit and explains every correction", async ({
  page,
}) => {
  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);
  await page.setViewportSize({ width: 390, height: 844 });

  for (const locale of ["ko", "ja", "en"] as const) {
    await selectLocale(page, locale);
    const expInput = page.locator("#currentExp");
    const tooltip = page.locator('#currentExp ~ [role="tooltip"]');

    await expInput.focus();
    await expect(tooltip).toBeHidden();
    await expInput.fill("123");
    await expect(expInput).toHaveValue("123");
    await expect(tooltip).toBeHidden();
    await expInput.blur();
    await expect(expInput).toHaveValue("100");
    await expect(tooltip).toHaveText(expectedCopy[locale].step);
    await expect(tooltip).toBeVisible();

    await expInput.fill("5");
    await expect(expInput).toHaveValue("5");
    await expInput.blur();
    await expect(expInput).toHaveValue("");
    await expect(expInput).toHaveAttribute("placeholder", "0");
    await expect(tooltip).toHaveText(expectedCopy[locale].stepZero);

    await expInput.fill("100");
    await expInput.blur();
    for (const invalidValue of ["-1", "1.5"]) {
      await expInput.fill(invalidValue);
      await expect(expInput).toHaveValue(invalidValue);
      await expect(expInput).toHaveAttribute("aria-invalid", "true");
      await expect(tooltip).toBeHidden();
      await expInput.blur();
      await expect(expInput).toHaveValue("100");
      await expect(tooltip).toHaveText(expectedCopy[locale].invalid);
      await expect(tooltip).toBeVisible();
    }

    await expInput.fill("9999");
    await expect(expInput).toHaveValue("9999");
    await expInput.blur();
    await expect(expInput).toHaveValue("900");
    await expect(tooltip).toHaveText(expectedCopy[locale].max);

    const bounds = await tooltip.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390);
  }
});

test("stock inputs preserve drafts and explain invalid or capped values on commit", async ({
  page,
}) => {
  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);
  await page.setViewportSize({ width: 390, height: 844 });

  for (const locale of ["ko", "ja", "en"] as const) {
    await selectLocale(page, locale);
    const stockInput = page.locator("#blueStock");
    const tooltip = page.locator("#blueStock ~ [role=tooltip]");

    await stockInput.fill("100000");
    await expect(stockInput).toHaveValue("100000");
    await stockInput.blur();
    await expect(stockInput).toHaveValue("100000");
    await expect(tooltip).toBeHidden();

    await stockInput.fill("100001");
    await expect(stockInput).toHaveValue("100001");
    await expect(stockInput).toHaveAttribute("aria-invalid", "true");
    await stockInput.blur();
    await expect(stockInput).toHaveValue("100000");
    await expect(tooltip).toHaveText(expectedCopy[locale].stockMax);
    await expect(tooltip).toBeVisible();

    await stockInput.fill("9".repeat(200));
    await stockInput.blur();
    await expect(stockInput).toHaveValue("100000");
    await expect(tooltip).toHaveText(expectedCopy[locale].stockMax);

    for (const invalidValue of ["-1", "1.5"]) {
      await stockInput.fill(invalidValue);
      await expect(stockInput).toHaveValue(invalidValue);
      await expect(stockInput).toHaveAttribute("aria-invalid", "true");
      await stockInput.blur();
      await expect(stockInput).toHaveValue("100000");
      await expect(tooltip).toHaveText(expectedCopy[locale].stockInvalid);
      await expect(tooltip).toBeVisible();
    }

    await stockInput.fill("0");
    await stockInput.blur();
    await expect(stockInput).toHaveValue("");
    await expect(stockInput).toHaveAttribute("placeholder", "0");
    await expect(tooltip).toBeHidden();

    await stockInput.fill("");
    await stockInput.blur();
    await expect(stockInput).toHaveValue("");
    await expect(tooltip).toBeHidden();
  }
});
