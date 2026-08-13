import { expect, type Locator, type Page } from "@playwright/test";
import { type PreviewServer, preview } from "vite";
import {
  installTurnstileStub,
  maxBackgroundChannel,
  mockStagingStatsEndpoints,
  serveStagingDocument,
} from "./smoke.helpers";
import { test } from "./test";

const PORT = Number(process.env["E2E_SMOKE_PORT"] ?? 4273);
let previewServer: PreviewServer | null = null;
const MOBILE_OUTCOME_PROMPT = "추천 행동의 대성공 여부를 선택해주세요.";

/**
 * 회귀 안전망 스모크 테스트.
 *
 * 셀렉터 원칙: id / data-testid / 내부 변수명 사용 금지.
 * Vue에서 React로 전환해도 동일하게 통과해야 안전망 기능을 한다.
 * 사용자에게 보이는 텍스트, ARIA role, label만 사용한다.
 */

test.beforeAll(async () => {
  previewServer = await preview({
    configFile: false,
    root: process.cwd(),
    base: "./",
    preview: {
      host: "127.0.0.1",
      port: PORT,
      strictPort: true,
    },
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

test.beforeEach(async ({ page }) => {
  await page.goto("/?statsEnv=disabled");
  await expect(page.getByRole("button", { name: "0단계", exact: true })).toBeVisible();
});

async function openDetails(details: Locator) {
  if ((await details.count()) === 0) return;
  const summary = details.locator("summary").first();
  await expect(summary).toBeVisible();
  if (!(await details.evaluate((element: HTMLDetailsElement) => element.open))) {
    await summary.click({ position: { x: 10, y: 10 } });
    await expect
      .poll(() => details.evaluate((element: HTMLDetailsElement) => element.open))
      .toBe(true);
  }
}

async function confirmOutcome(page: Page, locator: Locator, outcome: "대성공 O" | "대성공 X") {
  await locator.click();
  await page
    .getByRole("button", { name: `${outcome} 확정`, exact: true })
    .first()
    .click();
}

async function openStatsPanel(page: Page) {
  const globalStatsBox = page.locator("#globalStatsBox");
  if (!(await globalStatsBox.isVisible().catch(() => false))) {
    const desktopStatsTab = page.getByRole("tab", { name: "통계" }).first();
    if ((await desktopStatsTab.count()) > 0 && (await desktopStatsTab.isVisible())) {
      await desktopStatsTab.click();
    }
  }

  const details = page.locator("#globalStatsPanel details");
  if ((await details.count()) === 0) {
    await expect(globalStatsBox).toBeVisible();
    return;
  }
  await expect(page.locator("#globalStatsPanel summary")).toBeVisible();
  await openDetails(details);
}

test("데스크톱 탭은 화살표와 Home·End로 선택과 포커스를 함께 이동한다", async ({ page }) => {
  await page.setViewportSize({ width: 1365, height: 900 });
  await page.goto("/?statsEnv=disabled");

  const calculatorTab = page.getByRole("tab", { name: "계산기" });
  const statsTab = page.getByRole("tab", { name: "통계" });
  await expect(calculatorTab).toHaveAttribute("tabindex", "0");
  await expect(statsTab).toHaveAttribute("tabindex", "-1");

  await calculatorTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(statsTab).toBeFocused();
  await expect(statsTab).toHaveAttribute("aria-selected", "true");
  await expect(statsTab).toHaveAttribute("tabindex", "0");
  await expect(page.getByRole("tabpanel", { name: "통계" })).toBeVisible();

  await page.keyboard.press("Home");
  await expect(calculatorTab).toBeFocused();
  await expect(calculatorTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "계산기" })).toBeVisible();

  await page.keyboard.press("End");
  await expect(statsTab).toBeFocused();
  await expect(statsTab).toHaveAttribute("aria-selected", "true");
});

test("모바일 탭은 순환 키보드 이동과 현재 패널 관계를 유지한다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?statsEnv=disabled");

  const inputTab = page.getByRole("tab", { name: "입력" });
  const resultTab = page.getByRole("tab", { name: "결과" });
  const statsTab = page.getByRole("tab", { name: "통계" });
  await inputTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(resultTab).toBeFocused();
  await expect(resultTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "결과" })).toBeVisible();

  await page.keyboard.press("End");
  await expect(statsTab).toBeFocused();
  await expect(statsTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "통계" })).toBeVisible();

  await page.keyboard.press("ArrowRight");
  await expect(inputTab).toBeFocused();
  await expect(inputTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "입력" })).toBeVisible();
});

