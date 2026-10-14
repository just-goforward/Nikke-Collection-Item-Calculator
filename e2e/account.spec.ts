import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { type PreviewServer, preview } from "vite";
import {
  accountTrigger,
  beginnerKit,
  blockExternalRequests,
  CERTIFIED_PATH,
  type CertifiedItem,
  calculatorDocument,
  certifiedApi,
  certifiedBlue,
  certifiedItems,
  checkingIndicator,
  deviceStores,
  enableAccountFlag,
  guestCertifiedBlue,
  holdAccountCheck,
  loginButton,
  MockAccountApi,
  ORIGIN,
  openApp,
  openCertified,
  openCertifiedAccount,
  PORT,
  setBeginnerKit,
  setCertifiedBlue,
  signedInApi,
} from "./account.helpers";
import { closePreviewServer, test } from "./test";

// Defaults to the regular build; a separate output directory can be supplied for isolated runs.
const OUT_DIR = process.env["ACCOUNT_E2E_DIST"] ?? "dist";
let server: PreviewServer | null = null;

async function axeViolations(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return result.violations;
}

test.beforeAll(async () => {
  server = await preview({
    configFile: false,
    root: process.cwd(),
    base: "/",
    build: { outDir: OUT_DIR },
    preview: { host: "127.0.0.1", port: PORT, strictPort: true },
  });
});

test.afterAll(async () => {
  await closePreviewServer(server);
  server = null;
});

test("account UI and its chunk stay off without the staging flag", async ({ page, context }) => {
  const api = new MockAccountApi();
  await blockExternalRequests(context);
  await api.install(context);
  const chunks: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("AccountEntry")) chunks.push(request.url());
  });
  await openApp(page);
  await expect(page.locator("[data-account-trigger]")).toHaveCount(0);
  await expect(page.locator("[data-account-checking]")).toHaveCount(0);
  await expect(beginnerKit(page)).toBeEnabled();
  await openCertified(page);
  await expect(page.locator("[data-account-trigger]")).toHaveCount(0);
  expect(api.requests).toEqual([]);
  expect(chunks).toEqual([]);
  // No account code ran: no device database was opened and no tab lock was taken.
  const traces = await page.evaluate(async () => ({
    databases: (await indexedDB.databases()).map((entry) => entry.name),
    locks: ((await navigator.locks.query()).held ?? []).map((lock) => lock.name),
  }));
  expect(traces.databases).not.toContain("collection-kit-account");
  expect(traces.locks.filter((name) => name?.startsWith("collection-kit-account"))).toEqual([]);
});

