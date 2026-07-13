import { expect, type Locator, type Page } from "@playwright/test";
import { type PreviewServer, preview } from "vite";
import { test } from "./test";

const PORT = 4176;
let previewServer: PreviewServer | null = null;

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
  await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);
  await expect(page.getByRole("button", { name: "0단계", exact: true })).toBeVisible();
});

async function confirmOutcome(page: Page, locator: Locator, outcome: "대성공 O" | "대성공 X") {
  await locator.click();
  await page
    .getByRole("button", { name: `${outcome} 확정`, exact: true })
    .first()
    .click();
}

test("보유 키트 입력값이 실제로 바뀌지 않으면 직전 결과를 stale로 바꾸지 않는다", async ({
  page,
}) => {
  await page.getByLabel("초심자용 키트").fill("100");
  await page.getByRole("button", { name: "계산", exact: true }).click();

  await expect(page.locator(".next-action .action-label").first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("heading", { name: "대성공 여부" })).toBeVisible();

  const blueStock = page.getByLabel("초심자용 키트");
  await blueStock.focus();
  await blueStock.blur();

  await expect(
    page.getByText("소장품 상태가 변경되었습니다. 계산 버튼을 눌러 결과를 갱신해주세요."),
  ).toHaveCount(0);
  await expect(
    page.getByText("보유 키트가 변경되었습니다. 계산 버튼을 눌러 결과를 갱신해주세요."),
  ).toBeHidden();
  await expect(page.getByRole("heading", { name: "대성공 여부" })).toBeVisible();
});

test("R 10 대성공 O로 R 15에 도달하면 SR 5 교체 후 키트 수정이 필요하다", async ({ page }) => {
  await page.getByRole("button", { name: "10단계", exact: true }).click();
  await page.getByLabel("초심자용 키트").fill("100");
  await page.getByRole("button", { name: "계산", exact: true }).click();
  await expect(page.locator(".next-action .action-label").first()).toBeVisible({
    timeout: 20_000,
  });

  await confirmOutcome(
    page,
    page.getByRole("button", { name: "대성공 O", exact: true }).first(),
    "대성공 O",
  );

  await expect(page.getByText("SR 등급으로 교체")).toBeVisible();
  await expect(page.locator("#stockEditNotice")).toBeHidden();

  await page.getByRole("button", { name: "교체 적용", exact: true }).click();

  await expect(page.locator(".current-state-strip")).toContainText("SR");
  await expect(page.locator(".current-state-strip")).toContainText("5단계");
  await expect(page.locator("#stockEditNotice")).toContainText(
    "보유 키트를 수정한 뒤 계산 버튼을 눌러 진행해주세요.",
  );
  await expect(page.getByRole("button", { name: "키트 수정 필요", exact: true })).toBeDisabled();
});

test("모바일 R 10 대성공 O는 결과 탭에 SR 5 교체 버튼을 먼저 표시한다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "10단계", exact: true }).click();
  await page.getByLabel("초심자용 키트").fill("100");

  const actionBar = page.getByRole("toolbar", { name: "모바일 작업" });
  await actionBar.getByRole("button", { name: "계산하기", exact: true }).click();
  await expect(page.locator(".next-action .action-label").first()).toBeVisible({
    timeout: 20_000,
  });

  await confirmOutcome(
    page,
    actionBar.getByRole("button", { name: "대성공 O", exact: true }),
    "대성공 O",
  );

  await expect(page.getByRole("tab", { name: "결과" })).toHaveAttribute("aria-selected", "true");
  await expect(
    actionBar.getByRole("button", { name: "SR 등급으로 교체", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#stockEditNotice")).toBeHidden();

  await actionBar.getByRole("button", { name: "SR 등급으로 교체", exact: true }).click();

  await expect(page.getByRole("tab", { name: "입력" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".status-grade")).toHaveText("SR");
  await expect(page.locator(".status-level")).toHaveText("5단계");
  await expect(page.locator("#stockEditNotice")).toContainText(
    "보유 키트를 수정한 뒤 계산 버튼을 눌러 진행해주세요.",
  );
  await expect(
    actionBar.getByRole("button", { name: "키트 수정 필요", exact: true }),
  ).toBeDisabled();
});

test("SR 단회 대성공이 SR 15에 도달하면 키트 수정 잠금 없이 완료 안내를 표시한다", async ({
  page,
}) => {
  await page
    .getByRole("group", { name: "소장품 등급" })
    .getByRole("button", { name: "SR" })
    .click();
  await page.getByRole("button", { name: "14단계", exact: true }).click();

  await page.getByLabel("상급자용 키트").fill("10");
  await page.getByRole("button", { name: "계산", exact: true }).click();
  await expect(page.locator(".next-action .action-label").first()).toBeVisible({
    timeout: 20_000,
  });
  await confirmOutcome(
    page,
    page.getByRole("button", { name: "대성공 O", exact: true }).first(),
    "대성공 O",
  );

  await expect(page.getByLabel("상급자용 키트")).toHaveValue("10");
  await expect(page.locator("#stockEditNotice")).toBeHidden();
  await expect(page.getByText("최종 단계에 도달했습니다.")).toBeVisible();
  await expect(page.getByRole("button", { name: "키트 수정 필요", exact: true })).toHaveCount(0);
});
