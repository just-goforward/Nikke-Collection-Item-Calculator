import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, type Locator, type TestInfo, test } from "@playwright/test";
import sharp from "sharp";
import {
  assertDistStable,
  inspectCertifiedDist,
} from "../scripts/certified-staging-dist-validation.ts";

const LOCALES = ["ko", "ja", "en"] as const;
const LOCALE_PATHS = { ko: "/", en: "/en/", ja: "/ja/" } as const;
const VIEWPORTS = [
  { height: 844, width: 390 },
  { height: 900, width: 768 },
  { height: 900, width: 1280 },
] as const;
const DIAGNOSTIC_MODE = process.env["ALIGNMENT_DIAGNOSTIC"] === "1";
const BREAKPOINT_SENTINELS = [660, 661, 980, 981, 1099, 1100] as const;
const ALIGNMENT_BASE_URL = "http://127.0.0.1:4377";
// Glyph extrema vary by half-pixels across OS rasterizers; box geometry keeps the stricter gate.
const MAX_TEXT_INK_CENTER_DELTA = 1.5;
const alignmentReports = new Map<string, unknown[]>();
let alignmentProvenance: Record<string, unknown>;
let alignmentDist: ReturnType<typeof inspectCertifiedDist>;

test.beforeAll(() => {
  if (process.env["CI"])
    assert.equal(DIAGNOSTIC_MODE, false, "CI alignment evidence cannot bypass optical assertions");
  const path = process.env["CERTIFIED_EXPECTED_MANIFEST"];
  assert.ok(path, "Freeze source/build identity before the alignment campaign");
  const bytes = readFileSync(path);
  const expected = JSON.parse(bytes.toString("utf8")) as {
    source: {
      commit: string;
      sha256: string;
      lockSha256: string;
      files: { path: string; sha256: string }[];
    };
    dist: { inventorySha256: string; manifestSha256: string };
  };
  const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  assert.equal(sha256("package-lock.json"), expected.source.lockSha256);
  const sources = ["e2e/alignment.spec.ts", "playwright.alignment.config.ts"].map((path) => {
    const hash = sha256(path);
    assert.equal(hash, expected.source.files.find((row) => row.path === path)?.sha256);
    return { path, sha256: hash };
  });
  alignmentDist = inspectCertifiedDist();
  assert.equal(alignmentDist.inventorySha256, expected.dist.inventorySha256);
  assert.equal(alignmentDist.manifest.sha256, expected.dist.manifestSha256);
  alignmentProvenance = {
    expectedManifestSha256: createHash("sha256").update(bytes).digest("hex"),
    commit: expected.source.commit,
    sourceSha256: expected.source.sha256,
    lockSha256: expected.source.lockSha256,
    distInventorySha256: expected.dist.inventorySha256,
    distManifestSha256: expected.dist.manifestSha256,
    sources,
  };
});

test.beforeEach(async ({ browserName: _runnerBrowserName }, testInfo) => {
  alignmentReports.set(testInfo.testId, []);
});

test.afterEach(async ({ browserName }, testInfo) => {
  const path = testInfo.outputPath("alignment-report.json");
  let invariantError: unknown;
  try {
    assert.ok(alignmentDist, "Alignment build identity was not initialized");
    assertDistStable(alignmentDist);
  } catch (error) {
    invariantError = error;
  }
  const errors = testInfo.errors.map((error) => ({ message: error.message, stack: error.stack }));
  if (invariantError)
    errors.push({
      message: invariantError instanceof Error ? invariantError.message : String(invariantError),
      stack: invariantError instanceof Error ? invariantError.stack : undefined,
    });
  // Write a real file before attachment, including partial measurements and failures.
  // Playwright's later output cleanup cannot be allowed before the workflow archives it.
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        version: "alignment-evidence-v1",
        generatedAt: new Date().toISOString(),
        test: testInfo.title,
        testId: testInfo.testId,
        project: testInfo.project.name,
        browser: browserName,
        platform: process.platform,
        node: process.version,
        deviceScaleFactor: testInfo.project.use.deviceScaleFactor,
        retry: testInfo.retry,
        status: invariantError ? "failed" : testInfo.status,
        observedTestStatus: testInfo.status,
        expectedStatus: testInfo.expectedStatus,
        diagnosticMode: DIAGNOSTIC_MODE,
        provenance: alignmentProvenance,
        errors,
        records: alignmentReports.get(testInfo.testId) ?? [],
        proofBoundary:
          "Rendered alignment only; each project retains its existing locale/viewport/DPR scope and Chromium-only CLS/breakpoint conditions.",
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
  await testInfo.attach("alignment-report.json", { path, contentType: "application/json" });
  if (invariantError) throw invariantError;
});

