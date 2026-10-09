import { writeFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect } from "@playwright/test";
import { type PreviewServer, preview } from "vite";
import { closePreviewServer, test } from "./test";

const PORT = 4175;
let previewServer: PreviewServer | null = null;

async function setTheme(page: import("@playwright/test").Page, theme: "light" | "dark") {
  const label = theme === "dark" ? "다크" : "라이트";
  const desktopButton = page.locator(`button[data-theme-mode="${theme}"]`).first();
  if (await desktopButton.isVisible()) {
    await desktopButton.click();
    return;
  }
  await page.getByRole("button", { name: /테마 선택/ }).click();
  await page
    .getByRole("menu", { name: "테마 선택" })
    .getByRole("menuitemradio", { name: label })
    .click();
}

test.beforeAll(async () => {
  previewServer = await preview({
    base: "./",
    configFile: false,
    preview: {
      host: "127.0.0.1",
      port: PORT,
      strictPort: true,
    },
    root: process.cwd(),
  });
});

test.afterAll(async () => {
  await closePreviewServer(previewServer);
  previewServer = null;
});

async function accessibilityViolations(
  page: import("@playwright/test").Page,
  allowedViolationIds: ReadonlySet<string> = new Set(),
) {
  const result = await accessibilityResults(page);
  return result.violations.filter((violation) => !allowedViolationIds.has(violation.id));
}

async function accessibilityResults(page: import("@playwright/test").Page) {
  return new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
}

