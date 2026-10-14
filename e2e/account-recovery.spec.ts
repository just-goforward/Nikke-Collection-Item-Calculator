import { expect, type Page } from "@playwright/test";
import { type PreviewServer, preview } from "vite";
import {
  accountTrigger,
  beginnerKit,
  blockExternalRequests,
  calculatorDocument,
  certifiedApi,
  certifiedBlue,
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
  PORT,
  setBeginnerKit,
  setCertifiedBlue,
  signedInApi,
} from "./account.helpers";
import { closePreviewServer, test } from "./test";

// Same build and port as e2e/account.spec.ts; Playwright runs the spec files one after another.
const OUT_DIR = process.env["ACCOUNT_E2E_DIST"] ?? "dist";
let server: PreviewServer | null = null;

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

const GOOGLE_URL = /^https:\/\/accounts\.google\.com\//;

/** A guest edits, starts signing in and cancels at Google: the inputs await restoring. */
async function cancelledSignIn(page: Page, blue: string) {
  await setBeginnerKit(page, blue);
  await loginButton(page).click();
  await page.waitForURL(GOOGLE_URL);
}

test("saved guest inputs are restored at the bound whether the account chunk or the check is slow", async ({
  page,
  context,
}) => {
  const api = new MockAccountApi();
  await blockExternalRequests(context);
  await api.install(context);
  await enableAccountFlag(page);
  await openApp(page);

  // Slow account chunk: the inputs stay read-only past the bound until it can restore them.
  await cancelledSignIn(page, "21");
  let releaseChunk: () => void = () => undefined;
  const chunk = new Promise<void>((resolve) => {
    releaseChunk = resolve;
  });
  await page.route("**/assets/AccountEntry-*.js", async (route) => {
    await chunk;
    await route.continue();
  });
  await openApp(page);
  await expect(checkingIndicator(page)).toBeVisible();
  await page.waitForTimeout(6_000);
  await expect(beginnerKit(page)).toBeDisabled();
  releaseChunk();
  await expect(beginnerKit(page)).toBeEnabled();
  await expect(beginnerKit(page)).toHaveValue("21");
  await page.unroute("**/assets/AccountEntry-*.js");

  // Slow account check: restored at the bound, then released.
  await cancelledSignIn(page, "31");
  const release = holdAccountCheck(api);
  await openApp(page);
  await expect(beginnerKit(page)).toBeDisabled();
  await expect(beginnerKit(page)).toBeEnabled({ timeout: 8_000 });
  await expect(beginnerKit(page)).toHaveValue("31");
  release();
  await expect(loginButton(page)).toBeEnabled();
  await expect(beginnerKit(page)).toHaveValue("31");
});

test("two tabs opening at once adopt a closed tab's unsynced draft only once", async ({
  context,
}) => {
  const api = signedInApi(10);
  await api.install(context);
  await enableAccountFlag(context);
  const seed = await context.newPage();
  await openApp(seed);
  await expect(accountTrigger(seed)).toHaveAccessibleName("계정 · 동기화됨");
  await seed.evaluate(async (document) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("collection-kit-account");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("account-drafts", "readwrite");
      transaction.objectStore("account-drafts").put({
        userId: "user-a",
        draftId: "closed-tab",
        baseRevision: 1,
        baseKey: null,
        document,
        updatedAt: 1,
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }, calculatorDocument(7));
  await seed.close();

  const first = await context.newPage();
  const second = await context.newPage();
  await Promise.all([openApp(first), openApp(second)]);
  const recovered = (page: Page) =>
    page.getByRole("status").filter({ hasText: "다른 탭에서 저장되지 않은 변경 사항을" }).count();
  await expect.poll(() => api.puts().length).toBe(1);
  await expect(beginnerKit(first)).toHaveValue("7");
  await expect(beginnerKit(second)).toHaveValue("7");
  expect((await recovered(first)) + (await recovered(second))).toBe(1);
  expect(api.puts()[0]?.body).toMatchObject({
    baseRevision: 1,
    document: { items: [{ input: { stock: { blue: 7 } } }] },
  });
  await expect.poll(async () => (await deviceStores(first)).accounts).toEqual([]);
  expect(api.puts()).toHaveLength(1);
});

test("certified engine: a workspace that cannot load shows the guest session as 'account not loaded'", async ({
  page,
  context,
}) => {
  const api = await certifiedApi(context);
  await enableAccountFlag(page);
  await openCertified(page);
  await setCertifiedBlue(page, "44");
  await expect.poll(() => guestCertifiedBlue(page)).toBe(44);

  api.userId = "user-a";
  api.failWorkspaceReads = 1;
  await openCertified(page);
  const retry = page.getByRole("button", {
    name: "계정 데이터를 불러오지 못했습니다. 다시 시도",
  });
  await expect(retry).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "계정 데이터를 불러오지 못해" }),
  ).toBeVisible();
  await expect(certifiedBlue(page)).toBeEnabled();
  await expect(certifiedBlue(page)).toHaveValue("44");
  await setCertifiedBlue(page, "45");
  await expect.poll(() => guestCertifiedBlue(page)).toBe(45);

  await retry.click();
  await expect(accountTrigger(page)).toHaveAccessibleName("계정 · 동기화됨");
  // The account has no certified session of its own: the guest session is never shown as it.
  await expect(certifiedBlue(page)).toHaveValue("");
  expect(api.puts()).toEqual([]);
  expect(await guestCertifiedBlue(page)).toBe(45);
  await accountTrigger(page).click();
  await page
    .getByRole("dialog", { name: "계정", exact: true })
    .getByRole("button", { name: "로그아웃", exact: true })
    .click();
  await expect(certifiedBlue(page)).toHaveValue("45");
});

test("without Web Locks account sync is unavailable and guests keep every feature", async ({
  page,
  context,
}) => {
  const api = signedInApi(10);
  await api.install(context);
  await page.addInitScript(() => {
    Reflect.deleteProperty(Navigator.prototype, "locks");
  });
  await enableAccountFlag(page);
  await openApp(page);
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "이 브라우저에서는 계정 동기화를 사용할 수 없습니다" }),
  ).toBeVisible();
  await expect(beginnerKit(page)).toBeEnabled();
  await expect(beginnerKit(page)).not.toHaveValue("10");
  await expect(loginButton(page)).toHaveCount(0);
  await setBeginnerKit(page, "12");
  await expect(beginnerKit(page)).toHaveValue("12");
  expect(api.requests).toEqual([]);
});

test("a device-store upgrade blocked by an older tab asks to close the other tabs", async ({
  context,
}) => {
  const api = signedInApi(10);
  await api.install(context);
  // An open tab of an older version keeps its version-2 connection and ignores upgrades.
  const older = await context.newPage();
  await older.goto(`${ORIGIN}/`);
  await older.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("collection-kit-account", 2);
        request.onupgradeneeded = () => request.result.createObjectStore("guest-workspace");
        request.onsuccess = () => {
          Object.assign(window, { heldDatabase: request.result });
          resolve();
        };
        request.onerror = () => reject(request.error);
      }),
  );
  const page = await context.newPage();
  await enableAccountFlag(page);
  await openApp(page);
  await expect(page.getByRole("status").filter({ hasText: "다른 탭을 닫으세요" })).toBeVisible();
  await older.close();
  await expect(accountTrigger(page)).toHaveAccessibleName("계정 · 동기화됨");
  await expect(beginnerKit(page)).toHaveValue("10");
});