test("언어 메뉴는 현재 항목으로 포커스하고 키보드 선택 뒤 트리거로 돌아간다", async ({ page }) => {
  await page.setViewportSize({ width: 1365, height: 900 });
  await page.goto("/?statsEnv=disabled");

  const trigger = page.getByRole("button", { name: "언어 선택" });
  await trigger.click();
  const korean = page.getByRole("menuitemradio", { name: "한국어" });
  await expect(korean).toBeFocused();
  await expect(korean).toHaveAttribute("aria-checked", "true");

  await page.keyboard.press("ArrowDown");
  const english = page.getByRole("menuitemradio", { name: "English" });
  await expect(english).toBeFocused();
  await page.keyboard.press("Enter");
  const localizedTrigger = page.getByRole("button", { name: "Language" });
  await expect(
    page.getByRole("heading", { name: "Collection Item Upgrade Calculator" }),
  ).toBeVisible();
  await expect(localizedTrigger).toBeFocused();

  await localizedTrigger.click();
  await page.keyboard.press("End");
  await expect(page.getByRole("menuitemradio", { name: "日本語" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(localizedTrigger).toBeFocused();
});

test("모바일 테마 메뉴는 방향키 선택과 Escape 포커스 복귀를 지원한다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?statsEnv=disabled");

  const trigger = page.getByRole("button", { name: "테마 선택: 자동" });
  await trigger.click();
  const automatic = page.getByRole("menuitemradio", { name: "자동" });
  await expect(automatic).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitemradio", { name: "라이트" })).toBeFocused();
  await page.keyboard.press("Enter");

  const lightTrigger = page.getByRole("button", { name: "테마 선택: 라이트" });
  await expect(page.locator("body")).toHaveClass(/theme-light/);
  await expect(lightTrigger).toBeFocused();
  await lightTrigger.click();
  await page.keyboard.press("End");
  await expect(page.getByRole("menuitemradio", { name: "다크" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(lightTrigger).toBeFocused();
});

test("R 1 + 초심자용 100 — 계산 결과 패널에 추천 행동이 나타난다", async ({ page }) => {
  await expect(page.getByRole("group", { name: "최적화 방식" })).toHaveCount(0);
  await expect(page.locator("[data-strategy]")).toHaveCount(0);

  await page.getByLabel("초심자용 키트").fill("100");
  await page.getByRole("button", { name: "계산", exact: true }).click();

  await expect(page.locator(".next-action .action-label").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".next-action .action-chip-text").first()).toHaveText(/\s×\s\d+회/);
  await expect(page.locator(".table-wrap .action-chip-text").first()).toHaveText(/\s×\s\d+회/);
  await expect
    .poll(() =>
      page
        .locator(".next-action .action-chip-count")
        .first()
        .evaluate((element) => getComputedStyle(element).marginLeft),
    )
    .toBe("0px");
  await expect(page.locator(".result-panel .outcome-panel")).toBeVisible();
  await expect(page.getByRole("heading", { name: "대성공 여부" })).toBeVisible();
  await expect(page.getByText(/Solver · (?:Rust|JS)/)).toHaveCount(0);
  await expect(page.getByText(/실제 게임 결과에 맞게 대성공 여부를 선택하세요/)).toHaveCount(0);
  await expect(page.locator(".result-panel .outcome-panel .change-note")).toBeVisible();
});

test("첫 계산은 세부 정보 코드를 solver와 병렬로 요청한다", async ({ page }) => {
  const releaseWorker = Promise.withResolvers<void>();
  let detailRequested = false;
  let workerRequested = false;

  page.on("request", (request) => {
    if (/\/assets\/DetailPanel-[^/]+\.js(?:\?|$)/.test(request.url())) {
      detailRequested = true;
    }
  });
  await page.route(/\/assets\/worker-[^/]+\.js(?:\?|$)/, async (route) => {
    workerRequested = true;
    await releaseWorker.promise;
    await route.continue();
  });

  await page.getByLabel("초심자용 키트").fill("100");
  await page.getByRole("button", { name: "계산", exact: true }).click();

  try {
    await expect.poll(() => workerRequested).toBe(true);
    await expect.poll(() => detailRequested).toBe(true);
  } finally {
    releaseWorker.resolve();
  }

  await expect(page.locator(".next-action .action-label").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("SR 15 도달 확률").first()).toBeVisible();
});

test("세부 정보 코드가 늦어져도 결과와 함께 안정적인 준비 패널을 표시한다", async ({ page }) => {
  const releaseDetail = Promise.withResolvers<void>();
  let detailRequested = false;
  await page.route(/\/assets\/DetailPanel-[^/]+\.js(?:\?|$)/, async (route) => {
    detailRequested = true;
    await releaseDetail.promise;
    await route.continue();
  });

  await page.getByLabel("초심자용 키트").fill("100");
  await expect.poll(() => detailRequested).toBe(true);
  await page.getByRole("button", { name: "계산", exact: true }).click();

  try {
    await expect(page.locator(".next-action .action-label").first()).toBeVisible({
      timeout: 20_000,
    });
    const fallback = page.locator(".detail-panel[aria-busy='true']");
    await expect(fallback).toBeVisible();
    await expect(fallback).toContainText("세부 정보를 준비하고 있습니다.");
  } finally {
    releaseDetail.resolve();
  }

  await expect(page.locator(".detail-panel[aria-busy='true']")).toHaveCount(0);
  await expect(page.getByText("SR 15 도달 확률").first()).toBeVisible();
});

test("R 등급 추천은 추천 횟수와 무관하게 대성공 여부 칸에 안내 문구를 표시한다", async ({
  page,
}) => {
  await page.getByLabel("상급자용 키트").fill("100");
  await page.getByRole("button", { name: "계산", exact: true }).click();

  await expect(page.locator(".next-action .action-label").first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator(".result-panel .outcome-panel .change-note")).toBeVisible();
});

test("사용 가능한 키트가 10개 미만이면 계산 버튼이 비활성화된다", async ({ page }) => {
  const calculateButton = page.getByRole("button", { name: "계산", exact: true });
  await expect(calculateButton).toBeDisabled();

  await page.getByLabel("초심자용 키트").fill("9");
  await expect(calculateButton).toBeDisabled();

  await page.getByLabel("초심자용 키트").fill("10");
  await expect(calculateButton).toBeEnabled();
});

test("SR 10 + 상급자용 100 — 세부 정보에 SR 15 도달 확률이 나타난다", async ({ page }) => {
  await page
    .getByRole("group", { name: "소장품 등급" })
    .getByRole("button", { name: "SR" })
    .click();
  await page.getByRole("button", { name: "10단계", exact: true }).click();

  await page.getByLabel("상급자용 키트").fill("100");
  await page.getByRole("button", { name: "계산", exact: true }).click();

  await expect(page.getByText("SR 15 도달 확률").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("추천 기준")).toHaveCount(0);
  await expect(page.getByText("수급량 고려")).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "구간 대성공 확률" })).toHaveCount(0);
  await expect(page.getByText(/\d+(?:\.\d+)?%/).first()).toBeVisible();
  await expect(page.getByRole("table").getByText(/\d+회/).first()).toBeVisible();
  const desktopMetricDeltas = await page.locator(".metric").evaluateAll((metrics) =>
    metrics.map((metric) => {
      const label = metric.querySelector("span");
      const value = metric.querySelector("strong");
      if (!label || !value) return null;
      const metricRect = metric.getBoundingClientRect();
      const labelRect = label.getBoundingClientRect();
      const valueRect = value.getBoundingClientRect();
      const contentCenter = (labelRect.top + valueRect.bottom) / 2;
      const metricCenter = (metricRect.top + metricRect.bottom) / 2;
      return Math.abs(contentCenter - metricCenter);
    }),
  );
  expect(Math.max(...desktopMetricDeltas.filter((delta) => delta !== null))).toBeLessThanOrEqual(1);
});

test("SR 15 도달률이 모두 100%면 비추천 후보를 키트 부담 사유로 제외한다", async ({ page }) => {
  await page
    .getByRole("group", { name: "소장품 등급" })
    .getByRole("button", { name: "SR" })
    .click();
  await page.getByRole("button", { name: "14단계", exact: true }).click();
  await page.getByLabel("초심자용 키트").fill("200");
  await page.getByLabel("중급자용 키트").fill("100");
  await page.getByLabel("상급자용 키트").fill("100");
  await page.getByRole("button", { name: "계산", exact: true }).click();

  const rows = page.locator(".table-wrap tbody tr");
  await expect(rows).toHaveCount(3, { timeout: 20_000 });
  await expect(rows.nth(0)).toContainText("추천");
  await expect(rows.nth(0).locator(".candidate-probability-wide")).toHaveText("100%");
  for (const index of [1, 2]) {
    await expect(rows.nth(index)).toContainText("제외");
    await expect(rows.nth(index)).toContainText("키트 부담 높음");
    await expect(rows.nth(index).locator(".candidate-probability-wide")).toHaveText("100%");
    await expect(rows.nth(index)).toHaveCSS("opacity", "0.6");
  }
  const candidatePadding = await page.locator(".table-wrap").evaluate((wrap) => {
    const header = wrap.querySelector<HTMLElement>("thead th:first-child");
    const body = wrap.querySelector<HTMLElement>("tbody td:first-child");
    if (!header || !body) throw new Error("Missing candidate cells.");
    return {
      body: Number.parseFloat(getComputedStyle(body).paddingInlineStart),
      header: Number.parseFloat(getComputedStyle(header).paddingInlineStart),
    };
  });
  expect(candidatePadding.header).toBeGreaterThanOrEqual(10);
  expect(candidatePadding.body).toBe(candidatePadding.header);
  const cellAlignments = await rows
    .locator("th, td")
    .evaluateAll((cells) => cells.map((cell) => getComputedStyle(cell).verticalAlign));
  expect(new Set(cellAlignments)).toEqual(new Set(["middle"]));
});

test("태블릿에서는 현재 소장품 영역을 넓히고 키트 라벨을 한 줄로 유지한다", async ({ page }) => {
  for (const width of [661, 768, 900, 980]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/?statsEnv=disabled");

    const statePanel = page.locator(".state-panel");
    const stockPanel = page.getByRole("heading", { name: "보유 키트" }).locator("../..");
    const [stateBox, stockBox] = await Promise.all([
      statePanel.boundingBox(),
      stockPanel.boundingBox(),
    ]);
    expect(stateBox).not.toBeNull();
    expect(stockBox).not.toBeNull();
    expect(stateBox?.width || 0).toBeGreaterThan(stockBox?.width || 0);

    const labelLayout = await page
      .getByText(/^(?:초심자용|중급자용|상급자용) 키트$/)
      .evaluateAll((labels) =>
        labels.map((label) => ({
          clientWidth: label.clientWidth,
          scrollWidth: label.scrollWidth,
          whiteSpace: getComputedStyle(label).whiteSpace,
        })),
      );
    expect(labelLayout).toHaveLength(3);
    for (const label of labelLayout) {
      expect(label.whiteSpace).toBe("nowrap");
      expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);
    }
  }
});