async function waitForModalReadiness(page: import("@playwright/test").Page) {
  const deadline = performance.now() + 5_000;
  let stableSince = 0;
  let previousPosition = "";
  let lastState: unknown = null;

  while (performance.now() < deadline) {
    const state = await page.evaluate(() => {
      const overlay = document.querySelector(".attempt-modal-overlay");
      const panel = overlay?.querySelector(".attempt-modal");
      if (!(overlay instanceof HTMLElement) || !(panel instanceof HTMLElement)) return null;

      return [overlay, panel].map((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          opacity: style.opacity,
          transform: style.transform,
          animationCount: element.getAnimations().length,
          position: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      });
    });
    lastState = state;
    const now = performance.now();
    const ready = state?.every(
      (element) =>
        element.opacity === "1" && element.transform === "none" && element.animationCount === 0,
    );
    const position = ready ? JSON.stringify(state?.map((element) => element.position) ?? []) : "";
    if (!ready || position !== previousPosition) stableSince = now;
    previousPosition = position;
    if (ready && now - stableSince >= 100 && now < deadline) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(
    `Modal readiness timed out after 5000ms: expected opacity 1, transform none, no animations, ` +
      `and stable positions for 100ms. Last state: ${JSON.stringify(lastState)}`,
  );
}

type ModalCaptureInterval = { startedAtMs: number | null; endedAtMs: number | null };

async function recordModalDiagnostic(
  testInfo: import("@playwright/test").TestInfo,
  phase: string,
  action: () => Promise<void>,
) {
  try {
    await action();
    return true;
  } catch (error) {
    const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    testInfo.annotations.push({ type: "modal-evidence-error", description: `${phase}: ${cause}` });
    expect.soft(false, `${phase}: ${cause}`).toBe(true);
    return false;
  }
}

async function readModalDomEvidence(page: import("@playwright/test").Page) {
  return page
    .getByRole("dialog")
    .getByRole("button", { name: "취소", exact: true })
    .locator('[data-align-role="action"]')
    .evaluateAll((targets) => {
      const startedAtMs = Date.now();
      const startedAtPerformanceMs = performance.now();
      const target = targets[0];
      if (targets.length !== 1 || !(target instanceof HTMLElement)) {
        throw new Error(
          `Modal evidence requires exactly one cancel label; found ${targets.length}`,
        );
      }
      const parent = target.parentElement;
      if (!(parent instanceof HTMLButtonElement)) {
        throw new Error("Modal evidence requires the cancel label's parent button");
      }
      const rectValue = (rect: DOMRect) => ({
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        right: rect.right,
        bottom: rect.bottom,
      });
      const describe = (element: Element) => {
        const style = getComputedStyle(element);
        return {
          tag: element.localName,
          id: element.id,
          classes: element.getAttribute("class"),
          rect: rectValue(element.getBoundingClientRect()),
          clientRects: Array.from(element.getClientRects(), rectValue),
          style: {
            color: style.color,
            backgroundColor: style.backgroundColor,
            backgroundImage: style.backgroundImage,
            opacity: style.opacity,
            display: style.display,
            visibility: style.visibility,
            position: style.position,
            zIndex: style.zIndex,
            transform: style.transform,
            translate: style.getPropertyValue("translate"),
            overflowX: style.overflowX,
            overflowY: style.overflowY,
            clip: style.clip,
            clipPath: style.clipPath,
            pointerEvents: style.pointerEvents,
            filter: style.filter,
            mixBlendMode: style.mixBlendMode,
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            lineHeight: style.lineHeight,
          },
        };
      };
      const floorMembership = (rect: ReturnType<typeof rectValue>, x: number, y: number) =>
        Math.floor(x) < Math.floor(rect.left + rect.width) &&
        Math.floor(x) >= Math.floor(rect.left) &&
        Math.floor(y) < Math.floor(rect.top + rect.height) &&
        Math.floor(y) >= Math.floor(rect.top);
      const directTextRangeRects = Array.from(target.childNodes).flatMap((node, childIndex) => {
        if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) return [];
        const range = document.createRange();
        range.selectNodeContents(node);
        return Array.from(range.getClientRects()).map((rect, rectIndex) => {
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const nativeStack = document.elementsFromPoint(x, y);
          return {
            childIndex,
            rectIndex,
            rect: rectValue(rect),
            center: { x, y, floorX: Math.floor(x), floorY: Math.floor(y) },
            hasArea: rect.width > 0 && rect.height > 0,
            inViewport: x >= 0 && y >= 0 && x < innerWidth && y < innerHeight,
            nativeTopEqualsTarget: nativeStack[0] === target,
            nativeElementsFromPointStack: nativeStack.map((element) => {
              const snapshot = describe(element);
              return {
                ...snapshot,
                isTarget: element === target,
                axeGridClientRectContainsCenter: snapshot.clientRects.some((candidate) =>
                  floorMembership(candidate, x, y),
                ),
                clientRectMembership: snapshot.clientRects.map((candidate) =>
                  floorMembership(candidate, x, y),
                ),
              };
            }),
          };
        });
      });
      return {
        url: location.href,
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        scroll: { x: scrollX, y: scrollY },
        visibilityState: document.visibilityState,
        lang: document.documentElement.lang,
        bodyClasses: document.body.className,
        target: { ...describe(target), text: target.textContent },
        parentButton: describe(parent),
        directTextRangeRects,
        membershipFormula:
          "floor(x)<floor(left+width) && floor(x)>=floor(left) && " +
          "floor(y)<floor(top+height) && floor(y)>=floor(top); any candidate client rect",
        stackSemantics:
          "Native elementsFromPoint order, not axe 4.13 virtual/grid candidates or sorting. " +
          "Direct Text Range centers are unclipped; axe clipping/filtering/fallback is not replayed. " +
          "axe bgOverlap compares processed stack[0] !== target; " +
          "nativeTopEqualsTarget is not that result.",
        browserClock: {
          basis: "Browser Date.now wall milliseconds and performance.now/timeOrigin separately",
          startedAtMs,
          endedAtMs: Date.now(),
          startedAtPerformanceMs,
          endedAtPerformanceMs: performance.now(),
          performanceTimeOriginMs: performance.timeOrigin,
        },
      };
    });
}