function createGate() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function waitForGate(promise: Promise<void>, label: string) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 10_000);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

type AlignmentRecord = {
  browser: string;
  centerDelta: number;
  deviceScaleFactor: number;
  inkDelta?: number;
  locale: (typeof LOCALES)[number];
  name: string;
  viewportWidth: number;
};

type AlignmentMeasurement = {
  centerDelta: number;
  lineHeight: number;
  role: string | undefined;
};

async function preparePage(
  page: import("@playwright/test").Page,
  locale: (typeof LOCALES)[number],
) {
  await page.goto(`${LOCALE_PATHS[locale]}?statsEnv=disabled`);
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
  await expect(page.locator("html")).toHaveAttribute("data-locale-font-ready", "true");
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({
    content: `
      [data-alignment-probe] {
        background: #fff !important;
        border-color: #fff !important;
        box-shadow: none !important;
        caret-color: transparent !important;
        color: #000 !important;
        filter: none !important;
        opacity: 1 !important;
        text-shadow: none !important;
      }
      [data-alignment-probe]::before,
      [data-alignment-probe]::after { display: none !important; }
      [data-alignment-probe] *,
      [data-alignment-probe]::placeholder {
        color: #000 !important;
        opacity: 1 !important;
        text-shadow: none !important;
      }
    `,
  });
}

async function alignmentMeasurement(container: Locator): Promise<AlignmentMeasurement> {
  return container.evaluate((element) => {
    const label = element.querySelector<HTMLElement>("[data-align-role]");
    if (!label) throw new Error("AlignedText label is missing");
    const containerRect = element.getBoundingClientRect();
    const labelRect = label.getBoundingClientRect();
    return {
      centerDelta: Math.abs(
        labelRect.top + labelRect.height / 2 - (containerRect.top + containerRect.height / 2),
      ),
      lineHeight: Number.parseFloat(getComputedStyle(label).lineHeight),
      role: label.dataset["alignRole"],
    };
  });
}

async function expectGeometricCenter(container: Locator) {
  const measurement = await alignmentMeasurement(container);
  expect(["action", "segment", "status"]).toContain(measurement.role);
  expect(measurement.lineHeight).toBeGreaterThan(0);
  expect(measurement.centerDelta).toBeLessThanOrEqual(1.1);
  return measurement;
}

async function inkCenterDelta(container: Locator) {
  await container.evaluate((element) => element.setAttribute("data-alignment-probe", ""));
  try {
    const screenshot = await container.screenshot({ animations: "disabled", caret: "hide" });
    const { data, info } = await sharp(screenshot)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let top = info.height;
    let bottom = -1;
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const index = (y * info.width + x) * info.channels;
        const red = data[index] ?? 255;
        const green = data[index + 1] ?? 255;
        const blue = data[index + 2] ?? 255;
        const alpha = data[index + 3] ?? 255;
        if (alpha > 128 && red < 96 && green < 96 && blue < 96) {
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
    }
    if (bottom < top) throw new Error("No glyph pixels found in alignment probe");
    const glyphCenter = (top + bottom) / 2;
    const boxCenter = (info.height - 1) / 2;
    const dpr = await container.evaluate(() => window.devicePixelRatio);
    return (glyphCenter - boxCenter) / dpr;
  } finally {
    await container.evaluate((element) => element.removeAttribute("data-alignment-probe"));
  }
}

async function expectNumericContract(input: Locator, context: string) {
  const measurement = await input.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      height: Number.parseFloat(style.height),
      lineHeight: Number.parseFloat(style.lineHeight),
      paddingEnd: Number.parseFloat(style.paddingBlockEnd),
      paddingStart: Number.parseFloat(style.paddingBlockStart),
    };
  });
  expect(measurement.height).toBeGreaterThan(measurement.lineHeight);
  expect(Math.abs(measurement.paddingStart - measurement.paddingEnd)).toBeLessThanOrEqual(0.01);
  const delta = await inkCenterDelta(input);
  if (DIAGNOSTIC_MODE) console.info(`[alignment] ${context}: ${delta}`);
  if (DIAGNOSTIC_MODE) return;
  expect(Math.abs(delta), `${context}: input ink center delta ${delta}`).toBeLessThanOrEqual(1.1);
}