test("모바일 metric 콘텐츠는 카드 안에서 상하 가운데 정렬된다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?statsEnv=disabled");
  await page
    .getByRole("group", { name: "소장품 등급" })
    .getByRole("button", { name: "SR" })
    .click();
  await page.getByRole("button", { name: "10단계", exact: true }).click();
  await page.getByLabel("상급자용 키트").fill("100");
  await page
    .getByRole("toolbar", { name: "모바일 작업" })
    .getByRole("button", { name: "계산하기" })
    .click();
  await expect(page.getByText("SR 15 도달 확률").first()).toBeVisible({ timeout: 20_000 });

  const mobileMetricDeltas = await page.locator(".metric").evaluateAll((metrics) =>
    metrics.map((metric) => {
      const label = metric.querySelector("span");
      const value = metric.querySelector("strong");
      if (!label || !value) return null;
      const metricRect = metric.getBoundingClientRect();
      const labelRect = label.getBoundingClientRect();
      const valueRect = value.getBoundingClientRect();
      const contentCenter = (labelRect.top + valueRect.bottom) / 2;
      const metricCenter = (metricRect.top + metricRect.bottom) / 2;
      return Math.abs(contentCenter - metricCenter);
    }),
  );
  expect(Math.max(...mobileMetricDeltas.filter((delta) => delta !== null))).toBeLessThanOrEqual(1);
});

test("SR 5 다회 대성공 — 모달 없이 키트 수정 후 다시 계산할 수 있다", async ({ page }) => {
  await page
    .getByRole("group", { name: "소장품 등급" })
    .getByRole("button", { name: "SR" })
    .click();
  await page.getByRole("button", { name: "5단계", exact: true }).click();

  await page.getByLabel("상급자용 키트").fill("100");
  await page.getByRole("button", { name: "계산", exact: true }).click();
  await confirmOutcome(
    page,
    page.getByRole("button", { name: "대성공 O", exact: true }).first(),
    "대성공 O",
  );

  await expect(page.locator(".attempt-modal-overlay")).toHaveCount(0);
  await expect(page.getByLabel("상급자용 키트")).toHaveValue("100");
  await expect(page.locator("#stockEditNotice")).toContainText(
    "가능한 남은 수량은 70~90개 사이의 10개 간격 값입니다.",
  );
  await expect(page.getByRole("button", { name: "키트 수정 필요", exact: true })).toBeDisabled();

  await page.getByLabel("상급자용 키트").fill("85");
  await expect(page.locator("#stockEditNotice")).toContainText("감소량은 10개 단위여야 합니다.");
  await expect(page.locator("#stockEditNotice")).toContainText("대성공 통계는 기록하지 않습니다.");
  await expect(page.getByRole("button", { name: "다시 계산", exact: true })).toBeEnabled();

  await page.getByLabel("상급자용 키트").fill("80");
  await expect(page.locator("#stockEditNotice")).toContainText(
    "2회차에서 대성공한 것으로 확인됩니다.",
  );
  await expect(page.getByRole("button", { name: "2회차 반영 후 계산", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "2회차 반영 후 계산", exact: true }).click();

  await expect(page.getByRole("heading", { name: "대성공 여부" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator("#stockEditNotice")).toBeHidden();
});

test("대성공 확정 전 취소하면 같은 패널에서 선택 상태만 해제된다", async ({ page }) => {
  await page
    .getByRole("group", { name: "소장품 등급" })
    .getByRole("button", { name: "SR" })
    .click();
  await page.getByRole("button", { name: "10단계", exact: true }).click();
  await page.getByLabel("상급자용 키트").fill("100");
  await page.getByRole("button", { name: "계산", exact: true }).click();
  await page.getByRole("button", { name: "대성공 O", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "대성공 O 확정", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "취소", exact: true }).click();

  await expect(page.getByRole("button", { name: "대성공 O", exact: true })).toBeVisible();
  await expect(page.locator(".attempt-modal-overlay")).toHaveCount(0);
});

test("R 15 — SR 등급 교체 안내와 적용이 동작한다", async ({ page }) => {
  await page.getByLabel("상급자용 키트").fill("100");
  await page.getByRole("button", { name: "15단계", exact: true }).click();

  await expect(page.getByText("SR 등급으로 교체")).toBeVisible();
  await expect(page.getByText("SR 등급 교체를 적용할 수 있습니다.")).toBeVisible();
  await expect(page.getByRole("button", { name: "교체 적용", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "교체 적용", exact: true }).click();

  await expect(page.locator(".current-state-strip")).toContainText("SR");
  await expect(page.locator(".current-state-strip")).toContainText("5단계");
  await expect(page.locator(".next-action .action-label").first()).toBeVisible({
    timeout: 20_000,
  });
});

test("R 15 교체 안내는 키트 수량만 바꿔도 유지된다", async ({ page }) => {
  await page.getByLabel("상급자용 키트").fill("100");
  await page.getByRole("button", { name: "15단계", exact: true }).click();

  await expect(page.getByText("SR 등급으로 교체")).toBeVisible();
  await expect(page.getByRole("button", { name: "교체 적용", exact: true })).toBeVisible();

  await page.getByLabel("상급자용 키트").fill("90");

  await expect(page.getByText("SR 등급으로 교체")).toBeVisible();
  await expect(page.getByRole("button", { name: "교체 적용", exact: true })).toBeVisible();
});

test("R 15/SR 15 안내는 최대 단계 선택을 반복하거나 등급을 바꿔도 유지된다", async ({ page }) => {
  await page.getByRole("button", { name: "15단계", exact: true }).click();
  await expect(page.getByText("SR 등급으로 교체")).toBeVisible();

  await page
    .getByRole("group", { name: "소장품 등급" })
    .getByRole("button", { name: "R", exact: true })
    .click();
  await expect(page.getByText("SR 등급으로 교체")).toBeVisible();

  await page.getByRole("button", { name: "15단계", exact: true }).click();
  await expect(page.getByText("SR 등급으로 교체")).toBeVisible();

  await page
    .getByRole("group", { name: "소장품 등급" })
    .getByRole("button", { name: "SR" })
    .click();
  await expect(page.getByText("SR 15단계입니다. 최종 목표 상태입니다.")).toBeVisible();
  await expect(page.getByText("SR 등급으로 교체")).toHaveCount(0);

  await page.getByRole("button", { name: "15단계", exact: true }).click();
  await expect(page.getByText("SR 15단계입니다. 최종 목표 상태입니다.")).toBeVisible();

  await page
    .getByRole("group", { name: "소장품 등급" })
    .getByRole("button", { name: "R", exact: true })
    .click();
  await expect(page.getByText("SR 등급으로 교체")).toBeVisible();
  await expect(page.getByText("SR 15단계입니다. 최종 목표 상태입니다.")).toHaveCount(0);

  await page.getByRole("button", { name: "14단계", exact: true }).click();
  await expect(page.getByText("SR 등급으로 교체")).toHaveCount(0);
  await expect(
    page.getByText("최대 단계입니다. R 15단계는 SR 5단계로 교체할 수 있습니다."),
  ).toHaveCount(0);
});

test("SR 15 — 최종 목표 상태 문구가 정상 한글로 표시된다", async ({ page }) => {
  await page
    .getByRole("group", { name: "소장품 등급" })
    .getByRole("button", { name: "SR" })
    .click();
  await page.getByRole("button", { name: "15단계", exact: true }).click();

  await expect(page.getByText("SR 15단계입니다. 최종 목표 상태입니다.")).toBeVisible();
});

test("테마 선택 — 다크/라이트 버튼이 body 테마 클래스를 바꾼다", async ({ page }) => {
  const themeGroup = page.getByRole("group", { name: "테마 선택" });
  const body = page.locator("body");
  const html = page.locator("html");

  await page.evaluate(() => {
    const startViewTransition = document.startViewTransition.bind(document);
    document.startViewTransition = (update) => {
      document.documentElement.dataset["themeViewTransition"] = "started";
      return startViewTransition(update);
    };
  });

  await themeGroup.getByRole("button", { name: "다크", exact: true }).click();
  await expect(body).toHaveClass(/theme-dark/);
  await expect(html).toHaveAttribute("data-theme-view-transition", "started");
  await expect(html).not.toHaveClass(/theme-commit/);
  await expect(html).not.toHaveClass(/theme-view-transitioning/);

  await themeGroup.getByRole("button", { name: "라이트", exact: true }).click();
  await expect(body).toHaveClass(/theme-light/);
});

test("테마 선택 — reduced motion에서는 View Transition을 건너뛴다", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => {
    Reflect.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: () => {
        document.documentElement.dataset["unexpectedViewTransition"] = "called";
        throw new Error("View Transition should not run with reduced motion.");
      },
    });
  });

  await page
    .getByRole("group", { name: "테마 선택" })
    .getByRole("button", { name: "다크", exact: true })
    .click();

  await expect(page.locator("body")).toHaveClass(/theme-dark/);
  await expect(page.locator("html")).not.toHaveAttribute("data-unexpected-view-transition");
  await expect(page.locator("html")).not.toHaveClass(/theme-commit/);
});