async function saveModalDomEvidence(
  page: import("@playwright/test").Page,
  testInfo: import("@playwright/test").TestInfo,
  phase: "before" | "after",
  timing: {
    axe?: ModalCaptureInterval;
    afterPng?: ModalCaptureInterval & { saved: boolean };
  } = {},
) {
  const startedAtMs = Date.now();
  const dom = await readModalDomEvidence(page);
  const endedAtMs = Date.now();
  const evidence = {
    schemaVersion: 1,
    phase,
    identity: {
      testId: testInfo.testId,
      title: testInfo.title,
      file: testInfo.file,
      project: testInfo.project.name,
      retry: testInfo.retry,
      platform: process.platform,
      checkedCandidateSha: process.env["GITHUB_SHA"] ?? null,
      expectedManifest: process.env["CERTIFIED_EXPECTED_MANIFEST"] ?? null,
      runId: process.env["GITHUB_RUN_ID"] ?? null,
      runAttempt: process.env["GITHUB_RUN_ATTEMPT"] ?? null,
    },
    nodeClock: { basis: "Node Date.now wall milliseconds, not monotonic", startedAtMs, endedAtMs },
    axeNodeInterval: timing.axe ?? null,
    afterPng: timing.afterPng ?? null,
    observationOrder:
      phase === "after" ? "after PNG capture/write attempted before this DOM read" : "before axe",
    atomic: false,
    dom,
  };
  await writeFile(
    testInfo.outputPath(`modal-${phase}-axe.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
    {
      encoding: "utf8",
      flag: "wx",
    },
  );
}

async function calculateSr(
  page: import("@playwright/test").Page,
  level: number,
  stock: { blue?: string; purple?: string; yellow?: string },
) {
  await page
    .getByRole("group", { name: "소장품 등급" })
    .getByRole("button", { name: "SR" })
    .click();
  await page.getByRole("button", { name: `${level}단계`, exact: true }).click();
  if (stock.blue) await page.getByLabel("초심자용 키트").fill(stock.blue);
  if (stock.purple) await page.getByLabel("중급자용 키트").fill(stock.purple);
  if (stock.yellow) await page.getByLabel("상급자용 키트").fill(stock.yellow);
  const desktopCalculate = page.getByRole("button", { name: "계산", exact: true });
  if (await desktopCalculate.isVisible()) {
    await desktopCalculate.click();
  } else {
    await page
      .getByRole("toolbar", { name: "모바일 작업" })
      .getByRole("button", { name: "계산하기", exact: true })
      .click();
  }
  await expect(page.locator(".next-action")).toBeVisible({ timeout: 20_000 });
}

async function confirmGreatSuccess(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "대성공 O", exact: true }).first().click();
  await page.getByRole("button", { name: "대성공 O 확정", exact: true }).first().click();
}

test("데스크톱 라이트 화면에는 추적되지 않은 WCAG A/AA 위반이 없다", async ({ page }) => {
  await page.goto(`http://127.0.0.1:${PORT}/?demoStats=1`);
  await expect(page.locator(".app-shell")).toBeVisible();

  expect(await accessibilityViolations(page)).toEqual([]);
});

test("모바일 다크 화면에는 WCAG A/AA 위반이 없다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`http://127.0.0.1:${PORT}/?demoStats=1`);
  await setTheme(page, "dark");
  await expect(page.locator("body")).toHaveClass(/theme-dark/);

  expect(await accessibilityViolations(page)).toEqual([]);
});

test("English desktop UI has no untracked WCAG A/AA violations", async ({ page }) => {
  await page.goto(`http://127.0.0.1:${PORT}/en/?demoStats=1`);
  await expect(
    page.getByRole("heading", { name: "NIKKE Collection Item Upgrade Calculator" }),
  ).toBeVisible();

  expect(await accessibilityViolations(page)).toEqual([]);
});

test("Japanese mobile UI has no untracked WCAG A/AA violations", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`http://127.0.0.1:${PORT}/ja/?demoStats=1`);
  await expect(page.getByRole("heading", { name: "NIKKE コレクション強化計算機" })).toBeVisible();

  expect(await accessibilityViolations(page)).toEqual([]);
});

test("등급과 단계 버튼은 방향키로 선택과 포커스를 같이 이동한다", async ({ page }) => {
  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);

  const gradeGroup = page.getByRole("group", { name: "소장품 등급" });
  const rank = gradeGroup.getByRole("button", { name: "R", exact: true });
  const superRare = gradeGroup.getByRole("button", { name: "SR", exact: true });
  await rank.focus();
  await page.keyboard.press("ArrowRight");
  await expect(superRare).toBeFocused();
  await expect(superRare).toHaveAttribute("aria-pressed", "true");

  const levelGroup = page.getByRole("group", { name: "현재 단계" });
  const level0 = levelGroup.getByRole("button", { name: "0단계", exact: true });
  const level1 = levelGroup.getByRole("button", { name: "1단계", exact: true });
  await level0.focus();
  await page.keyboard.press("ArrowRight");
  await expect(level1).toBeFocused();
  await expect(level1).toHaveAttribute("aria-pressed", "true");
});

test("계산 결과와 키트 수정 상태에는 추적되지 않은 WCAG A/AA 위반이 없다", async ({ page }) => {
  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);
  await calculateSr(page, 10, { yellow: "100" });
  expect(await accessibilityViolations(page)).toEqual([]);

  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);
  await calculateSr(page, 5, { yellow: "100" });
  await confirmGreatSuccess(page);
  await expect(page.locator("#stockEditNotice")).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);
});

