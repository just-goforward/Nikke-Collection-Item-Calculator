import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { chromium } from "@playwright/test";
import { preview } from "vite";

import { SITE_LOCALE_ORDER, SITE_LOCALES } from "../shared/siteLocales.ts";

const PORT = 4286;
const outputDirectory = resolve(process.cwd(), "public", "og");
const builtOutputDirectory = resolve(process.cwd(), "dist", "og");

const previewServer = await preview({
  base: "/",
  configFile: false,
  preview: { host: "127.0.0.1", port: PORT, strictPort: true },
  root: process.cwd(),
});
const browser = await chromium.launch();

try {
  await mkdir(outputDirectory, { recursive: true });
  await mkdir(builtOutputDirectory, { recursive: true });
  const context = await browser.newContext({
    colorScheme: "light",
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    viewport: { height: 630, width: 1200 },
  });
  await context.addInitScript(() => {
    localStorage.setItem("collectionThemeMode", "light");
  });
  const page = await context.newPage();

  for (const locale of SITE_LOCALE_ORDER) {
    await page.goto(`http://127.0.0.1:${PORT}${SITE_LOCALES[locale].path}?statsEnv=disabled`, {
      waitUntil: "networkidle",
    });
    await page.locator("h1").waitFor({ state: "visible" });
    await page.waitForFunction(
      () => document.documentElement.dataset["localeFontReady"] === "true",
    );
    await page.evaluate(() => document.fonts.ready);
    const filename = `collection-calculator-${locale}.png`;
    const outputPath = resolve(outputDirectory, filename);
    await page.screenshot({
      animations: "disabled",
      path: outputPath,
    });
    await copyFile(outputPath, resolve(builtOutputDirectory, filename));
  }

  await context.close();
} finally {
  await browser.close();
  await new Promise<void>((resolveClose, reject) => {
    previewServer.httpServer.close((error) => {
      if (error) reject(error);
      else resolveClose();
    });
  });
}
