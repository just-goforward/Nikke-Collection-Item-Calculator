import { type BrowserContext, expect, type Page, type Route } from "@playwright/test";

/** Local mock of the personal-data API and device-store helpers for e2e/account.spec.ts. */
export const PORT = 4297;
export const ORIGIN = `http://127.0.0.1:${PORT}`;
const GOOGLE_URL = "https://accounts.google.com/o/oauth2/v2/auth?client_id=e2e";
type Recorded = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
};
type PutBody = { opId: string; baseRevision: number; document: unknown };

export function calculatorDocument(blue: number) {
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

/** Same-origin mock of the personal-data contract (CAS, account context, privacy). */
export class MockAccountApi {
  userId: string | null = null;
  revision = 0;
  document: unknown = { schemaVersion: 1, items: [], lifetimeStages: [] };
  quota = { bytes: 2_048, limitBytes: 1_500_000, newArchivingBlocked: false };
  /** GET /v1/account still reports an undecided consent; the beta UI never asks or sends it. */
  readonly consent = { participation: null, decisionVersion: 0 };
  nextPutError: { status: number; error: string } | null = null;
  failPuts = false;
  /** Answers the next N workspace reads with 503. */
  failWorkspaceReads = 0;
  /** The session cookie switches to this account right after the next GET /v1/account. */
  switchAfterAccount: string | null = null;
  lastOpId: string | null = null;
  /** Holds GET /v1/account (a slow account check) until the promise settles. */
  holdAccount: Promise<void> | null = null;
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
    if (recorded.method === "GET" && path === "/v1/account" && this.holdAccount) {
      await this.holdAccount;
    }
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
    const context = headers["if-account-match"];
    // Mutations require the account context; private reads honor it when present.
    if (method !== "GET" && context === undefined) {
      return [428, { error: "account_context_required" }];
    }
    if (context !== undefined && context !== `"${this.userId}"`) {
      return [409, { error: "account_context_stale" }];
    }
    return this.routeSignedIn(route, body);
  }

  private routeSignedIn(route: string, body: Recorded["body"]): [number, unknown] {
    if (route === "GET /v1/account") return this.account();
    if (route === "GET /v1/workspace") return this.workspace();
    if (route === "PUT /v1/workspace") return this.put(body as PutBody);
    if (route === "GET /v1/export") {
      return [
        200,
        {
          schemaVersion: 1,
          account: { userId: this.userId },
          exportedAt: 1,
          workspace: { userId: this.userId, revision: this.revision },
        },
      ];
    }
    if (route === "DELETE /v1/account" || route === "POST /v1/sessions/revoke-all") {
      this.userId = null;
      return route.startsWith("DELETE")
        ? [202, { operationId: "privacy-op", status: "complete", fenceGeneration: 3 }]
        : [200, { revoked: true }];
    }
    return [404, { error: "not_found" }];
  }

  private workspace(): [number, unknown] {
    if (this.failWorkspaceReads > 0) {
      this.failWorkspaceReads -= 1;
      return [503, { error: "service_unavailable" }];
    }
    return [
      200,
      {
        userId: this.userId,
        revision: this.revision,
        lastOpId: this.lastOpId,
        document: this.document,
        quota: this.quota,
      },
    ];
  }

  private account(): [number, unknown] {
    const account = { authenticated: true, account: { userId: this.userId, generation: 1 } };
    if (this.switchAfterAccount) {
      this.userId = this.switchAfterAccount;
      this.switchAfterAccount = null;
    }
    return [200, { ...account, consent: this.consent }];
  }

  private put(body: PutBody): [number, unknown] {
    if (this.failPuts) return [503, { error: "service_unavailable" }];
    const injected = this.nextPutError;
    if (injected) {
      this.nextPutError = null;
      return [injected.status, { error: injected.error }];
    }
    if (body.baseRevision !== this.revision) {
      return [409, { status: "revision_conflict", revision: this.revision }];
    }
    this.revision += 1;
    this.lastOpId = body.opId;
    this.document = body.document;
    return [200, { status: "saved", revision: this.revision, replayed: false }];
  }
}

export async function enableAccountFlag(target: Page | BrowserContext) {
  await target.addInitScript(() => {
    Object.assign(window, { COLLECTION_ACCOUNT_CONFIG: { enabled: true } });
  });
}

export async function deviceStores(page: Page) {
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
      accounts: await all("account-drafts"),
      certified: await all("account-certified-drafts"),
    };
    db.close();
    return stores;
  });
}

export function signedInApi(blue: number, revision = 1) {
  const api = new MockAccountApi();
  api.userId = "user-a";
  api.revision = revision;
  api.document = calculatorDocument(blue);
  return api;
}

// ---- page helpers shared by the account specs ----

export async function openApp(page: Page) {
  await page.setViewportSize({ width: 1365, height: 900 });
  await page.goto(`${ORIGIN}/`);
  await expect(page.getByRole("button", { name: "0단계", exact: true })).toBeVisible();
}

export const beginnerKit = (page: Page) => page.getByLabel("초심자용 키트");

export const accountTrigger = (page: Page) => page.getByRole("button", { name: /^계정 · / });

export const loginButton = (page: Page) =>
  page.getByRole("button", { name: "Google 계정으로 로그인" });

export async function setBeginnerKit(page: Page, value: string) {
  await beginnerKit(page).fill(value);
  await beginnerKit(page).press("Tab");
}

export const CERTIFIED_PATH = "/?statsEnv=staging&engine=certified";

const CERTIFIED_GUEST_KEY = "collection-certified-staging-v2:session";

export type CertifiedItem = { type: string; version: number; session: { stock: number[] } };

export async function blockExternalRequests(context: BrowserContext) {
  // Registered before the API mock so its Google/CDN routes still take precedence.
  await context.route(
    (url) => !["127.0.0.1", "localhost"].includes(url.hostname),
    (route) => route.abort("blockedbyclient"),
  );
}

export async function openCertified(page: Page) {
  await page.setViewportSize({ width: 1365, height: 900 });
  await page.goto(`${ORIGIN}${CERTIFIED_PATH}`);
  await expect(page.locator("main[data-engine-profile='certified-staging-v2']")).toBeVisible();
  await expect(page.locator("#calculateButton")).toBeEnabled();
}

export const certifiedBlue = (page: Page) => page.locator("#blueStock");

export async function setCertifiedBlue(page: Page, value: string) {
  await certifiedBlue(page).fill(value);
  await certifiedBlue(page).press("Tab");
}

export function certifiedItems(document: unknown): CertifiedItem[] {
  const items = (document as { items: CertifiedItem[] }).items;
  return items.filter((item) => item.type === "certified-session");
}

export async function guestCertifiedBlue(page: Page) {
  const text = await page.evaluate((key) => localStorage.getItem(key), CERTIFIED_GUEST_KEY);
  return text === null ? null : (JSON.parse(text) as { stock: number[] }).stock[0];
}

/** Until the account is confirmed the engine shows (and stores) guest data. */
export async function openCertifiedAccount(page: Page) {
  await openCertified(page);
  await expect(accountTrigger(page)).toHaveAccessibleName("계정 · 동기화됨");
}

export async function certifiedApi(context: BrowserContext) {
  const api = new MockAccountApi();
  await blockExternalRequests(context);
  await api.install(context);
  return api;
}

export function holdAccountCheck(api: MockAccountApi) {
  let release: () => void = () => undefined;
  api.holdAccount = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => release();
}

export const checkingIndicator = (page: Page) =>
  page.getByRole("status").filter({ hasText: "계정 확인 중…" });
