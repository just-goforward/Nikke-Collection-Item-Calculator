import { expect, test } from "@playwright/test";
import { type PreviewServer, preview } from "vite";

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
  await page.goto("/");
  await expect(page.getByRole("button", { name: "1단계", exact: true })).toBeVisible();
});

test("R 1 + 초심자용 100 — 계산 결과 패널에 추천 행동이 나타난다", async ({ page }) => {
  await page.getByLabel("초심자용 관리 키트").fill("100");
  await page.getByRole("button", { name: "계산", exact: true }).click();

  await expect(page.getByText("추천 행동")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "대성공 여부" })).toBeVisible();
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
  await expect(page.getByText(/\d+(?:\.\d+)?%/).first()).toBeVisible();
  await expect(page.getByRole("table").getByText(/\d+회/).first()).toBeVisible();
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
  await page.getByLabel("대성공 발생 회차").fill("2");
  await page.getByRole("button", { name: "기록", exact: true }).click();

  await expect(page.getByText("대성공 시점이 기록되었습니다.")).toBeVisible({ timeout: 10_000 });
});

test("R 15 — SR 등급 교체 안내와 적용이 동작한다", async ({ page }) => {
  await page.getByRole("button", { name: "15단계", exact: true }).click();

  await expect(page.getByText("SR 등급으로 교체")).toBeVisible();
  await expect(
    page.getByText("R 15레벨은 등급 교체 가능 상태입니다. SR 5레벨로 교체할 수 있습니다."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "교체 적용", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "교체 적용", exact: true }).click();

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

  await themeGroup.getByRole("button", { name: "다크", exact: true }).click();
  await expect(body).toHaveClass(/theme-dark/);

  await themeGroup.getByRole("button", { name: "라이트", exact: true }).click();
  await expect(body).toHaveClass(/theme-light/);
});

test("demoStats=1 — 전체 통계 주요 섹션이 표시된다", async ({ page }) => {
  await page.goto("/?demoStats=1");

  await expect(page.getByRole("heading", { name: "전체 통계" })).toBeVisible();
  await expect(page.getByText("전체 대성공률")).toBeVisible();
  await expect(page.getByText("구간별 체감 난이도")).toBeVisible();
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