test("테마 선택 — 보유 키트 패널은 다크 모드에서 어두운 배경을 유지한다", async ({ page }) => {
  const themeGroup = page.getByRole("group", { name: "테마 선택" });
  const stockPanel = page
    .locator("section", {
      has: page.getByRole("heading", { name: "보유 키트", exact: true }),
    })
    .last();

  await themeGroup.getByRole("button", { name: "다크", exact: true }).click();
  await expect.poll(() => maxBackgroundChannel(stockPanel)).toBeLessThan(90);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => maxBackgroundChannel(stockPanel)).toBeLessThan(90);
});

test("demoStats=1 — 전체 통계 주요 섹션이 표시된다", async ({ page }) => {
  await page.goto("/?demoStats=1");
  await openStatsPanel(page);

  await expect(page.getByRole("heading", { name: "전체 통계" })).toBeVisible();
  await expect(page.getByText("전체 대성공률")).toBeVisible();
  await expect(page.getByText("키트별 대성공률")).toBeVisible();
  await expect(page.getByText("구간별 체감 난이도")).toBeVisible();
  await expect(page.getByText("반투명 영역 · 시도 수를 반영한 보수적 95% 범위")).toHaveCount(2);
  await expect(page.locator(".kit-rate-row")).toHaveCount(3);
  await expect(page.locator(".difficulty-row")).toHaveCount(6);
  await expect(page.getByText("누적 제출 결과", { exact: true })).toBeVisible();
  await expect(page.getByText(/고유 사용자 수나 전체 이용자를 뜻하지 않습니다/)).toBeVisible();
  await expect(page.locator(".overall-stats-window")).toHaveCount(1);
  await expect(page.locator(".stats-vs-card")).toHaveCount(2);
  await expect(page.getByText("실측 대성공률", { exact: true })).toBeVisible();
  await expect(page.getByText("실측 - 기대값", { exact: true })).toHaveCount(0);
  await expect(page.getByText("최근 30일 체감", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/현재 확률표 기준으로 계산한 입력 표본 통계입니다/)).toHaveCount(0);
  await expect(page.locator(".kit-rate-meta").first()).toContainText(/\d+개/);
  await expect(page.locator(".kit-rate-meta").first()).not.toContainText(/실측|기대값/);
  await expect(page.locator(".kit-rate-meta .stats-usage-trigger")).toHaveCount(0);
  await expect(page.locator(".difficulty-row .stats-usage-trigger")).toHaveCount(6);
  await expect(page.locator(".difficulty-row .stats-usage-trigger").first()).toContainText(/\d+개/);
  const usageTrigger = page.locator(".difficulty-row .stats-usage-trigger").first();
  await usageTrigger.hover();
  const tooltip = page.locator(".difficulty-tooltip");
  await expect(tooltip).toContainText("초심자용 관리 키트");
  await expect(tooltip).toContainText(/개/);
  const beforeClick = await tooltip.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: Math.round(rect.left), top: Math.round(rect.top) };
  });
  await usageTrigger.click();
  const afterClick = await tooltip.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: Math.round(rect.left), top: Math.round(rect.top) };
  });
  expect(afterClick).toEqual(beforeClick);
  await expect(page.getByText(/^(쉬움|보통|어려움)$/)).toHaveCount(0);
  await expect(page.getByText("누적 중심", { exact: true })).toHaveCount(0);
  await expect(page.getByText("기대값 vs 실측", { exact: true })).toHaveCount(0);
  await expect(page.getByText("기록된 키트 조합 기준", { exact: true })).toHaveCount(0);
  await expect(page.getByText("결과 입력 표본 기준 · 이벤트 단위 집계")).toHaveCount(0);
});

test("모바일 키트 사용량 툴팁은 탭 후 유지되고 외부 터치로 닫힌다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?demoStats=1");
  await page.getByRole("tab", { name: "통계" }).click();
  await openStatsPanel(page);

  const usageTrigger = page.locator(".difficulty-row .stats-usage-trigger").first();
  const tooltip = page.locator(".difficulty-tooltip");
  await expect(usageTrigger).toBeVisible();

  const box = await usageTrigger.boundingBox();
  if (!box) throw new Error("Expected usage trigger to have a bounding box.");
  const point = {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + box.height / 2),
  };

  await usageTrigger.evaluate((element, eventPoint) => {
    element.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        clientX: eventPoint.x,
        clientY: eventPoint.y,
        isPrimary: true,
        pointerId: 1,
        pointerType: "touch",
      }),
    );
  }, point);
  await expect(tooltip).toHaveClass(/is-visible/);

  await usageTrigger.evaluate((element, eventPoint) => {
    element.dispatchEvent(
      new PointerEvent("pointerleave", {
        bubbles: true,
        clientX: eventPoint.x,
        clientY: eventPoint.y,
        pointerId: 1,
        pointerType: "touch",
      }),
    );
  }, point);
  await expect(tooltip).toHaveClass(/is-visible/);

  await page.locator("body").evaluate((element) => {
    element.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        clientX: 8,
        clientY: 8,
        isPrimary: true,
        pointerId: 2,
        pointerType: "touch",
      }),
    );
  });
  await expect(tooltip).not.toHaveClass(/is-visible/);
});