test("guest sign-in, first-login consent, synced edits and logout keep data separate", async ({
  page,
  context,
}) => {
  const api = new MockAccountApi();
  await api.install(context);
  await context.addCookies([{ name: "e2e_session", value: "opaque", url: ORIGIN }]);
  await enableAccountFlag(page);
  await openApp(page);
  await setBeginnerKit(page, "73");
  await loginButton(page).click();
  await page.waitForURL(/^https:\/\/accounts\.google\.com\//);
  const login = api.requests.find((entry) => entry.path === "/auth/login/google");
  expect(login).toMatchObject({ method: "POST", body: {} });
  expect(login?.headers["content-type"]).toBe("application/json");

  // The callback bridge has completed; the HttpOnly session now belongs to user-a.
  api.userId = "user-a";
  await openApp(page);
  const consent = page.getByRole("dialog", { name: "공개 주간 통계 참여" });
  await expect(consent).toBeVisible();
  await expect(consent.getByRole("heading", { name: "공개 주간 통계 참여" })).toBeFocused();
  await consent.getByRole("button", { name: "참여하지 않기" }).click();
  await expect(consent).toBeHidden();
  const consentPut = api.requests.find(
    (entry) => entry.method === "PUT" && entry.path === "/v1/consent",
  );
  expect(consentPut?.headers["if-account-match"]).toBe('"user-a"');
  expect(consentPut?.body).toMatchObject({ participation: false, baseDecisionVersion: 0 });

  await expect(beginnerKit(page)).not.toHaveValue("73");
  await setBeginnerKit(page, "41");
  await expect.poll(() => api.puts().length).toBe(1);
  const [put] = api.puts();
  expect(put?.headers["if-account-match"]).toBe('"user-a"');
  expect(put?.body).toMatchObject({
    baseRevision: 0,
    action: { kind: "save" },
    document: {
      schemaVersion: 1,
      items: [{ type: "calculator-input", input: { stock: { blue: 41 } } }],
    },
  });
  expect(String(put?.body?.["opId"])).toMatch(/^[A-Za-z0-9_-]{1,128}$/);

  await expect(accountTrigger(page)).toHaveAccessibleName("계정 · 동기화됨");
  await accountTrigger(page).focus();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("dialog", { name: "계정", exact: true });
  await expect(panel.getByRole("button", { name: "닫기" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(accountTrigger(page)).toBeFocused();

  await accountTrigger(page).click();
  await panel.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(loginButton(page)).toBeVisible();
  await expect(beginnerKit(page)).toHaveValue("73");
  await expect(page.getByRole("status").filter({ hasText: "로그아웃했습니다." })).toBeVisible();
  const stores = await deviceStores(page);
  expect(stores.guest).toHaveLength(1);
  expect(stores.accounts).toEqual([]);
  for (const entry of api.requests) expect(entry.headers["cookie"]).toContain("e2e_session=opaque");
  const workspaceRead = api.requests.find(
    (entry) => entry.method === "GET" && entry.path === "/v1/workspace",
  );
  expect(workspaceRead?.headers["if-account-match"]).toBe('"user-a"');
});

test("revision conflicts offer cancel, overwrite and keep-server choices", async ({
  page,
  context,
}) => {
  const api = signedInApi(10, 3);
  await api.install(context);
  await enableAccountFlag(page);
  await openApp(page);
  await expect(beginnerKit(page)).toHaveValue("10");

  api.revision = 4;
  api.document = calculatorDocument(20);
  await setBeginnerKit(page, "30");
  const conflict = page.getByRole("dialog", { name: "작업 공간이 다른 곳에서 변경되었습니다" });
  await expect(conflict.getByRole("region", { name: "서버 버전 (버전 4)" })).toContainText("20");
  await expect(conflict.getByRole("region", { name: "이 기기의 버전" })).toContainText("30");
  await conflict.getByRole("button", { name: "취소 (동기화 일시 중지)" }).click();
  await expect(conflict).toBeHidden();
  await expect(accountTrigger(page)).toHaveAccessibleName(/^계정 · 동기화 일시 중지됨/);

  await accountTrigger(page).click();
  const panel = page.getByRole("dialog", { name: "계정", exact: true });
  await panel.getByRole("button", { name: "충돌 해결" }).click();
  await conflict.getByRole("button", { name: "이 기기 버전으로 덮어쓰기" }).click();
  await expect.poll(() => api.revision).toBe(5);
  expect(api.puts().at(-1)?.body).toMatchObject({ baseRevision: 4 });
  expect(api.document).toEqual(calculatorDocument(30));
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();

  api.revision = 6;
  api.document = calculatorDocument(60);
  await setBeginnerKit(page, "35");
  await conflict.getByRole("button", { name: "서버 버전 유지" }).click();
  await expect(beginnerKit(page)).toHaveValue("60");
  await expect(accountTrigger(page)).toHaveAccessibleName("계정 · 동기화됨");
  expect(api.revision).toBe(6);
});

test("quota, archiving-blocked, stale and missing account context are explained", async ({
  page,
  context,
}) => {
  const api = signedInApi(10);
  api.quota = { bytes: 1_500_000, limitBytes: 1_500_000, newArchivingBlocked: true };
  await api.install(context);
  await enableAccountFlag(page);
  await openApp(page);
  await accountTrigger(page).click();
  const panel = page.getByRole("dialog", { name: "계정", exact: true });
  await expect(panel).toContainText("1.50 MB / 1.50 MB 사용 (100.0%)");
  await expect(panel).toContainText(
    "새 기록 보관이 중단되었습니다. 기존 데이터는 모두 그대로 보존되며",
  );
  await panel.getByRole("button", { name: "닫기" }).click();

  api.nextPutError = { status: 409, error: "account_context_stale" };
  await setBeginnerKit(page, "11");
  const alert = page.getByRole("alert").filter({ hasText: "현재 로그인된 계정과 다릅니다" });
  await expect(alert).toBeVisible();
  await expect(alert.getByRole("button", { name: "새로고침" })).toBeVisible();
  // A stale tab is read-only: no edit can be made that would be stored nowhere.
  await expect(beginnerKit(page)).toBeDisabled();
  await page.waitForTimeout(2_000);
  expect(api.puts()).toHaveLength(1);

  // After a reload the edit made before the tab went stale is recovered from the device and sent.
  api.nextPutError = { status: 428, error: "account_context_required" };
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "계정 확인 정보가 없어" })).toBeVisible();
  await expect(beginnerKit(page)).toHaveValue("11");
  await expect(beginnerKit(page)).toBeDisabled();
  expect(api.puts().at(-1)?.body).toMatchObject({ baseRevision: 1 });
});

test("export downloads JSON and deletion needs explicit confirmation", async ({
  page,
  context,
}) => {
  const api = signedInApi(10);
  await api.install(context);
  await enableAccountFlag(page);
  await openApp(page);
  await accountTrigger(page).click();
  const panel = page.getByRole("dialog", { name: "계정", exact: true });
  const downloadEvent = page.waitForEvent("download");
  await panel.getByRole("button", { name: "데이터 내보내기 (JSON)" }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(
    /^collection-kit-account-export-\d{4}-\d{2}-\d{2}\.json$/,
  );
  expect(JSON.parse(await readFile(await download.path(), "utf8"))).toEqual({
    schemaVersion: 1,
    account: { userId: "user-a" },
    exportedAt: 1,
    workspace: { userId: "user-a", revision: 1 },
  });
  const exportRead = api.requests.find((entry) => entry.path === "/v1/export");
  expect(exportRead?.headers["if-account-match"]).toBe('"user-a"');

  await panel.getByRole("button", { name: "계정 삭제…" }).click();
  const confirm = page.getByRole("dialog", { name: "계정을 영구 삭제할까요?" });
  const deleteButton = confirm.getByRole("button", { name: "계정 영구 삭제" });
  await expect(deleteButton).toBeDisabled();
  await confirm.getByLabel("되돌릴 수 없다는 것을 이해했습니다").check();
  await deleteButton.click();
  await expect(loginButton(page)).toBeVisible();
  const deletion = api.requests.find((entry) => entry.method === "DELETE");
  expect(deletion?.headers["if-account-match"]).toBe('"user-a"');
  expect(String(deletion?.body?.["opId"])).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  await expect(page.getByRole("status").filter({ hasText: "계정을 삭제했습니다." })).toBeVisible();
  expect((await deviceStores(page)).accounts).toEqual([]);
});

test("consent and account dialogs have no WCAG A/AA violations", async ({ page, context }) => {
  const api = signedInApi(10);
  api.consent = { participation: null, decisionVersion: 0 };
  await api.install(context);
  await enableAccountFlag(page);
  await openApp(page);
  const axe = () =>
    new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  await expect(page.getByRole("dialog", { name: "공개 주간 통계 참여" })).toBeVisible();
  expect((await axe()).violations).toEqual([]);
  await page.getByRole("button", { name: "나중에 결정" }).click();
  await accountTrigger(page).click();
  await expect(page.getByRole("dialog", { name: "계정", exact: true })).toBeVisible();
  expect((await axe()).violations).toEqual([]);
});

test("tabs follow each other's saves and sign-out", async ({ context }) => {
  const api = signedInApi(10);
  await api.install(context);
  await enableAccountFlag(context);
  const first = await context.newPage();
  const second = await context.newPage();
  await openApp(first);
  await openApp(second);
  await expect(beginnerKit(second)).toHaveValue("10");

  await setBeginnerKit(first, "12");
  await expect(beginnerKit(second)).toHaveValue("12");

  await accountTrigger(first).click();
  await first
    .getByRole("dialog", { name: "계정", exact: true })
    .getByRole("button", { name: "로그아웃", exact: true })
    .click();
  await expect(loginButton(second)).toBeVisible();
  await expect(
    second.getByRole("status").filter({ hasText: "다른 탭이나 기기에서 로그아웃" }),
  ).toBeVisible();
  await expect(beginnerKit(second)).not.toHaveValue("12");
});

test("an empty account offers an explicit copy of the guest inputs", async ({ page, context }) => {
  const api = new MockAccountApi();
  api.consent = { participation: false, decisionVersion: 1 };
  await api.install(context);
  await enableAccountFlag(page);
  await openApp(page);
  await setBeginnerKit(page, "73");
  await loginButton(page).click();
  await page.waitForURL(/^https:\/\/accounts\.google\.com\//);
  api.userId = "user-a";
  await openApp(page);

  const offer = page.getByRole("region", { name: "이 계정에는 아직 저장된 입력이 없습니다" });
  await expect(offer.getByRole("region", { name: "게스트 입력" })).toContainText("73");
  await expect(beginnerKit(page)).not.toHaveValue("73");
  expect(await axeViolations(page)).toEqual([]);
  await page.waitForTimeout(2_000);
  expect(api.puts()).toEqual([]);

  await offer.getByRole("button", { name: "내 게스트 입력을 이 계정으로 복사" }).click();
  await expect(offer).toBeHidden();
  await expect(beginnerKit(page)).toHaveValue("73");
  await expect.poll(() => api.puts().length).toBe(1);
  expect(api.document).toEqual(calculatorDocument(73));
  await expect(
    page.getByRole("status").filter({ hasText: "게스트 입력을 이 계정으로 복사했습니다." }),
  ).toBeVisible();
  expect((await deviceStores(page)).guest).toHaveLength(1);
});

test("signing out with unsynced edits asks to keep (default) or delete them", async ({
  page,
  context,
}) => {
  const api = signedInApi(10);
  api.failPuts = true;
  await api.install(context);
  await enableAccountFlag(page);
  await openApp(page);
  await expect(beginnerKit(page)).toHaveValue("10");
  await setBeginnerKit(page, "19");
  await expect(accountTrigger(page)).toHaveAccessibleName(/^계정 · 연결 대기 중/);

  const signOut = async (keep: boolean) => {
    await accountTrigger(page).click();
    await page
      .getByRole("dialog", { name: "계정", exact: true })
      .getByRole("button", { name: "로그아웃", exact: true })
      .click();
    const choice = page.getByRole("dialog", { name: "저장되지 않은 변경 사항이 있습니다" });
    const keepOption = choice.getByLabel("다음 로그인까지 이 기기에 보관 (기본)");
    await expect(keepOption).toBeChecked();
    await expect(keepOption).toBeFocused();
    if (keep) expect(await axeViolations(page)).toEqual([]);
    else await choice.getByLabel("이 기기에서 삭제").check();
    await choice.getByRole("button", { name: "로그아웃", exact: true }).click();
    await expect(loginButton(page)).toBeVisible();
  };

  await signOut(true);
  await expect(
    page.getByRole("status").filter({ hasText: "다음 로그인까지 이 기기에 보관됩니다" }),
  ).toBeVisible();
  const kept = (await deviceStores(page)).accounts;
  expect(kept).toEqual([expect.objectContaining({ userId: "user-a", baseRevision: 1 })]);

  api.userId = "user-a";
  await openApp(page);
  await expect(beginnerKit(page)).toHaveValue("19");
  await signOut(false);
  await expect(
    page.getByRole("status").filter({ hasText: "이 기기에서 삭제했습니다" }),
  ).toBeVisible();
  expect((await deviceStores(page)).accounts).toEqual([]);
});

test("?account_error=<code> shows the localized message and is removed from the URL", async ({
  page,
  context,
}) => {
  const api = new MockAccountApi();
  await api.install(context);
  await enableAccountFlag(page);
  await page.goto(`${ORIGIN}/?account_error=admission_full&keep=1`);
  await expect(
    page.getByRole("status").filter({ hasText: "베타 정원이 가득 찼습니다." }),
  ).toBeVisible();
  await expect.poll(() => page.url()).toBe(`${ORIGIN}/?keep=1`);
  await expect(loginButton(page)).toBeVisible();

  await page.goto(`${ORIGIN}/en/?account_error=login_flow_expired`);
  await expect(
    page.getByRole("status").filter({ hasText: "The sign-in expired. Please sign in again." }),
  ).toBeVisible();
  await expect.poll(() => page.url()).toBe(`${ORIGIN}/en/`);

  await page.goto(`${ORIGIN}/ja/?account_error=something_new`);
  await expect(
    page.getByRole("status").filter({ hasText: "ログインを完了できませんでした。" }),
  ).toBeVisible();
});

// ---- certified engine ----

test("certified engine: the guest session keeps its key and the account session syncs as an item", async ({
  page,
  context,
}) => {
  const api = await certifiedApi(context);
  await enableAccountFlag(page);
  await openCertified(page);
  await setCertifiedBlue(page, "70");
  await expect.poll(() => guestCertifiedBlue(page)).toBe(70);
  await loginButton(page).click();
  await page.waitForURL(/^https:\/\/accounts\.google\.com\//);
  api.userId = "user-a";
  await openCertified(page);

  const offer = page.getByRole("region", { name: "이 계정에는 아직 저장된 입력이 없습니다" });
  await expect(offer.getByRole("region", { name: "게스트 입력" })).toContainText("70");
  await expect(certifiedBlue(page)).toHaveValue("");
  expect(api.puts()).toEqual([]);
  await offer.getByRole("button", { name: "내 게스트 입력을 이 계정으로 복사" }).click();
  await expect(certifiedBlue(page)).toHaveValue("70");
  await expect.poll(() => api.puts().length).toBe(1);
  expect(api.puts()[0]?.headers["if-account-match"]).toBe('"user-a"');
  expect(certifiedItems(api.document)).toEqual([
    expect.objectContaining({
      version: 1,
      session: expect.objectContaining({ stock: [70, 0, 0] }),
    }),
  ]);

  await setCertifiedBlue(page, "60");
  await expect.poll(() => api.puts().length).toBe(2);
  expect(certifiedItems(api.document)[0]?.session.stock).toEqual([60, 0, 0]);
  // Account edits never reach the guest storage key.
  expect(await guestCertifiedBlue(page)).toBe(70);
  // Synced: no device copy of the account session is kept.
  expect((await deviceStores(page)).certified).toEqual([]);

  await accountTrigger(page).click();
  const panel = page.getByRole("dialog", { name: "계정", exact: true });
  await expect(panel.getByTestId("account-item-size")).toHaveText(
    /^인증 계산 세션 크기: \d\.\d\d MB$/,
  );
  await panel.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(loginButton(page)).toBeVisible();
  await expect(certifiedBlue(page)).toHaveValue("70");
  expect(await guestCertifiedBlue(page)).toBe(70);
  expect((await deviceStores(page)).certified).toEqual([]);
});

test("certified conflicts show sizes and an unreadable server copy is never applied", async ({
  page,
  context,
}) => {
  const api = await certifiedApi(context);
  api.userId = "user-a";
  await enableAccountFlag(page);
  await openCertifiedAccount(page);
  await setCertifiedBlue(page, "20");
  await expect.poll(() => api.puts().length).toBe(1);

  const changed = structuredClone(api.document) as { items: CertifiedItem[] };
  const serverItem = certifiedItems(changed)[0];
  if (!serverItem) throw new Error("missing certified item");
  serverItem.session.stock = [50, 0, 0];
  api.document = changed;
  api.revision += 1;
  await setCertifiedBlue(page, "30");
  const conflict = page.getByRole("dialog", { name: "작업 공간이 다른 곳에서 변경되었습니다" });
  const server = conflict.getByRole("region", { name: /^서버 버전/ });
  await expect(server).toContainText("50");
  await expect(server).toContainText(/크기: \d\.\d\d MB/);
  await expect(conflict.getByRole("region", { name: "이 기기의 버전" })).toContainText("30");
  await conflict.getByRole("button", { name: "서버 버전 유지" }).click();
  await expect(certifiedBlue(page)).toHaveValue("50");
  await expect(accountTrigger(page)).toHaveAccessibleName("계정 · 동기화됨");

  const putsBefore = api.puts().length;
  api.document = {
    schemaVersion: 1,
    items: [{ type: "certified-session", version: 1, session: { stock: "bad" } }],
    lifetimeStages: [],
  };
  api.revision += 1;
  await openCertified(page);
  await expect(conflict).toBeVisible();
  await expect(conflict).toContainText("서버의 사본이 검증을 통과하지 못해 적용하지 않았습니다");
  await expect(conflict.getByRole("button", { name: "서버 버전 유지" })).toBeDisabled();
  await expect(certifiedBlue(page)).toHaveValue("");
  expect(await axeViolations(page)).toEqual([]);
  await page.waitForTimeout(2_000);
  expect(api.puts()).toHaveLength(putsBefore);

  await conflict.getByRole("button", { name: "이 기기 버전으로 덮어쓰기" }).click();
  await expect.poll(() => api.puts().length).toBe(putsBefore + 1);
  expect(certifiedItems(api.document)[0]?.session.stock).toEqual([0, 0, 0]);
});

test("certified tabs follow each other's saves", async ({ context }) => {
  const api = await certifiedApi(context);
  api.userId = "user-a";
  await enableAccountFlag(context);
  const first = await context.newPage();
  const second = await context.newPage();
  await openCertifiedAccount(first);
  await openCertifiedAccount(second);
  await setCertifiedBlue(first, "12");
  await expect(certifiedBlue(second)).toHaveValue("12");
  expect(api.puts()).toHaveLength(1);
});

// ---- page-load account check ----

test("inputs stay read-only until the account check resolves on the production engine", async ({
  page,
  context,
}) => {
  const api = signedInApi(10);
  const release = holdAccountCheck(api);
  await api.install(context);
  await enableAccountFlag(page);
  await page.setViewportSize({ width: 1365, height: 900 });
  await page.goto(`${ORIGIN}/`);
  await expect(checkingIndicator(page)).toBeVisible();
  await expect(beginnerKit(page)).toBeDisabled();
  await expect(page.getByRole("button", { name: "초기화", exact: true })).toBeDisabled();
  release();
  await expect(checkingIndicator(page)).toBeHidden();
  await expect(beginnerKit(page)).toBeEnabled();
  await expect(beginnerKit(page)).toHaveValue("10");
});

test("a slow account check falls back to guest data after 5 s; a late sign-in asks for a reload", async ({
  page,
  context,
}) => {
  const api = signedInApi(10);
  const release = holdAccountCheck(api);
  await api.install(context);
  await enableAccountFlag(page);
  await page.setViewportSize({ width: 1365, height: 900 });
  await page.goto(`${ORIGIN}/`);
  await expect(beginnerKit(page)).toBeDisabled();
  await expect(beginnerKit(page)).toBeEnabled({ timeout: 8_000 });
  await expect(checkingIndicator(page)).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: "계정 확인이 지연되어" })).toBeVisible();
  await setBeginnerKit(page, "33");
  release();
  await expect(
    page.getByRole("alert").filter({ hasText: "계정 확인이 늦게 완료되었습니다" }),
  ).toBeVisible();
  await expect(beginnerKit(page)).toHaveValue("33");
  expect(api.puts()).toEqual([]);
});

test("certified inputs stay read-only until the account check resolves", async ({
  page,
  context,
}) => {
  const api = await certifiedApi(context);
  api.userId = "user-a";
  api.document = {
    schemaVersion: 1,
    items: [],
    lifetimeStages: [],
  };
  const release = holdAccountCheck(api);
  await enableAccountFlag(page);
  await page.setViewportSize({ width: 1365, height: 900 });
  await page.goto(`${ORIGIN}${CERTIFIED_PATH}`);
  await expect(page.locator("main[data-engine-profile='certified-staging-v2']")).toBeVisible();
  await expect(checkingIndicator(page)).toBeVisible();
  await expect(certifiedBlue(page)).toBeDisabled();
  await expect(page.locator("#calculateButton")).toBeDisabled();
  release();
  await expect(checkingIndicator(page)).toBeHidden();
  await expect(certifiedBlue(page)).toBeEnabled();
  await expect(accountTrigger(page)).toHaveAccessibleName("계정 · 동기화됨");
});

test("switching between account and guest data clears the reset undo on the production engine", async ({
  page,
  context,
}) => {
  const api = signedInApi(10);
  await api.install(context);
  await enableAccountFlag(page);
  await openApp(page);
  await expect(beginnerKit(page)).toHaveValue("10");
  await page.getByRole("button", { name: "초기화", exact: true }).click();
  const undo = page.getByRole("button", { name: /되돌리기/ });
  await expect(undo).toBeVisible();
  await accountTrigger(page).click();
  await page
    .getByRole("dialog", { name: "계정", exact: true })
    .getByRole("button", { name: "로그아웃", exact: true })
    .click();
  await expect(loginButton(page)).toBeVisible();
  await expect(undo).toBeHidden();
  await expect(beginnerKit(page)).not.toHaveValue("10");
});

// ---- review fixes: bound reads, unavailable workspace, per-tab drafts ----

const contextStaleAlert = (page: Page) =>
  page.getByRole("alert").filter({ hasText: "현재 로그인된 계정과 다릅니다" });

test("a session switched between the account and workspace reads shows nothing and locks both engines", async ({
  page,
  context,
}) => {
  const api = signedInApi(10);
  api.switchAfterAccount = "user-b";
  await blockExternalRequests(context);
  await api.install(context);
  await enableAccountFlag(page);
  await page.setViewportSize({ width: 1365, height: 900 });
  await page.goto(`${ORIGIN}/`);
  await expect(contextStaleAlert(page)).toBeVisible();
  await expect(beginnerKit(page)).toBeDisabled();
  await expect(beginnerKit(page)).not.toHaveValue("10");
  const read = api.requests.find(
    (entry) => entry.method === "GET" && entry.path === "/v1/workspace",
  );
  expect(read?.headers["if-account-match"]).toBe('"user-a"');
  expect((await deviceStores(page)).accounts).toEqual([]);

  api.userId = "user-a";
  api.switchAfterAccount = "user-b";
  await page.goto(`${ORIGIN}${CERTIFIED_PATH}`);
  await expect(page.locator("main[data-engine-profile='certified-staging-v2']")).toBeVisible();
  await expect(contextStaleAlert(page)).toBeVisible();
  await expect(certifiedBlue(page)).toBeDisabled();
  await expect(page.locator("#calculateButton")).toBeDisabled();
});

test("a workspace that cannot load shows guest data as 'account not loaded' and retries", async ({
  page,
  context,
}) => {
  const api = signedInApi(10);
  api.failWorkspaceReads = 1;
  await api.install(context);
  await enableAccountFlag(page);
  await openApp(page);
  const retry = page.getByRole("button", {
    name: "계정 데이터를 불러오지 못했습니다. 다시 시도",
  });
  await expect(retry).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "계정 데이터를 불러오지 못해" }),
  ).toBeVisible();
  await expect(beginnerKit(page)).toBeEnabled();
  await expect(beginnerKit(page)).not.toHaveValue("10");
  await setBeginnerKit(page, "44");
  await retry.click();
  await expect(accountTrigger(page)).toHaveAccessibleName("계정 · 동기화됨");
  await expect(beginnerKit(page)).toHaveValue("10");
  expect(api.puts()).toEqual([]);
  // The edit made while the account was not loaded stayed guest data.
  await accountTrigger(page).click();
  await page
    .getByRole("dialog", { name: "계정", exact: true })
    .getByRole("button", { name: "로그아웃", exact: true })
    .click();
  await expect(beginnerKit(page)).toHaveValue("44");
});

