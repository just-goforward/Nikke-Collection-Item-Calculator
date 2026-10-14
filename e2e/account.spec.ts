import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { type BrowserContext, expect, type Page, type Route } from "@playwright/test";
import { type PreviewServer, preview } from "vite";
import { closePreviewServer, test } from "./test";

const PORT = 4297;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const GOOGLE_URL = "https://accounts.google.com/o/oauth2/v2/auth?client_id=e2e";
// Defaults to the regular build; a separate output directory can be supplied for isolated runs.
const OUT_DIR = process.env["ACCOUNT_E2E_DIST"] ?? "dist";
let server: PreviewServer | null = null;

type Recorded = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
};
type PutBody = { opId: string; baseRevision: number; document: unknown };

function calculatorDocument(blue: number) {
  return {
    schemaVersion: 1,
    items: [
      {
        type: "calculator-input",
        version: 1,
        input: { grade: "R", level: 0, exp: 0, stock: { blue, purple: 0, yellow: 0 } },
      },
    ],
    lifetimeStages: [],
  };
}

/** Same-origin mock of the personal-data contract (CAS, account context, consent, privacy). */
class MockAccountApi {
  userId: string | null = null;
  revision = 0;
  document: unknown = { schemaVersion: 1, items: [], lifetimeStages: [] };
  quota = { bytes: 2_048, limitBytes: 1_500_000, newArchivingBlocked: false };
  consent: { participation: boolean | null; decisionVersion: number } = {
    participation: null,
    decisionVersion: 0,
  };
  nextPutError: { status: number; error: string } | null = null;
  readonly requests: Recorded[] = [];

  async install(context: BrowserContext) {
    await context.route(`${ORIGIN}/v1/**`, (route) => this.handle(route));
    await context.route(`${ORIGIN}/auth/**`, (route) => this.handle(route));
    await context.route("https://accounts.google.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<title>Google</title>" }),
    );
    await context.route("https://cdn.jsdelivr.net/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/css", body: "" }),
    );
  }

  puts() {
    return this.requests.filter(
      (entry) => entry.method === "PUT" && entry.path === "/v1/workspace",
    );
  }

  private async handle(route: Route) {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const raw = request.postData();
    const recorded: Recorded = {
      method: request.method(),
      path,
      headers: await request.allHeaders(),
      body: raw ? JSON.parse(raw) : null,
    };
    this.requests.push(recorded);
    const [status, json] = this.respond(recorded);
    await route.fulfill({
      status,
      contentType: "application/json",
      headers: { "Cache-Control": "no-store" },
      body: JSON.stringify(json),
    });
  }

  private respond({ method, path, headers, body }: Recorded): [number, unknown] {
    const route = `${method} ${path}`;
    if (route === "POST /auth/login/google") return [200, { authorizationUrl: GOOGLE_URL }];
    if (route === "POST /auth/logout") {
      this.userId = null;
      return [200, { loggedOut: true }];
    }
    if (!this.userId) return [401, { error: "unauthenticated" }];
    if (method !== "GET") {
      const context = headers["if-account-match"];
      if (context === undefined) return [428, { error: "account_context_required" }];
      if (context !== `"${this.userId}"`) return [409, { error: "account_context_stale" }];
    }
    if (route === "GET /v1/account") {
      return [
        200,
        {
          authenticated: true,
          account: { userId: this.userId, generation: 1 },
          consent: this.consent,
        },
      ];
    }
    if (route === "GET /v1/workspace") {
      return [
        200,
        { revision: this.revision, lastOpId: null, document: this.document, quota: this.quota },
      ];
    }
    if (route === "PUT /v1/workspace") return this.put(body as PutBody);
    if (route === "PUT /v1/consent") {
      this.consent = {
        participation: body?.["participation"] === true,
        decisionVersion: this.consent.decisionVersion + 1,
      };
      return [200, this.consent];
    }
    if (route === "GET /v1/consent") return [200, this.consent];
    if (route === "GET /v1/export") {
      return [200, { schemaVersion: 1, exportedAt: 1, workspace: { revision: this.revision } }];
    }
    if (route === "DELETE /v1/account" || route === "POST /v1/sessions/revoke-all") {
      this.userId = null;
      return route.startsWith("DELETE")
        ? [202, { operationId: "privacy-op", status: "complete", fenceGeneration: 3 }]
        : [200, { revoked: true }];
    }
    return [404, { error: "not_found" }];
  }

  private put(body: PutBody): [number, unknown] {
    const injected = this.nextPutError;
    if (injected) {
      this.nextPutError = null;
      return [injected.status, { error: injected.error }];
    }
    if (body.baseRevision !== this.revision) {
      return [409, { status: "revision_conflict", revision: this.revision }];
    }
    this.revision += 1;
    this.document = body.document;
    return [200, { status: "saved", revision: this.revision, replayed: false }];
  }
}

async function enableAccountFlag(target: Page | BrowserContext) {
  await target.addInitScript(() => {
    Object.assign(window, { COLLECTION_ACCOUNT_CONFIG: { enabled: true } });
  });
}

async function openApp(page: Page) {
  await page.setViewportSize({ width: 1365, height: 900 });
  await page.goto(`${ORIGIN}/`);
  await expect(page.getByRole("button", { name: "0단계", exact: true })).toBeVisible();
}

const beginnerKit = (page: Page) => page.getByLabel("초심자용 키트");
const accountTrigger = (page: Page) => page.getByRole("button", { name: /^계정 · / });
const loginButton = (page: Page) => page.getByRole("button", { name: "Google 계정으로 로그인" });

async function setBeginnerKit(page: Page, value: string) {
  await beginnerKit(page).fill(value);
  await beginnerKit(page).press("Tab");
}

async function deviceStores(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("collection-kit-account");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const all = (name: string) =>
      new Promise<unknown[]>((resolve, reject) => {
        const request = db.transaction(name).objectStore(name).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const stores = {
      guest: await all("guest-workspace"),
      accounts: await all("account-workspaces"),
    };
    db.close();
    return stores;
  });
}

function signedInApi(blue: number, revision = 1) {
  const api = new MockAccountApi();
  api.userId = "user-a";
  api.consent = { participation: false, decisionVersion: 1 };
  api.revision = revision;
  api.document = calculatorDocument(blue);
  return api;
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
  await api.install(context);
  const chunks: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("AccountEntry")) chunks.push(request.url());
  });
  await openApp(page);
  await expect(page.locator("[data-account-trigger]")).toHaveCount(0);
  expect(api.requests).toEqual([]);
  expect(chunks).toEqual([]);
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
  await setBeginnerKit(page, "12");
  await page.waitForTimeout(2_000);
  expect(api.puts()).toHaveLength(1);

  await page.reload();
  api.nextPutError = { status: 428, error: "account_context_required" };
  await setBeginnerKit(page, "13");
  await expect(page.getByRole("alert").filter({ hasText: "계정 확인 정보가 없어" })).toBeVisible();
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
    exportedAt: 1,
    workspace: { revision: 1 },
  });

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
