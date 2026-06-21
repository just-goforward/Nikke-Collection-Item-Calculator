import { expect, test } from "@playwright/test";
import { type PreviewServer, preview } from "vite";
import {
  maxBackgroundChannel,
  mockStagingStatsEndpoints,
  serveStagingDocument,
} from "./smoke.helpers";

const PORT = 4173;
let previewServer: PreviewServer | null = null;

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

test("R 1 + 초심자용 100 — 계산 결과 패널에 추천 행동이 나타난다", async ({ page }) => {
  await expect(page.getByRole("group", { name: "최적화 방식" })).toHaveCount(0);
  await expect(page.locator("[data-strategy]")).toHaveCount(0);

  await page.getByLabel("초심자용 관리 키트").fill("100");
  await page.getByRole("button", { name: "계산", exact: true }).click();

  await expect(page.getByText("추천 행동")).toBeVisible({ timeout: 20_000 });
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

test("R 등급 추천은 추천 횟수와 무관하게 대성공 여부 칸에 안내 문구를 표시한다", async ({
  page,
}) => {
  await page.getByLabel("상급자용 관리 키트").fill("100");
  await page.getByRole("button", { name: "계산", exact: true }).click();

  await expect(page.getByText("추천 행동")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".result-panel .outcome-panel .change-note")).toBeVisible();
});

test("SR 10 + 상급자용 100 — 세부 정보에 SR 15 도달 확률이 나타난다", async ({ page }) => {
  await page
    .getByRole("group", { name: "소장품 등급" })
    .getByRole("button", { name: "SR" })
    .click();
  await page.getByRole("button", { name: "10단계", exact: true }).click();

  await page.getByLabel("상급자용 관리 키트").fill("100");
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

test("모바일 metric 콘텐츠는 카드 안에서 상하 가운데 정렬된다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?statsEnv=disabled");
  await page
    .getByRole("group", { name: "소장품 등급" })
    .getByRole("button", { name: "SR" })
    .click();
  await page.getByRole("button", { name: "10단계", exact: true }).click();
  await page.getByLabel("상급자용 관리 키트").fill("100");
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

test("SR 10 다회 대성공 — 발생 회차 모달에서 기록할 수 있다", async ({ page }) => {
  await page
    .getByRole("group", { name: "소장품 등급" })
    .getByRole("button", { name: "SR" })
    .click();
  await page.getByRole("button", { name: "10단계", exact: true }).click();

  await page.getByLabel("상급자용 관리 키트").fill("100");
  await page.getByRole("button", { name: "계산", exact: true }).click();
  await page.getByRole("button", { name: "대성공 O", exact: true }).click();

  await expect(
    page.getByRole("heading", { name: "대성공이 발생한 시점을 입력해주세요." }),
  ).toBeVisible();
  await expect(page.locator(".attempt-number-input")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator(".attempt-step-button").first()).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator(".attempt-unknown-button")).toBeFocused();
  await page.getByLabel("대성공 발생 회차").fill("2");
  await page.getByRole("button", { name: "기록", exact: true }).click();

  await expect(page.getByText("대성공 시점이 기록되었습니다.")).toBeVisible({ timeout: 10_000 });
});

test("대성공 발생 회차 모달은 Escape로 닫고 다음 조작으로 focus를 돌린다", async ({ page }) => {
  await page
    .getByRole("group", { name: "소장품 등급" })
    .getByRole("button", { name: "SR" })
    .click();
  await page.getByRole("button", { name: "10단계", exact: true }).click();
  await page.getByLabel("상급자용 관리 키트").fill("100");
  await page.getByRole("button", { name: "계산", exact: true }).click();
  await page.getByRole("button", { name: "대성공 O", exact: true }).click();
  await expect(page.locator(".attempt-modal-overlay")).toBeVisible();

  await page.keyboard.press("Escape");

  await expect(page.locator(".attempt-modal-overlay")).toHaveCount(0);
  await expect(page.locator("button:focus")).toHaveCount(1);
});

test("R 15 — SR 등급 교체 안내와 적용이 동작한다", async ({ page }) => {
  await page.getByRole("button", { name: "15단계", exact: true }).click();

  await expect(page.getByText("SR 등급으로 교체")).toBeVisible();
  await expect(
    page.getByText("R 15레벨은 등급 교체 가능 상태입니다. SR 5레벨로 교체할 수 있습니다."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "교체 적용", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "교체 적용", exact: true }).click();

  await expect(page.locator(".state-panel .state-feedback-badge")).toHaveText(/R → SR/);
  await expect(page.getByText(/SR 등급으로 교체했습니다/)).toBeVisible();
  await expect(page.getByText(/SR 5레벨/)).toBeVisible();
});

test("SR 15 — 최종 목표 상태 문구가 정상 한글로 표시된다", async ({ page }) => {
  await page
    .getByRole("group", { name: "소장품 등급" })
    .getByRole("button", { name: "SR" })
    .click();
  await page.getByRole("button", { name: "15단계", exact: true }).click();

  await expect(page.getByText("SR 15레벨입니다. 최종 목표 상태입니다.")).toBeVisible();
  await expect(page.getByText("SR 15레벨은 최종 목표 상태입니다.")).toBeVisible();
});

test("테마 선택 — 다크/라이트 버튼이 body 테마 클래스를 바꾼다", async ({ page }) => {
  const themeGroup = page.getByRole("group", { name: "테마 선택" });
  const body = page.locator("body");
  const html = page.locator("html");

  await page.evaluate(() => {
    const startViewTransition = document.startViewTransition.bind(document);
    document.startViewTransition = (update) => {
      document.documentElement.dataset.themeViewTransition = "started";
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
        document.documentElement.dataset.unexpectedViewTransition = "called";
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

test("테마 선택 — 계산 패널은 다크 모드에서 어두운 배경을 유지한다", async ({ page }) => {
  const themeGroup = page.getByRole("group", { name: "테마 선택" });
  const calculatePanel = page
    .locator("section", {
      has: page.getByRole("heading", { name: "계산", exact: true }),
    })
    .last();

  await themeGroup.getByRole("button", { name: "다크", exact: true }).click();
  await expect.poll(() => maxBackgroundChannel(calculatePanel)).toBeLessThan(90);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => maxBackgroundChannel(calculatePanel)).toBeLessThan(90);
});

test("demoStats=1 — 전체 통계 주요 섹션이 표시된다", async ({ page }) => {
  await page.goto("/?demoStats=1");

  await expect(page.getByRole("heading", { name: "전체 통계" })).toBeVisible();
  await expect(page.getByText("전체 대성공률")).toBeVisible();
  await expect(page.getByText("키트별 대성공률")).toBeVisible();
  await expect(page.getByText("구간별 체감 난이도")).toBeVisible();
  await expect(page.locator(".kit-rate-row")).toHaveCount(3);
  await expect(page.locator(".difficulty-row")).toHaveCount(6);
  await expect(page.getByText("누적 입력 표본", { exact: true })).toBeVisible();
  await expect(page.locator(".overall-stats-window")).toHaveCount(1);
  await expect(page.locator(".stats-vs-card")).toHaveCount(3);
  await expect(page.getByText("실측 대성공률", { exact: true })).toBeVisible();
  await expect(page.getByText("실측 - 기대값", { exact: true })).toBeVisible();
  await expect(page.getByText("최근 30일 체감", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/현재 확률표 기준으로 계산한 입력 표본 통계입니다/)).toHaveCount(0);
  await expect(page.locator(".kit-rate-meta").first()).toContainText(/\d+시도/);
  await expect(page.locator(".kit-rate-meta").first()).not.toContainText(/실측|기대값/);
  await expect(page.getByText("결과 입력 표본 기준 · 이벤트 단위 집계")).toBeVisible();
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

test("staging 설정이 있으면 별도 통계 API와 테스트 배너를 사용한다", async ({ page }) => {
  let requestedStatsUrl = "";
  await serveStagingDocument(page, {
    endpoint: "https://staging.example.test",
    turnstileSiteKey: "staging-site-key",
  });
  await page.route("https://staging.example.test/api/stats", async (route) => {
    requestedStatsUrl = route.request().url();
    await route.fulfill({
      status: 500,
      headers: { "Access-Control-Allow-Origin": "http://127.0.0.1:4173" },
      body: "",
    });
  });

  await page.goto("/?statsEnv=staging");

  await expect(page.getByLabel("스테이징 환경")).toContainText(
    "테스트 기록은 운영 통계에 반영되지 않음",
  );
  await expect.poll(() => requestedStatsUrl).toBe("https://staging.example.test/api/stats");
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

  await expect(page.getByText("Collectibles Leveling up Optimizer")).toHaveCount(0);
  await expect(page.getByText("테마", { exact: true })).toHaveCount(0);
  await expect(page.getByText("1~5", { exact: true })).toHaveCount(0);
  await expect(page.getByText("6~10", { exact: true })).toHaveCount(0);
  await expect(page.getByText("11~15", { exact: true })).toHaveCount(0);
  await expect(page.locator(".difficulty-row")).toHaveCount(6);
  await expect(page.locator(".difficulty-comparison")).not.toHaveCount(0);
  await expect(
    page.getByText(/기대 대비 높음|기대 대비 낮음|기대 범위 내|표본 부족/).first(),
  ).toBeVisible();
});

test("검산 버튼 — 가상의 니붕이 검산 결과가 표시된다", async ({ page }) => {
  await page
    .getByRole("group", { name: "소장품 등급" })
    .getByRole("button", { name: "SR" })
    .click();
  await page.getByRole("button", { name: "10단계", exact: true }).click();
  await page.getByLabel("상급자용 관리 키트").fill("100");
  await page.getByRole("button", { name: "계산", exact: true }).click();

  await page.getByText("가상의 니붕이로 검증해보기").click();
  await page.getByRole("button", { name: /니붕이들 시켜보기|다시 시켜보기/ }).click();

  await expect(page.getByText(/이번엔 가상의 니붕이 .*SR 15/)).toBeVisible({ timeout: 20_000 });
});
test("모바일 탭은 입력, 결과, 통계 화면을 전환한다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?demoStats=1");

  await expect(page.getByRole("heading", { name: "현재 소장품" })).toBeVisible();

  await page.getByRole("tab", { name: "통계" }).click();
  await expect(page.getByRole("heading", { name: "전체 통계" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "현재 소장품" })).toBeHidden();

  await page.getByRole("tab", { name: "결과" }).click();
  await expect(page.getByRole("heading", { name: "결과" })).toBeVisible();

  await page.getByRole("tab", { name: "입력" }).click();
  await expect(page.getByRole("heading", { name: "현재 소장품" })).toBeVisible();
});

test("모바일 하단 액션바로 계산하고 결과 액션을 표시한다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?statsEnv=disabled");

  await page.getByLabel("초심자용 관리 키트").fill("100");

  const actionBar = page.getByRole("toolbar", { name: "모바일 작업" });
  await actionBar.getByRole("button", { name: "계산하기", exact: true }).click();

  await expect(page.getByRole("tab", { name: "결과" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("추천 행동")).toBeVisible({ timeout: 20_000 });
  await expect(actionBar.getByText("대성공 여부를 선택하세요")).toBeVisible();
  await expect(actionBar.locator(".change-note")).toBeVisible();
  await expect(actionBar.getByRole("button", { name: "대성공 O", exact: true })).toBeVisible();
  await expect(actionBar.getByRole("button", { name: "대성공 X", exact: true })).toBeVisible();
});

test("대성공 X 선택 후 다음 추천이 자동 계산된다", async ({ page }) => {
  await page.getByLabel("초심자용 관리 키트").fill("100");
  await page.getByRole("button", { name: "계산", exact: true }).click();
  await expect(page.getByRole("heading", { name: "대성공 여부" })).toBeVisible({
    timeout: 20_000,
  });

  await expect(page.locator(".next-action-previous")).toHaveCount(0);

  await page.getByRole("button", { name: "대성공 X", exact: true }).click();

  await expect(page.getByText("적용 완료")).toBeHidden({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "대성공 여부" })).toBeVisible();
  await expect(page.locator(".next-action-previous")).toHaveCount(1);
  await expect(page.locator(".next-action-current")).toHaveCount(1);
});

test("모바일 결과 탭에서는 대성공 버튼이 하단 액션바에만 표시된다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?statsEnv=disabled");

  await page.getByLabel("초심자용 관리 키트").fill("100");
  await page
    .getByRole("toolbar", { name: "모바일 작업" })
    .getByRole("button", { name: "계산하기", exact: true })
    .click();

  await expect(page.getByText("추천 행동")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".result-panel .outcome-panel")).toBeHidden();
  await expect(
    page.getByRole("toolbar", { name: "모바일 작업" }).getByText("대성공 여부를 선택하세요"),
  ).toBeVisible();
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

  await page.getByLabel("초심자용 관리 키트").fill("100");
  const actionBar = page.getByRole("toolbar", { name: "모바일 작업" });
  await actionBar.getByRole("button", { name: "계산하기", exact: true }).click();
  await expect(page.getByText("추천 행동")).toBeVisible({ timeout: 20_000 });
  await actionBar.getByRole("button", { name: "대성공 O", exact: true }).click();

  await expect(page.getByRole("tab", { name: "입력" })).toHaveAttribute("aria-selected", "true");

  await expect(actionBar.getByRole("button", { name: "키트 수정 필요", exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    actionBar.getByRole("button", { name: "키트 수정 필요", exact: true }),
  ).toBeDisabled();
  await expect(page.locator("#stockEditNotice")).toBeVisible();
});

test("mobile convert button keeps the input tab selected", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?statsEnv=disabled");

  await page.locator(".level-button").nth(15).click();
  await page.locator(".mobile-action-bar .convert-button").click();

  await expect(page.locator(".mobile-tab").first()).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".status-grade")).toHaveText("SR");
  await expect(page.locator(".status-level")).toHaveText("Lv 5");
});

test("mobile 520px difficulty tooltip stays inside viewport", async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 900 });
  await page.goto("/?demoStats=1");
  await page.locator(".mobile-tab").nth(2).click();

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
    await expect(tooltip).toHaveAttribute("id", "difficultyIntervalTooltip");
    await expect(tooltip).toContainText("횟수가 적으면 우연히 결과가 좋거나 나쁠 수 있습니다.");
    const rect = await tooltip.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right };
    });
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(520);
  }
});

test("desktop difficulty interval click does not move tooltip position", async ({ page }) => {
  await page.setViewportSize({ width: 1365, height: 900 });
  await page.goto("/?demoStats=1");

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

test("privacy notice is desktop footer and mobile stats-only footer", async ({ page }) => {
  await page.goto("/?demoStats=1");
  await expect(page.locator("footer:visible")).toHaveCount(1);
  await expect(page.getByText("계산 모드")).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?demoStats=1");
  await expect(page.locator("footer:visible")).toHaveCount(0);

  await page.locator(".mobile-tab").nth(2).click();
  await expect(page.locator("footer:visible")).toHaveCount(1);
});

test("mobile info-tip text stays inside its bubble", async ({ page }) => {
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
  await infoTip.focus();

  const textBox = infoTip.locator("span");
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

test("staging uses the production solver behavior and isolated stats endpoint", async ({
  page,
}) => {
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