function alignmentTargets(page: import("@playwright/test").Page, width: number) {
  if (width <= 660) {
    return [
      { name: "mobile theme", target: page.locator(".theme-menu-control > button") },
      { name: "mobile tab", target: page.locator("#mobile-tab-input") },
      { name: "mobile grade", target: page.locator('[data-grade="R"]') },
      { name: "mobile level", target: page.locator('[data-level="0"]') },
      { name: "mobile status grade", target: page.locator(".status-grade") },
      { name: "mobile status level", target: page.locator(".status-level") },
      { name: "mobile primary action", target: page.locator(".mobile-action-bar .primary-button") },
    ];
  }
  return [
    { name: "desktop theme", target: page.locator('[data-theme-mode="system"]') },
    { name: "desktop tab", target: page.locator('.view-tabs [role="tab"]').first() },
    { name: "desktop grade", target: page.locator('[data-grade="R"]') },
    { name: "desktop level", target: page.locator('[data-level="0"]') },
    { name: "desktop primary action", target: page.locator("#calculateButton") },
  ];
}

async function attachAlignmentReport(testInfo: TestInfo, records: AlignmentRecord[]) {
  alignmentReports.set(testInfo.testId, records);
}

test("all locales and viewports keep geometric and optical centers", async ({
  browserName,
  page,
}, testInfo) => {
  const records: AlignmentRecord[] = [];
  try {
    for (const locale of LOCALES) {
      await preparePage(page, locale);
      for (const viewport of VIEWPORTS) {
        await page.setViewportSize(viewport);
        const deviceScaleFactor = await page.evaluate(() => window.devicePixelRatio);
        if (deviceScaleFactor >= 3 && viewport.width !== 390) continue;

        for (const { name, target } of alignmentTargets(page, viewport.width)) {
          await expect(target).toBeVisible();
          const measurement = await expectGeometricCenter(target);
          const delta = await inkCenterDelta(target);
          records.push({
            browser: browserName,
            centerDelta: measurement.centerDelta,
            deviceScaleFactor,
            inkDelta: delta,
            locale,
            name,
            viewportWidth: viewport.width,
          });
          if (DIAGNOSTIC_MODE) {
            console.info(`[alignment] ${locale} ${viewport.width}px ${name}: ${delta}`);
            continue;
          }
          expect(
            Math.abs(delta),
            `${locale} ${viewport.width}px ${name}: ink center delta ${delta}`,
          ).toBeLessThanOrEqual(MAX_TEXT_INK_CENTER_DELTA);
        }

        await expectNumericContract(
          page.locator("#currentExp"),
          `${locale} ${viewport.width}px EXP`,
        );
        await expectNumericContract(
          page.locator("#blueStock"),
          `${locale} ${viewport.width}px stock`,
        );
      }
    }
  } finally {
    await attachAlignmentReport(testInfo, records);
  }
});

test("locale font upgrades preserve mobile geometry and CLS in every locale", async ({
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-dpr1", "CLS needs one Chromium campaign");
  test.setTimeout(120_000);
  const locales = [
    { code: "ko", title: "NIKKE 소장품 레벨업 계산기" },
    { code: "ja", title: "NIKKE コレクション強化計算機" },
    { code: "en", title: "NIKKE Collection Item Upgrade Calculator" },
  ] as const;
  const selectors = [
    ".theme-menu-control > button",
    "#mobile-tab-input",
    '[data-grade="R"]',
    '[data-level="0"]',
    ".mobile-action-bar .primary-button",
    "#currentExp",
    "#blueStock",
  ] as const;
  const records: Array<{
    cls: number;
    dimensions: Array<{
      afterHeight: number;
      afterWidth: number;
      beforeHeight: number;
      beforeWidth: number;
      selector: string;
    }>;
    locale: (typeof locales)[number]["code"];
  }> = [];
  alignmentReports.set(testInfo.testId, records);

  for (const locale of locales) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const fontRequest = createGate();
    const releaseFont = createGate();
    try {
      await page.addInitScript(() => {
        const state = { cls: 0, supported: false };
        (
          window as typeof window & {
            __fontLayoutShiftState?: typeof state;
          }
        ).__fontLayoutShiftState = state;
        if (!PerformanceObserver.supportedEntryTypes.includes("layout-shift")) return;
        state.supported = true;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const shift = entry as PerformanceEntry & { hadRecentInput: boolean; value: number };
            if (!shift.hadRecentInput) state.cls += shift.value;
          }
        }).observe({ buffered: true, type: "layout-shift" });
      });
      await page.route("**/*.woff2", async (route) => {
        fontRequest.release();
        await releaseFont.promise;
        await route.continue();
      });

      await page.goto(`${ALIGNMENT_BASE_URL}${LOCALE_PATHS[locale.code]}?statsEnv=disabled`, {
        waitUntil: "domcontentloaded",
      });
      await waitForGate(fontRequest.promise, `${locale.code} locale font request`);
      await expect(page.getByRole("heading", { name: locale.title })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-locale-font-ready", "false");

      const before = await page.locator("body").evaluate(
        (_body, targets) =>
          targets.map((selector) => {
            const element = document.querySelector<HTMLElement>(selector);
            if (!element) throw new Error(`Missing font transition target: ${selector}`);
            const rect = element.getBoundingClientRect();
            return { height: rect.height, selector, width: rect.width };
          }),
        selectors,
      );

      releaseFont.release();
      await expect(page.locator("html")).toHaveAttribute("data-locale-font-ready", "true");
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });

      const result = await page.locator("body").evaluate((_body, targets) => {
        const state = (
          window as typeof window & {
            __fontLayoutShiftState?: { cls: number; supported: boolean };
          }
        ).__fontLayoutShiftState;
        return {
          after: targets.map((selector) => {
            const element = document.querySelector<HTMLElement>(selector);
            if (!element) throw new Error(`Missing font transition target: ${selector}`);
            const rect = element.getBoundingClientRect();
            return { height: rect.height, selector, width: rect.width };
          }),
          cls: state?.cls ?? Number.NaN,
          supported: state?.supported ?? false,
        };
      }, selectors);

      expect(result.supported).toBe(true);
      expect(result.cls, `${locale.code} font transition CLS`).toBeLessThanOrEqual(0.01);
      const dimensions = before.map((entry, index) => {
        const after = result.after[index];
        if (!after) throw new Error(`Missing after geometry for ${entry.selector}`);
        expect(
          Math.abs(after.height - entry.height),
          `${locale.code} ${entry.selector} height`,
        ).toBeLessThanOrEqual(0.5);
        expect(
          Math.abs(after.width - entry.width),
          `${locale.code} ${entry.selector} width`,
        ).toBeLessThanOrEqual(0.5);
        return {
          afterHeight: after.height,
          afterWidth: after.width,
          beforeHeight: entry.height,
          beforeWidth: entry.width,
          selector: entry.selector,
        };
      });
      records.push({ cls: result.cls, dimensions, locale: locale.code });
    } finally {
      releaseFont.release();
      await context.close();
    }
  }
});