test("초기화 버튼은 입력값과 계산 결과를 초기화한다", async ({ page }) => {
  await page.getByLabel("초심자용 키트").fill("100");
  await page.getByRole("button", { name: "계산", exact: true }).click();
  await expect(page.locator(".next-action")).toBeVisible({ timeout: 20_000 });

  await expect(page.getByRole("link", { name: "소장품 레벨업 계산기", exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "초기화", exact: true }).click();

  await expect(page.getByLabel("초심자용 키트")).toHaveValue("");
  await expect(page.getByLabel("초심자용 키트")).toHaveAttribute("placeholder", "0");
  await expect(page.getByText("아직 계산 결과가 없습니다. 세 단계면 충분해요.")).toBeVisible();
});

test("초기화 되돌리기는 R·SR 입력 스냅샷을 원자적으로 복원한다", async ({ page }) => {
  const scenarios = [
    { grade: "R", level: 3, exp: "700", stock: ["110", "220", "330"] },
    { grade: "SR", level: 7, exp: "2500", stock: ["440", "550", "660"] },
  ] as const;

  for (const scenario of scenarios) {
    await page.goto("/?statsEnv=disabled");
    const gradeGroup = page.getByRole("group", { name: "소장품 등급" });
    await gradeGroup.getByRole("button", { name: scenario.grade, exact: true }).click();
    await page.getByRole("button", { name: `${scenario.level}단계`, exact: true }).click();
    await page.locator("#currentExp").fill(scenario.exp);
    await page.locator("#currentExp").blur();

    for (const [label, value] of [
      ["초심자용 키트", scenario.stock[0]],
      ["중급자용 키트", scenario.stock[1]],
      ["상급자용 키트", scenario.stock[2]],
    ] as const) {
      await page.getByLabel(label).fill(value);
      await page.getByLabel(label).blur();
    }

    await page.getByRole("button", { name: "초기화", exact: true }).click();
    await page.getByRole("button", { name: /되돌리기/ }).click();

    await expect(
      gradeGroup.getByRole("button", { name: scenario.grade, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("button", { name: `${scenario.level}단계`, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#currentExp")).toHaveValue(scenario.exp);
    await expect(page.getByLabel("초심자용 키트")).toHaveValue(scenario.stock[0]);
    await expect(page.getByLabel("중급자용 키트")).toHaveValue(scenario.stock[1]);
    await expect(page.getByLabel("상급자용 키트")).toHaveValue(scenario.stock[2]);
    await expect(page.getByText("아직 계산 결과가 없습니다. 세 단계면 충분해요.")).toBeVisible();
  }
});

test("staging 설정 누락은 운영 API로 대체하지 않고 알림을 표시한다", async ({ page }) => {
  await page.goto("/?statsEnv=disabled");
  await expect(page.getByLabel("스테이징 환경")).toHaveCount(0);

  await serveStagingDocument(page);
  await page.goto("/?statsEnv=staging");
  await expect(page.getByRole("alert", { name: "스테이징 환경" })).toContainText(
    "STAGING 설정 누락",
  );
});

test("비활성 통계는 로딩 상태에 머물지 않고 미설정 안내를 표시한다", async ({ page }) => {
  await openStatsPanel(page);

  const statsBox = page.locator("#globalStatsBox");
  await expect(statsBox).toContainText("통계 서버를 연결하면");
  await expect(statsBox).not.toHaveAttribute("aria-busy", "true");
  await expect(statsBox.locator(".stats-loading-spinner")).toHaveCount(0);
});

test("staging 통계는 통계 탭을 열 때만 별도 API에서 조회한다", async ({ page }) => {
  let requestedStatsUrl = "";
  const requestedStatsAssets: string[] = [];
  const statsResponse = Promise.withResolvers<void>();
  page.on("request", (request) => {
    if (request.url().includes("StatsPanelBody-")) requestedStatsAssets.push(request.url());
  });
  await serveStagingDocument(page, {
    endpoint: "https://staging.example.test",
    turnstileSiteKey: "staging-site-key",
  });
  await page.route("https://staging.example.test/api/stats", async (route) => {
    requestedStatsUrl = route.request().url();
    await statsResponse.promise;
    await route.fulfill({
      status: 500,
      headers: { "Access-Control-Allow-Origin": `http://127.0.0.1:${PORT}` },
      body: "",
    });
  });

  await page.goto("/?statsEnv=staging");

  await expect(page.getByLabel("스테이징 환경")).toContainText(
    "테스트 기록은 운영 통계에 반영되지 않음",
  );
  await page.waitForTimeout(100);
  expect(requestedStatsUrl).toBe("");
  expect(requestedStatsAssets).toHaveLength(0);

  await page.getByRole("tab", { name: "통계" }).first().click();
  const statsLoading = page.locator("#globalStatsBox[aria-busy='true']");
  await expect(statsLoading).toBeVisible();
  await expect(statsLoading.locator(".stats-loading-spinner")).toBeVisible();
  await expect(statsLoading).toContainText("통계");
  await expect.poll(() => requestedStatsUrl).toBe("https://staging.example.test/api/stats");
  await expect.poll(() => requestedStatsAssets.length).toBe(1);
  statsResponse.resolve();
  await expect(statsLoading).toBeHidden();
  await expect(page.getByText("통계를 불러오지 못했습니다.")).toBeVisible();
});

test("전송 실패 통계는 새로고침 뒤 같은 eventId로 재전송되고 성공 시 삭제된다", async ({
  page,
}) => {
  const endpoint = "https://staging.example.test";
  const outboxKey = `collection-kit-calculator.stats-outbox.v1:${encodeURIComponent(endpoint)}`;
  const failedEventIds = new Set<string>();
  const replayedEventIds = new Set<string>();
  let acceptEvents = false;

  await installTurnstileStub(page);
  await serveStagingDocument(page, {
    endpoint,
    turnstileSiteKey: "staging-site-key",
  });
  await page.route(`${endpoint}/api/events`, async (route) => {
    const body = route.request().postDataJSON() as { eventId?: unknown };
    const eventId = typeof body.eventId === "string" ? body.eventId : "";
    if (acceptEvents) {
      replayedEventIds.add(eventId);
      await route.fulfill({
        status: 200,
        headers: { "Access-Control-Allow-Origin": `http://127.0.0.1:${PORT}` },
        body: '{"ok":true}',
      });
      return;
    }
    failedEventIds.add(eventId);
    await route.fulfill({
      status: 503,
      headers: { "Access-Control-Allow-Origin": `http://127.0.0.1:${PORT}` },
      body: '{"error":"storage_unavailable","retryable":true}',
    });
  });

  await page.goto("/?statsEnv=staging");
  await page.getByLabel("초심자용 키트").fill("100");
  await page.getByRole("button", { name: "계산", exact: true }).click();
  await expect(page.locator(".next-action .action-label").first()).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(() =>
      page.evaluate((key) => {
        const stored = localStorage.getItem(key);
        if (!stored) return [];
        const value = JSON.parse(stored) as {
          records?: Array<{ envelope?: { eventId?: string } }>;
        };
        return value.records?.map((record) => record.envelope?.eventId ?? "") ?? [];
      }, outboxKey),
    )
    .not.toHaveLength(0);

  const storedEventIds = await page.evaluate((key) => {
    const value = JSON.parse(localStorage.getItem(key) ?? "{}") as {
      records?: Array<{ envelope?: { eventId?: string } }>;
    };
    return value.records?.map((record) => record.envelope?.eventId ?? "") ?? [];
  }, outboxKey);
  expect(storedEventIds.every((eventId) => failedEventIds.has(eventId))).toBe(true);

  acceptEvents = true;
  await page.reload();
  await expect
    .poll(() => storedEventIds.every((eventId) => replayedEventIds.has(eventId)))
    .toBe(true);
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), outboxKey)).toBeNull();
});

test("demo 및 disabled 계산은 통계 이벤트를 제출하지 않는다", async ({ page }) => {
  let eventRequests = 0;
  await page.route("**/api/events", async (route) => {
    eventRequests += 1;
    await route.fulfill({ status: 200, body: '{"ok":true}' });
  });

  for (const query of ["?statsEnv=disabled", "?demoStats=1"]) {
    await page.goto(`/${query}`);
    await page.locator("#blueStock").fill("100");
    await page.locator("#calculateButton").click();
    await expect(page.locator(".next-action")).toBeVisible({ timeout: 20_000 });
  }

  expect(eventRequests).toBe(0);
});

test("레퍼런스 정리 요소와 통계 비교 상태가 표시된다", async ({ page }) => {
  await page.goto("/?demoStats=1");
  await openStatsPanel(page);

  await expect(page.getByText("Collectibles Leveling up Optimizer")).toHaveCount(0);
  await expect(page.getByText("테마", { exact: true })).toHaveCount(0);
  await expect(page.getByText("1~5", { exact: true })).toHaveCount(0);
  await expect(page.getByText("6~10", { exact: true })).toHaveCount(0);
  await expect(page.getByText("11~15", { exact: true })).toHaveCount(0);
  await expect(page.locator(".difficulty-row")).toHaveCount(6);
  await expect(page.locator(".difficulty-comparison")).toHaveCount(0);
  await expect(page.getByText("중앙 = 기대값 · 축 ±5%p").first()).toBeVisible();
});

test("검산 details — 펼치면 가상의 니붕이 검산 결과가 자동 표시된다", async ({ page }) => {
  await page
    .getByRole("group", { name: "소장품 등급" })
    .getByRole("button", { name: "SR" })
    .click();
  await page.getByRole("button", { name: "10단계", exact: true }).click();
  await page.getByLabel("상급자용 키트").fill("100");
  await page.getByRole("button", { name: "계산", exact: true }).click();
  await expect(page.getByText("SR 15 도달 확률").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "계산", exact: true })).toBeEnabled();
  const validationDetails = page.locator(".validation-details");
  await expect(validationDetails.locator(".info-tip")).toHaveCount(1);
  await expect(page.locator(".validation-button")).toHaveCount(0);

  const validationToggle = validationDetails.getByRole("button", { name: "검증", exact: true });
  const validationHeaderGeometry = await validationDetails.evaluate((details) => {
    const label = details.querySelector<HTMLElement>(".validation-summary-label");
    const info = details.querySelector<HTMLElement>(".info-tip");
    const meta = details.querySelector<HTMLElement>(".validation-summary-meta");
    if (!label || !info || !meta) throw new Error("Missing validation header control.");
    const labelRect = label.getBoundingClientRect();
    const infoRect = info.getBoundingClientRect();
    const metaRect = meta.getBoundingClientRect();
    return {
      infoAfterLabel: infoRect.left >= labelRect.right,
      infoGap: infoRect.left - labelRect.right,
      infoBeforeMeta: infoRect.right < metaRect.left,
    };
  });
  expect(validationHeaderGeometry.infoAfterLabel).toBe(true);
  expect(validationHeaderGeometry.infoGap).toBeLessThanOrEqual(6);
  expect(validationHeaderGeometry.infoBeforeMeta).toBe(true);
  await validationToggle.click();
  await expect(validationToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText(/가상의 니붕이 .*SR 15/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/이번엔 가상의 니붕이/)).toHaveCount(0);

  await page.getByLabel("상급자용 키트").fill("90");
  await expect(
    page
      .locator(".result-panel")
      .getByText("보유 키트가 변경되었습니다. 계산 버튼을 눌러 결과를 갱신해주세요."),
  ).toBeVisible();
  await expect(page.locator(".result-panel #resultBox")).toHaveAttribute("inert", "");
  await expect(page.locator(".result-panel [role='status']")).not.toHaveAttribute("inert");
});
test("모바일 탭은 입력, 결과, 통계 화면을 전환한다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?demoStats=1");

  await expect(page.getByRole("heading", { name: "현재 소장품" })).toBeVisible();
  const themeButton = page.getByRole("button", { name: /테마 선택:/ });
  const themeButtonBox = await themeButton.boundingBox();
  expect(themeButtonBox).not.toBeNull();
  expect(themeButtonBox?.width).toBeLessThanOrEqual(64);

  await page.getByRole("tab", { name: "통계" }).click();
  await expect(page.locator(".mobile-tabs")).toHaveAttribute("data-active-index", "2");
  await expect(page.getByRole("heading", { name: "전체 통계" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "현재 소장품" })).toBeHidden();
  await expect(page.getByRole("toolbar", { name: "모바일 작업" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "통계" })).toHaveAttribute(
    "aria-controls",
    "statsWorkspace",
  );

  await page.getByRole("tab", { name: "결과" }).click();
  await expect(page.getByRole("heading", { name: "결과" })).toBeVisible();

  await page.getByRole("tab", { name: "입력" }).click();
  await expect(page.getByRole("heading", { name: "현재 소장품" })).toBeVisible();
});

