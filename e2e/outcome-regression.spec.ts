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

async function pendingOutcomeGeometry(page: Page) {
  const panel = page.locator(".outcome-panel");
  await panel.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  return panel.evaluate((panel) => {
    const actions = panel.querySelector<HTMLElement>(".outcome-action-group");
    const buttons = [...panel.querySelectorAll<HTMLElement>(".outcome-buttons button")];
    if (!actions || buttons.length !== 2) throw new Error("Missing pending outcome controls.");
    const panelRect = panel.getBoundingClientRect();
    const actionsRect = actions.getBoundingClientRect();
    return {
      actionHeight: actionsRect.height,
      actionWidth: actionsRect.width,
      buttonHeights: buttons.map((button) => button.getBoundingClientRect().height),
      buttonWidths: buttons.map((button) => button.getBoundingClientRect().width),
      panelHeight: panelRect.height,
      panelWidth: panelRect.width,
    };
  });
}

function expectSameGeometry(
  left: Awaited<ReturnType<typeof pendingOutcomeGeometry>>,
  right: Awaited<ReturnType<typeof pendingOutcomeGeometry>>,
) {
  for (const key of ["actionHeight", "actionWidth", "panelHeight", "panelWidth"] as const) {
    expect(Math.abs(left[key] - right[key])).toBeLessThanOrEqual(1);
  }
  expect(left.buttonHeights).toEqual(right.buttonHeights);
  expect(left.buttonWidths).toEqual(right.buttonWidths);
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

test("모든 키트의 단회 대성공은 팝업 없이 재고를 차감하고 다음 상태를 계산한다", async ({
  page,
}) => {
  for (const kitLabel of ["초심자용 키트", "중급자용 키트", "상급자용 키트"]) {
    await page.goto(`http://127.0.0.1:${PORT}/?statsEnv=disabled`);
    await page.getByLabel(kitLabel).fill("10");
    await page.getByRole("button", { name: "계산", exact: true }).click();
    await expect(page.locator(".next-action .action-label").first()).toBeVisible({
      timeout: 20_000,
    });

    await confirmOutcome(
      page,
      page.getByRole("button", { name: "대성공 O", exact: true }).first(),
      "대성공 O",
    );

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByLabel(kitLabel)).toHaveValue("");
    await expect(page.getByRole("button", { name: "5단계", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("#stockEditNotice")).toBeHidden();
  }
});

test("R 10 다회 대성공은 회차를 선택하면 정확한 재고로 R 15를 적용한다", async ({ page }) => {
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

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const secondAttempt = dialog.getByRole("button", { name: /2회차에 대성공 80개/ });
  await expect(secondAttempt.locator("strong")).toHaveText("2회차에 대성공");
  await secondAttempt.click();

  await expect(page.getByText("SR 등급으로 교체")).toBeVisible();
  await expect(page.getByLabel("초심자용 키트")).toHaveValue("80");
  await expect(page.locator("#stockEditNotice")).toBeHidden();

  await page.getByRole("button", { name: "교체 적용", exact: true }).click();

  await expect(page.locator(".current-state-strip")).toContainText("SR");
  await expect(page.locator(".current-state-strip")).toContainText("5단계");
  await expect(page.locator("#stockEditNotice")).toBeHidden();
  await expect(page.getByRole("button", { name: "키트 수정 필요", exact: true })).toHaveCount(0);
});

test("모바일 R 10 다회 대성공도 SR 5 교체 후 자동 계산한다", async ({ page }) => {
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

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /1회차에 대성공 90개/ }).click();

  await expect(page.getByRole("tab", { name: "결과" })).toHaveAttribute("aria-selected", "true");
  await expect(
    actionBar.getByRole("button", { name: "SR 등급으로 교체", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#stockEditNotice")).toBeHidden();

  await actionBar.getByRole("button", { name: "SR 등급으로 교체", exact: true }).click();

  await expect(page.getByRole("tab", { name: "결과" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".status-grade")).toHaveText("SR");
  await expect(page.locator(".status-level")).toHaveText("5단계");
  await expect(page.locator("#stockEditNotice")).toBeHidden();
  await expect(page.locator(".next-action .action-label").first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(actionBar.getByRole("button", { name: "키트 수정 필요", exact: true })).toHaveCount(
    0,
  );
});

async function prepareSr14TerminalSuccess(page: Page) {
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
}

test("SR 단회 대성공은 회차 입력 없이 재고 차감 후 SR 15까지 자동 계산한다", async ({ page }) => {
  await prepareSr14TerminalSuccess(page);

  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("상급자용 키트")).toHaveValue("");
  await expect(page.locator("#stockEditNotice")).toBeHidden();
  await expect(page.getByRole("button", { name: "15단계", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByText("완료 상태입니다.")).toBeVisible();
  await expect(page.getByRole("button", { name: "키트 수정 필요", exact: true })).toHaveCount(0);
});

async function prepareR10MultiSuccess(page: Page) {
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
}

test("R 15 회차 입력을 취소하면 키트 수량을 유지하고 교체 후 수정을 요구한다", async ({ page }) => {
  await prepareR10MultiSuccess(page);

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "취소", exact: true }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("초심자용 키트")).toHaveValue("100");
  await expect(page.getByRole("button", { name: "15단계", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "교체 적용", exact: true }).click();
  await expect(page.locator("#stockEditNotice")).toContainText(
    "보유 키트를 수정한 뒤 계산 버튼을 눌러 진행해주세요.",
  );
});

test("다회 회차 입력 팝업 바깥을 누르면 취소와 동일하게 처리한다", async ({ page }) => {
  await prepareR10MultiSuccess(page);

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.click({ position: { x: 4, y: 4 } });

  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("초심자용 키트")).toHaveValue("100");
  await expect(page.getByRole("button", { name: "15단계", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByText("SR 등급으로 교체")).toBeVisible();
});

test("태블릿과 PC에서 대성공 O/X 확정 상태의 패널과 버튼 크기가 같다", async ({ page }) => {
  for (const locale of ["ko", "ja", "en"] as const) {
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
      key: "collection-kit-calculator.language",
      value: locale,
    });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await page.locator('[data-grade="R"]').click();
    await page.locator('[data-level="14"]').click();
    await page.locator("#blueStock").fill("100");
    await page.locator("#purpleStock").fill("20");
    await page.locator("#yellowStock").fill("20");
    await page.locator("#calculateButton").click();
    await expect(page.locator(".outcome-panel")).toBeVisible({ timeout: 20_000 });

    for (const width of [768, 1100]) {
      await page.setViewportSize({ width, height: 900 });
      const initialGeometry = await pendingOutcomeGeometry(page);
      await page.locator(".outcome-panel .success-button").click();
      const successGeometry = await pendingOutcomeGeometry(page);
      await page.locator(".outcome-panel .outcome-buttons button").nth(1).click();
      await page.locator(".outcome-panel .fail-button").click();
      const failGeometry = await pendingOutcomeGeometry(page);
      expectSameGeometry(initialGeometry, successGeometry);
      expectSameGeometry(initialGeometry, failGeometry);
      expectSameGeometry(successGeometry, failGeometry);
      await page.locator(".outcome-panel .outcome-buttons button").nth(0).click();
    }
  }
});