test("responsive breakpoint boundaries preserve the alignment contract", async ({
  browserName,
  page,
}, testInfo) => {
  test.skip(browserName !== "chromium", "Breakpoint geometry is engine-independent CSS logic");
  test.skip(
    test.info().project.name !== "chromium-dpr1",
    "DPR coverage belongs to the optical alignment matrix",
  );
  const records: Array<{ width: number; name: string; measurement: AlignmentMeasurement }> = [];
  alignmentReports.set(testInfo.testId, records);
  await preparePage(page, "ko");
  for (const width of BREAKPOINT_SENTINELS) {
    await page.setViewportSize({ height: 900, width });
    for (const { name, target } of alignmentTargets(page, width)) {
      await expect(target, `${width}px ${name}`).toBeVisible();
      const measurement = await expectGeometricCenter(target);
      records.push({ width, name, measurement });
    }
    await expectNumericContract(page.locator("#currentExp"), `${width}px breakpoint EXP`);
    await expectNumericContract(page.locator("#blueStock"), `${width}px breakpoint stock`);
  }
});

test("selected and unselected segmented controls keep identical geometry", async ({
  page,
}, testInfo) => {
  const records: Array<Record<string, unknown>> = [];
  alignmentReports.set(testInfo.testId, records);
  await page.setViewportSize({ height: 900, width: 1280 });
  await preparePage(page, "ko");
  const pairs = [
    [page.locator('[data-theme-mode="system"]'), page.locator('[data-theme-mode="light"]')],
    [
      page.locator('.view-tabs [role="tab"]').first(),
      page.locator('.view-tabs [role="tab"]').last(),
    ],
    [page.locator('[data-grade="R"]'), page.locator('[data-grade="SR"]')],
    [page.locator('[data-level="0"]'), page.locator('[data-level="1"]')],
  ] as const;

  for (const [index, [first, second]] of pairs.entries()) {
    const [firstBox, secondBox] = await Promise.all([first.boundingBox(), second.boundingBox()]);
    expect(firstBox).not.toBeNull();
    expect(secondBox).not.toBeNull();
    expect(Math.abs((firstBox?.height ?? 0) - (secondBox?.height ?? 0))).toBeLessThanOrEqual(0.5);
    const [firstAlignment, secondAlignment] = await Promise.all([
      alignmentMeasurement(first),
      alignmentMeasurement(second),
    ]);
    records.push({ pair: index, firstBox, secondBox, firstAlignment, secondAlignment });
    expect(Math.abs(firstAlignment.centerDelta - secondAlignment.centerDelta)).toBeLessThanOrEqual(
      0.5,
    );
  }
});