test("모바일 hash 탐색은 통계에서 계산 입력 탭으로 대칭 복귀한다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?statsEnv=disabled");

  await page.evaluate(() => {
    window.location.hash = "stats";
  });
  await expect(page.getByRole("tab", { name: "통계" })).toHaveAttribute("aria-selected", "true");

  await page.evaluate(() => {
    window.location.hash = "";
  });
  await expect(page.getByRole("tab", { name: "입력" })).toHaveAttribute("aria-selected", "true");
});

test("모바일 하단 액션바로 계산하고 결과 액션을 표시한다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?statsEnv=disabled");

  await page.getByLabel("초심자용 키트").fill("100");
  const actionBar = page.getByRole("toolbar", { name: "모바일 작업" });
  await actionBar.getByRole("button", { name: "계산하기", exact: true }).click();

  const resultTab = page.getByRole("tab", { name: "결과" });
  await expect(resultTab).toHaveAttribute("aria-selected", "true");
  await expect(resultTab).toBeFocused();
  await expect(page.locator(".next-action .action-label").first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator(".table-wrap .action-chip-text").first()).toContainText(
    "초심자용 키트",
  );
  await expect(page.locator(".table-wrap")).toHaveAttribute("data-action-label", "full");
  await expect(page.locator(".table-wrap .action-chip-name-full").first()).toBeVisible();
  await expect(page.locator(".table-wrap .action-chip-name-short").first()).toBeHidden();
  await expect
    .poll(() =>
      page
        .locator(".table-wrap .action-chip-separator")
        .first()
        .evaluate((element) => getComputedStyle(element).display),
    )
    .toBe("none");
  await expect(actionBar.locator(".change-note")).toContainText(MOBILE_OUTCOME_PROMPT);
  await expect(actionBar).not.toContainText("누르면 누른 자리가 확정 버튼으로 바뀝니다.");
  await expect(actionBar.getByRole("button", { name: "대성공 O", exact: true })).toBeVisible();
  await expect(actionBar.getByRole("button", { name: "대성공 X", exact: true })).toBeVisible();

  await page.setViewportSize({ width: 320, height: 720 });
  const initialToolbarBox = await actionBar.boundingBox();
  const initialSuccessBox = await actionBar
    .getByRole("button", { name: "대성공 O", exact: true })
    .boundingBox();
  const initialFailBox = await actionBar
    .getByRole("button", { name: "대성공 X", exact: true })
    .boundingBox();
  expect(initialToolbarBox).not.toBeNull();
  expect(initialSuccessBox).not.toBeNull();
  expect(initialFailBox).not.toBeNull();

  await actionBar.getByRole("button", { name: "대성공 O", exact: true }).click();
  const pendingToolbarBox = await actionBar.boundingBox();
  const confirmBox = await actionBar
    .getByRole("button", { name: "대성공 O 확정", exact: true })
    .boundingBox();
  const cancelBox = await actionBar
    .getByRole("button", { name: "취소", exact: true })
    .boundingBox();
  expect(pendingToolbarBox?.height).toBe(initialToolbarBox?.height);
  expect(confirmBox?.width).toBe(initialSuccessBox?.width);
  expect(confirmBox?.height).toBe(initialSuccessBox?.height);
  expect(cancelBox?.width).toBe(initialFailBox?.width);
  expect(cancelBox?.height).toBe(initialFailBox?.height);
  await expect(actionBar).not.toContainText("아니라면 취소");

  const tabsBox = await page.locator(".mobile-tabs").boundingBox();
  expect(pendingToolbarBox).not.toBeNull();
  expect(tabsBox).not.toBeNull();
  expect((pendingToolbarBox?.y ?? 0) + (pendingToolbarBox?.height ?? 0)).toBeLessThanOrEqual(
    tabsBox?.y ?? 0,
  );

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const detailPanelBox = await page.locator("#mobile-panel-result .detail-panel").boundingBox();
  const mobileBottomBox = await page.locator(".mobile-bottom-bar").boundingBox();
  expect(detailPanelBox).not.toBeNull();
  expect(mobileBottomBox).not.toBeNull();
  expect((detailPanelBox?.y ?? 0) + (detailPanelBox?.height ?? 0)).toBeLessThanOrEqual(
    (mobileBottomBox?.y ?? 0) - 8,
  );
});