test("대성공 회차 모달은 배경을 차단하고 접근 가능한 설명과 포커스를 유지한다", async ({
  page,
}, testInfo) => {
  const hardPhases = {
    readiness: { type: "modal-hard-phase", description: "readiness: NOT_REACHED" },
    axe: { type: "modal-hard-phase", description: "axe: NOT_REACHED" },
    violations: { type: "modal-hard-phase", description: "violations: NOT_REACHED" },
    escape: { type: "modal-hard-phase", description: "escape: NOT_REACHED" },
    dialogClosed: { type: "modal-hard-phase", description: "dialog-closed: NOT_REACHED" },
    inertRemoved: { type: "modal-hard-phase", description: "inert-removed: NOT_REACHED" },
    focusRestored: { type: "modal-hard-phase", description: "focus-restored: NOT_REACHED" },
  };
  testInfo.annotations.push(...Object.values(hardPhases));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);
  await calculateSr(page, 14, { blue: "100", purple: "20", yellow: "20" });
  const outcomeButton = page.getByRole("button", { name: "대성공 O", exact: true }).first();
  await outcomeButton.click();
  await page.getByRole("button", { name: "대성공 O 확정", exact: true }).first().click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-describedby", "attemptModalDescription");
  await expect(page.locator(".app-shell")).toHaveAttribute("inert", "");
  await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
  await expect(dialog.getByRole("button").first()).toBeFocused();
  hardPhases.readiness.description = "readiness: REACHED";
  await waitForModalReadiness(page);
  await recordModalDiagnostic(testInfo, "before DOM capture/save", () =>
    saveModalDomEvidence(page, testInfo, "before"),
  );
  const axeStartedAtMs = Date.now();
  hardPhases.axe.description = "axe: REACHED";
  const result = await accessibilityResults(page);
  const axeEndedAtMs = Date.now();
  let resultPath = "";
  const rawSaved = await recordModalDiagnostic(testInfo, "raw axe JSON save", async () => {
    resultPath = testInfo.outputPath("modal-axe-results.json");
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  });
  if (rawSaved) {
    await recordModalDiagnostic(testInfo, "raw axe path attachment", async () => {
      await testInfo.attach("modal-axe-results", {
        path: resultPath,
        contentType: "application/json",
      });
    });
  }
  const afterPng: ModalCaptureInterval & { saved: boolean } = {
    startedAtMs: null,
    endedAtMs: null,
    saved: false,
  };
  afterPng.saved = await recordModalDiagnostic(testInfo, "after PNG capture/save", async () => {
    afterPng.startedAtMs = Date.now();
    const png = await page.screenshot({
      type: "png",
      fullPage: false,
      animations: "allow",
      caret: "initial",
      scale: "device",
    });
    afterPng.endedAtMs = Date.now();
    await writeFile(testInfo.outputPath("modal-after-axe.png"), png, { flag: "wx" });
  });
  await recordModalDiagnostic(testInfo, "after DOM capture/save", () =>
    saveModalDomEvidence(page, testInfo, "after", {
      axe: { startedAtMs: axeStartedAtMs, endedAtMs: axeEndedAtMs },
      afterPng,
    }),
  );
  if (result.incomplete.length > 0) {
    testInfo.annotations.push({
      type: "axe-incomplete",
      description:
        "Requires manual review; these results are neither passes nor violations: " +
        result.incomplete.map((rule) => rule.id).join(", "),
    });
  }
  hardPhases.violations.description = "violations: REACHED";
  expect(result.violations).toEqual([]);

  hardPhases.escape.description = "escape: REACHED";
  await page.keyboard.press("Escape");
  hardPhases.dialogClosed.description = "dialog-closed: REACHED";
  await expect(dialog).toHaveCount(0);
  hardPhases.inertRemoved.description = "inert-removed: REACHED";
  await expect(page.locator(".app-shell")).not.toHaveAttribute("inert", "");
  hardPhases.focusRestored.description = "focus-restored: REACHED";
  await expect
    .poll(() =>
      page.evaluate(() => {
        const active = document.activeElement;
        return (
          active instanceof HTMLElement && active.offsetParent !== null && active.matches("button")
        );
      }),
    )
    .toBe(true);
});

test("강제 색상과 200% 확대 상당 폭에서도 결과 화면이 재배치되고 접근 가능하다", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: "active" });
  await page.setViewportSize({ width: 640, height: 450 });
  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);
  await calculateSr(page, 10, { yellow: "100" });

  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);
  expect(await accessibilityViolations(page)).toEqual([]);
});