type StoredDraft = {
  userId: string;
  document: { items: Array<{ input: { stock: { blue: number } } }> };
};

async function draftBlues(page: Page) {
  const drafts = (await deviceStores(page)).accounts as StoredDraft[];
  return drafts.map((draft) => draft.document.items[0]?.input.stock.blue).sort();
}

test("divergent unsynced edits in two tabs survive a reload", async ({ context }) => {
  const api = signedInApi(10);
  api.failPuts = true;
  await api.install(context);
  await enableAccountFlag(context);
  const first = await context.newPage();
  const second = await context.newPage();
  await openApp(first);
  await openApp(second);
  await setBeginnerKit(first, "11");
  await setBeginnerKit(second, "22");
  await expect(accountTrigger(first)).toHaveAccessibleName(/^계정 · 연결 대기 중/);
  await expect(accountTrigger(second)).toHaveAccessibleName(/^계정 · 연결 대기 중/);
  await expect.poll(() => draftBlues(first)).toEqual([11, 22]);

  await first.reload();
  await expect(beginnerKit(first)).toHaveValue("11");
  await expect(beginnerKit(second)).toHaveValue("22");
  await expect.poll(() => draftBlues(first)).toEqual([11, 22]);
});

test("unsynced copies from the previous device store version are recovered", async ({
  page,
  context,
}) => {
  const api = signedInApi(10);
  api.failPuts = true;
  await api.install(context);
  await openApp(page);
  await page.evaluate(async (document) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("collection-kit-account", 2);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("guest-workspace");
        request.result.createObjectStore("account-workspaces", { keyPath: "userId" });
        request.result.createObjectStore("account-certified-sessions", { keyPath: "userId" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("account-workspaces", "readwrite");
      const store = transaction.objectStore("account-workspaces");
      store.put({ userId: "user-a", baseRevision: 1, document, dirty: true, updatedAt: 1 });
      store.put({ userId: "user-b", baseRevision: 1, document, dirty: false, updatedAt: 1 });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }, calculatorDocument(19));
  await enableAccountFlag(page);
  await openApp(page);
  await expect(beginnerKit(page)).toHaveValue("19");
  await expect
    .poll(async () => (await deviceStores(page)).accounts)
    .toEqual([expect.objectContaining({ userId: "user-a", baseRevision: 1 })]);
});