test("대성공 X 선택 후 다음 추천이 자동 계산된다", async ({ page }) => {
  await page.getByLabel("초심자용 키트").fill("100");
  await page.getByRole("button", { name: "계산", exact: true }).click();
  await expect(page.getByRole("heading", { name: "대성공 여부" })).toBeVisible({
    timeout: 20_000,
  });

  await expect(page.locator(".next-action-previous")).toHaveCount(0);

  await page.getByRole("button", { name: "대성공 X", exact: true }).first().click();
  await page.getByRole("button", { name: "대성공 X 확정", exact: true }).first().click();
  const loadingPopup = page.getByRole("status").filter({ hasText: "대성공 X를 반영" });
  await expect(loadingPopup).toBeHidden({ timeout: 20_000 });

  await expect(page.getByText("적용 완료")).toBeHidden({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "대성공 여부" })).toBeVisible();
  await expect(page.getByLabel("초심자용 키트")).not.toHaveValue("100");
  await expect(page.locator(".next-action-previous")).toHaveCount(1);
  await expect(page.locator(".next-action-current")).toHaveCount(1);
  await expect(page.locator(".next-action-previous")).toHaveCount(0, { timeout: 3_000 });
  await expect(page.locator(".next-action-current")).toHaveCount(0, { timeout: 3_000 });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: "입력" }).click();
  await page.getByRole("tab", { name: "결과" }).click();
  await expect(page.locator(".next-action-previous")).toHaveCount(0);
  await expect(page.locator(".next-action-current")).toHaveCount(0);
});

test("모바일 결과 탭에서는 대성공 버튼이 하단 액션바에만 표시된다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?statsEnv=disabled");

  await page.getByLabel("초심자용 키트").fill("100");
  await page
    .getByRole("toolbar", { name: "모바일 작업" })
    .getByRole("button", { name: "계산하기", exact: true })
    .click();

  await expect(page.locator(".next-action .action-label").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".result-panel .outcome-panel")).toBeHidden();
  await expect(
    page.getByRole("toolbar", { name: "모바일 작업" }).locator(".change-note"),
  ).toContainText(MOBILE_OUTCOME_PROMPT);
  await expect(page.getByRole("button", { name: "대성공 O", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "대성공 X", exact: true })).toHaveCount(1);
});

test("모바일 상태 스트립은 R/SR 변경에도 레벨 위치가 흔들리지 않는다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?statsEnv=disabled");

  const before = await page.locator(".status-level").boundingBox();
  await page
    .getByRole("group", { name: "소장품 등급" })
    .getByRole("button", { name: "SR" })
    .click();
  const after = await page.locator(".status-level").boundingBox();

  expect(before).not.toBeNull();
  expect(after).not.toBeNull();
  expect(Math.abs((before?.x || 0) - (after?.x || 0))).toBeLessThanOrEqual(1);
});

test("모바일 수동 키트 수정 필요 상태는 하단 계산 버튼에서 바로 보인다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?statsEnv=disabled");

  await page.getByLabel("초심자용 키트").fill("100");
  const actionBar = page.getByRole("toolbar", { name: "모바일 작업" });
  await actionBar.getByRole("button", { name: "계산하기", exact: true }).click();
  await expect(page.locator(".next-action .action-label").first()).toBeVisible({ timeout: 20_000 });
  await confirmOutcome(
    page,
    actionBar.getByRole("button", { name: "대성공 O", exact: true }),
    "대성공 O",
  );

  await expect(page.getByRole("tab", { name: "입력" })).toHaveAttribute("aria-selected", "true");

  await expect(actionBar.getByRole("button", { name: "키트 수정 필요", exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    actionBar.getByRole("button", { name: "키트 수정 필요", exact: true }),
  ).toBeDisabled();
  await expect(page.locator("#stockEditNotice")).toBeVisible();

  await page.getByLabel("초심자용 키트").fill("90");
  await expect(
    actionBar.getByRole("button", { name: "1회차 반영 후 계산", exact: true }),
  ).toBeEnabled();
});

test("다회 대성공 역산이 불가능해도 수정된 재고로 계산하고 통계는 생략한다", async ({ page }) => {
  await page
    .getByRole("group", { name: "소장품 등급" })
    .getByRole("button", { name: "SR" })
    .click();
  await page.getByRole("button", { name: "5단계", exact: true }).click();
  await page.getByLabel("상급자용 키트").fill("100");
  await page.getByRole("button", { name: "계산", exact: true }).click();
  await confirmOutcome(
    page,
    page.getByRole("button", { name: "대성공 O", exact: true }).first(),
    "대성공 O",
  );

  await page.getByLabel("상급자용 키트").fill("85");
  await page.getByLabel("중급자용 키트").fill("90");
  await expect(page.locator("#stockEditNotice")).toContainText("추천 키트 외의 보유량도 변경되어");
  await expect(page.locator("#stockEditNotice")).toContainText("대성공 통계는 기록하지 않습니다.");
  const calculate = page.getByRole("button", { name: "다시 계산", exact: true });
  await expect(calculate).toBeEnabled();
  await calculate.click();

  await expect(page.locator("#stockEditNotice")).toBeHidden({ timeout: 20_000 });
  await expect(page.locator(".outcome-panel")).toBeVisible({ timeout: 20_000 });
});

test("모바일 변환 버튼은 SR 5 변환 후 결과 탭에서 자동 계산한다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?statsEnv=disabled");

  await page.getByLabel("상급자용 키트").fill("100");
  await page.locator(".level-button").nth(15).click();
  await page.locator(".mobile-action-bar .convert-button").click();

  await expect(page.getByRole("tab", { name: "결과" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".status-grade")).toHaveText("SR");
  await expect(page.locator(".status-level")).toHaveText("5단계");
  await expect(page.locator(".next-action .action-label").first()).toBeVisible({
    timeout: 20_000,
  });
});

test("모바일 520px 구간 툴팁은 viewport 안에 머문다", async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 900 });
  await page.goto("/?demoStats=1");
  await page.locator(".mobile-tab").nth(2).click();
  await openStatsPanel(page);

  const interval = page.locator(".difficulty-list .difficulty-interval").first();
  await expect(interval).toBeVisible();
  await interval.scrollIntoViewIfNeeded();
  const box = await interval.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  for (const ratio of [0.2, 0.5, 0.8]) {
    await interval.hover({
      position: { x: Math.max(1, box.width * ratio), y: Math.max(1, box.height / 2) },
    });
    const tooltip = page.locator(".difficulty-tooltip");
    await expect(tooltip).toHaveClass(/is-visible/);
    await expect(interval).toHaveAttribute("aria-describedby", "difficultyIntervalTooltip");
    await expect(interval).toHaveAttribute("aria-label", /보수적 95% 범위.+시도 [\d,]+회/);
    await expect(tooltip).toHaveAttribute("id", "difficultyIntervalTooltip");
    await expect(tooltip).toContainText(/보수적 95% 범위 .+~.+ · 시도 [\d,]+회/);
    await expect(tooltip).toContainText("시도 수가 적으면 우연히 결과가 좋거나 나쁠 수 있습니다.");
    const rect = await tooltip.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right };
    });
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(520);
  }
});

test("통계 키트별 사용량은 키보드 포커스와 Escape로 확인하고 닫는다", async ({ page }) => {
  await page.setViewportSize({ width: 1365, height: 900 });
  await page.goto("/?demoStats=1");
  await openStatsPanel(page);

  const usageTrigger = page.getByRole("button", { name: /키트별 사용량 보기/ }).first();
  const tooltip = page.locator(".difficulty-tooltip");
  await usageTrigger.focus();
  await expect(usageTrigger).toBeFocused();
  await expect(usageTrigger).toHaveAttribute("aria-describedby", "difficultyIntervalTooltip");
  await expect(tooltip).toHaveClass(/is-visible/);
  await expect(tooltip).toContainText("초심자용 관리 키트");

  await page.keyboard.press("Escape");
  await expect(tooltip).not.toHaveClass(/is-visible/);
  await expect(usageTrigger).toBeFocused();
});

test("통계 요청 실패 후 화면에서 다시 불러오면 새 요청으로 복구한다", async ({ page }) => {
  await serveStagingDocument(page, {
    endpoint: "https://staging.example.test",
    turnstileSiteKey: "staging-site-key",
  });
  let requestCount = 0;
  await page.route("https://staging.example.test/api/stats", async (route) => {
    requestCount += 1;
    const headers = { "Access-Control-Allow-Origin": "*" };
    if (requestCount === 1) {
      await route.fulfill({ body: '{"error":"temporary"}', headers, status: 503 });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.fulfill({
      body: JSON.stringify({
        byKit: [],
        segmentStats: [],
        summary: {
          attempts: 0,
          events: 0,
          greatSuccessRate: 0,
          greatSuccesses: 0,
          mostUsedKit: null,
          mostUsedKitPieces: 0,
          todayAttempts: 0,
          todayEvents: 0,
          todayGreatSuccesses: 0,
        },
        today: "2026-08-09",
        windowDays: 0,
      }),
      contentType: "application/json",
      headers,
      status: 200,
    });
  });

  await page.goto("/?statsEnv=staging");
  await page.getByRole("tab", { name: "통계" }).click();
  await expect(page.getByRole("alert")).toContainText("통계를 불러오지 못했습니다.");

  await page.getByRole("button", { name: "다시 불러오기" }).click();
  await expect(page.locator("#globalStatsBox[aria-busy='true']")).toBeVisible();
  await expect(page.locator("#globalStatsBox")).toContainText("아직 집계된 통계가 없습니다.");
  expect(requestCount).toBe(2);
});

test("데스크톱 구간 막대 클릭은 툴팁 위치를 움직이지 않는다", async ({ page }) => {
  await page.setViewportSize({ width: 1365, height: 900 });
  await page.goto("/?demoStats=1");
  await openStatsPanel(page);

  const interval = page.locator(".difficulty-list .difficulty-interval").first();
  await expect(interval).toBeVisible();
  await interval.scrollIntoViewIfNeeded();
  await interval.hover();

  const tooltip = page.locator(".difficulty-tooltip");
  await expect(tooltip).toHaveClass(/is-visible/);
  const before = await tooltip.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: Math.round(rect.left), top: Math.round(rect.top) };
  });

  await interval.click();
  const after = await tooltip.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: Math.round(rect.left), top: Math.round(rect.top) };
  });

  expect(after).toEqual(before);
  await page.keyboard.press("Escape");
  await expect(tooltip).not.toHaveClass(/is-visible/);
});

test("개인정보 안내는 데스크톱 푸터와 모바일 통계 탭 푸터에만 표시된다", async ({ page }) => {
  await page.goto("/?demoStats=1");
  await expect(page.locator("footer:visible")).toHaveCount(1);
  await expect(page.locator("footer:visible")).toContainText(
    "고유 식별 정보는 통계 DB에 저장하지 않습니다",
  );
  await expect(page.getByText("계산 모드")).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?demoStats=1");
  await expect(page.locator("footer:visible")).toHaveCount(0);

  await page.locator(".mobile-tab").nth(2).click();
  await expect(page.locator("footer:visible")).toHaveCount(1);
});

test("모바일 통계 탭은 첫 프레임부터 footer 하단 여백을 실제 탭바 높이에 맞춘다", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?demoStats=1");

  const samples = await page.evaluate(
    () =>
      new Promise<Array<{ actualHeight: number; declaredHeight: number }>>((resolve, reject) => {
        const shell = document.querySelector<HTMLElement>(".app-shell");
        const bottomBar = document.querySelector<HTMLElement>(".mobile-bottom-bar");
        const statsTab = document.querySelector<HTMLButtonElement>("#mobile-tab-stats");
        if (!shell || !bottomBar || !statsTab) {
          reject(new Error("Missing mobile footer transition target."));
          return;
        }

        const readSample = () => ({
          actualHeight: Math.ceil(bottomBar.getBoundingClientRect().height),
          declaredHeight: Number.parseFloat(shell.style.getPropertyValue("--mobile-bottom-height")),
        });
        const observer = new MutationObserver(() => {
          if (shell.dataset["mobileTab"] !== "stats") return;
          observer.disconnect();
          const measured = [readSample()];
          requestAnimationFrame(() => {
            measured.push(readSample());
            requestAnimationFrame(() => {
              measured.push(readSample());
              resolve(measured);
            });
          });
        });
        observer.observe(shell, { attributeFilter: ["data-mobile-tab"] });
        statsTab.click();
      }),
  );

  expect(samples).toHaveLength(3);
  for (const sample of samples) {
    expect(sample.declaredHeight).toBe(sample.actualHeight);
  }
});

test("모바일 info-tip 텍스트는 말풍선 안에 머문다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?statsEnv=disabled");
  await page.locator("#blueStock").fill("100");
  await page.locator(".mobile-action-bar .primary-button").click();

  const infoTip = page.locator(".info-tip").first();
  await expect(infoTip).toBeVisible({ timeout: 20_000 });
  const panelStyleBefore = await page.locator(".detail-panel").evaluate((panel) => {
    const style = getComputedStyle(panel);
    return {
      boxShadow: style.boxShadow,
      contain: style.contain,
      overflow: style.overflow,
    };
  });
  await infoTip.hover();

  const textBox = infoTip.locator("span");
  await expect(textBox).toBeVisible();
  await infoTip.blur();
  await infoTip.focus();
  await expect(textBox).toBeVisible();
  await expect(infoTip).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(infoTip).toHaveAttribute("aria-expanded", "false");

  await infoTip.click();
  await expect(infoTip).toHaveAttribute("aria-expanded", "true");
  await page.mouse.click(8, 8);
  await expect(infoTip).toHaveAttribute("aria-expanded", "false");

  await infoTip.focus();
  await expect(textBox).toBeVisible();
  const boxMetrics = await textBox.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    whiteSpace: getComputedStyle(element).whiteSpace,
  }));
  const layerMetrics = await page.evaluate(() => {
    const panel = document.querySelector(".detail-panel");
    const tooltip = document.querySelector(".info-tip span");
    if (!panel || !tooltip) return null;
    const panelRect = panel.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const panelStyle = getComputedStyle(panel);
    return {
      panelContain: panelStyle.contain,
      panelOverflow: panelStyle.overflow,
      panelBoxShadow: panelStyle.boxShadow,
      tooltipEscapesPanelTop: tooltipRect.top < panelRect.top,
    };
  });

  expect(boxMetrics.whiteSpace).toBe("normal");
  expect(boxMetrics.scrollWidth).toBeLessThanOrEqual(boxMetrics.clientWidth + 1);
  expect(layerMetrics).not.toBeNull();
  expect(layerMetrics?.panelContain).toBe("layout");
  expect(layerMetrics?.panelOverflow).toBe("visible");
  expect(layerMetrics?.panelBoxShadow).toBe(panelStyleBefore.boxShadow);
  expect(layerMetrics?.panelContain).toBe(panelStyleBefore.contain);
  expect(layerMetrics?.panelOverflow).toBe(panelStyleBefore.overflow);
  expect(layerMetrics?.tooltipEscapesPanelTop).toBe(true);
});

test("스테이징은 운영 solver 동작과 분리된 통계 endpoint를 사용한다", async ({ page }) => {
  await serveStagingDocument(page, {
    endpoint: "https://staging.example.test",
    turnstileSiteKey: "staging-site-key",
  });
  await mockStagingStatsEndpoints(page);

  await page.goto("/?statsEnv=staging");

  await expect(page.getByLabel("스테이징 환경")).toContainText(
    "테스트 기록은 운영 통계에 반영되지 않음",
  );
  await expect(page.getByLabel("Rust solver staging")).toHaveCount(0);
  await page.locator("[data-grade='SR']").click();
  await page.locator("[data-level='10']").click();
  await page.locator("#yellowStock").fill("100");
  await page.locator("#calculateButton").click();

  await expect(page.locator(".next-action")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".result-panel .outcome-panel")).toBeVisible();
  await expect(page.getByText("Solver · Rust min E[f]", { exact: true })).toBeVisible();
});
