import { expect, test, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { installPersistenceAudit } from "./decision-analytics-persistence";
import { diagnosticJson } from "./operational-report.mjs";
import { isExpectedBlockedFont } from "./operational-font-policy.mjs";
import { enMessages } from "../src/i18n/messages.en";
import { koMessages } from "../src/i18n/messages.ko";
import { CERTIFIED_WASM_ASSET } from "../shared/generated/wasmRuntimeAssets";
import { CERTIFIED_STAGING_ENGINE_PROFILE } from "../shared/certifiedEngineProfile";
import type { CertifiedRuntimeOutput } from "../src/certifiedRuntime/outputBinding";

const origin = "http://127.0.0.1:4290";
const violations = new WeakMap<Page, string[]>();
type NetworkEvidence = {
  requests: unknown[];
  responses: unknown[];
  console: unknown[];
  pageErrors: unknown[];
  pending: Promise<void>[];
  expectedBlockedFonts: { category: "EXPECTED_BLOCKED_FONT"; url: string; method: string; resourceType: string; blocked: boolean }[];
  externalResponses: unknown[];
};
const networkEvidence = new WeakMap<Page, NetworkEvidence>();
declare global {
  interface Window {
    operationalAudit: {
      forbidden: string[];
      csp: unknown[];
      workers: { url: string; name: string; messages: unknown[]; errors: unknown[] }[];
    };
  }
}
test.beforeEach(async ({ context, page }) => {
  const unexpected: string[] = [];
  violations.set(page, unexpected);
  const network: NetworkEvidence = { requests: [], responses: [], console: [], pageErrors: [], pending: [],
    expectedBlockedFonts: [], externalResponses: [] };
  networkEvidence.set(page, network);
  page.on("pageerror", error => {
    unexpected.push("pageerror");
    if (network.pageErrors.length < 32) network.pageErrors.push({ message: error.message, stack: error.stack });
  });
  page.on("console", message => {
    if (network.console.length < 64) network.console.push({
      type: message.type(), text: message.text().slice(0, 4096), location: message.location(),
    });
  });
  context.on("response", response => {
    if (new URL(response.url()).origin !== origin) {
      unexpected.push(`external_response:${response.url()}`);
      if (network.externalResponses.length < 64)
        network.externalResponses.push({ url: response.url(), status: response.status() });
    }
    if (network.responses.length >= 64 || network.pending.length >= 64) return;
    if (response.status() < 400 && response.request().resourceType() !== "document") return;
    network.pending.push((async () => {
      const headers = await response.allHeaders();
      let body: string | undefined;
      if (response.status() >= 400) {
        try { body = (await response.text()).slice(0, 4096); }
        catch (error) { body = String(error).slice(0, 1024); }
      }
      network.responses.push({ url: response.url(), status: response.status(),
        resourceType: response.request().resourceType(),
        contentType: headers["content-type"], csp: headers["content-security-policy"], body });
    })());
  });
  await context.routeWebSocket("**/*", socket => {
    unexpected.push("websocket"); socket.close();
  });
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    const descriptor = {
      method: request.method(), url: url.href, resourceType: request.resourceType(),
    };
    if (network.requests.length < 128) network.requests.push(descriptor);
    if (isExpectedBlockedFont(descriptor) && network.expectedBlockedFonts.length < 128) {
      const entry = { category: "EXPECTED_BLOCKED_FONT" as const, ...descriptor, blocked: false };
      network.expectedBlockedFonts.push(entry);
      const aborted = route.abort("blockedbyclient").then(() => { entry.blocked = true; });
      network.pending.push(aborted);
      await aborted;
      return;
    }
    if (url.origin !== origin || request.method() !== "GET" ||
        /^\/(?:api|auth|v1|account|admin)(?:\/|$)/.test(url.pathname)) {
      unexpected.push(`${request.method()}:${url.href}`); await route.abort(); return;
    }
    await route.continue();
  });
  await context.addInitScript(installPersistenceAudit);
  await context.addInitScript(() => {
    const audit: Window["operationalAudit"] = { forbidden: [], csp: [], workers: [] };
    window.operationalAudit = audit;
    document.addEventListener("securitypolicyviolation", event => {
      if (audit.csp.length < 32) audit.csp.push({
        blockedURI: event.blockedURI, effectiveDirective: event.effectiveDirective,
        sourceFile: event.sourceFile, lineNumber: event.lineNumber,
      });
    });
    const forbidden = (kind: string): never => {
      audit.forbidden.push(kind); throw new Error("OPERATIONAL_BROWSER_EFFECT_PROHIBITED");
    };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(source: URL | string, options?: WorkerOptions) {
        const url = new URL(String(source), location.href);
        if (url.origin !== location.origin || !/^\/assets\/browserWorker-[\w-]+\.js$/.test(url.pathname) ||
            options?.name !== "certified-staging" || options.type !== "module") forbidden("worker");
        super(source, options);
        const record = { url: url.pathname, name: options!.name!, messages: [] as unknown[], errors: [] as unknown[] };
        audit.workers.push(record);
        this.addEventListener("message", event => {
          if (record.messages.length < 128) record.messages.push(event.data);
        });
        this.addEventListener("error", event => {
          if (record.errors.length < 32) record.errors.push({
            message: event.message, filename: event.filename, line: event.lineno, column: event.colno,
          });
        });
        this.addEventListener("messageerror", () => {
          if (record.errors.length < 32) record.errors.push({ message: "messageerror" });
        });
      }
    };
    window.SharedWorker = class { constructor() { forbidden("sharedworker"); } } as unknown as typeof SharedWorker;
    window.WebSocket = class { constructor() { forbidden("websocket"); } } as unknown as typeof WebSocket;
    window.EventSource = class { constructor() { forbidden("eventsource"); } } as unknown as typeof EventSource;
    navigator.sendBeacon = () => forbidden("beacon");
    navigator.serviceWorker.register = async () => forbidden("serviceworker");
    const nativeFetch = window.fetch;
    window.fetch = function(input, init) {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (url.origin !== location.origin || method !== "GET" ||
          /^\/(?:api|auth|v1|account|admin)(?:\/|$)/.test(url.pathname)) forbidden("fetch");
      return nativeFetch.call(this, input, init);
    };
  });
});
test.afterEach(async ({ page }, testInfo) => {
  const network = networkEvidence.get(page)!;
  await Promise.all(network.pending);
  const state = page.url() === "about:blank" ? null : await page.evaluate(() => ({
    audit: window.operationalAudit,
    persistence: window.decisionPersistence.evidence(),
  }));
  const evidence = testInfo.outputPath("operational-evidence.json");
  writeFileSync(evidence, diagnosticJson({ violations: violations.get(page), state,
    network: { requests: network.requests, responses: network.responses,
      console: network.console, pageErrors: network.pageErrors,
      expectedBlockedFonts: network.expectedBlockedFonts, externalResponses: network.externalResponses } }));
  await testInfo.attach("operational-private-evidence", { path: evidence, contentType: "application/json" });
  expect(violations.get(page)).toEqual([]);
  expect(network.externalResponses).toEqual([]);
  expect(network.expectedBlockedFonts.every(attempt => attempt.blocked)).toBe(true);
  if (state) {
    expect(state.audit.forbidden).toEqual([]);
    expect(state.persistence.forbidden).toEqual([]);
  }
});

async function boot(page: Page, path = "/en/") {
  await page.goto(path);
  await expect(page.locator("#calculateButton")).toBeVisible();
  await expect(page.locator("[data-account-trigger], [data-account-checking]")).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, "COLLECTION_ACCOUNT_CONFIG"))).toBeUndefined();
}
async function calculateOneBlue(page: Page) {
  await page.locator('[data-grade="SR"]').click();
  await page.locator('[data-level="14"]').click();
  await page.locator("#currentExp").fill("2900");
  await page.locator("#currentExp").blur();
  await page.locator("#blueStock").fill("10");
  await page.locator("#blueStock").blur();
  await page.locator("#calculateButton").click();
  // One blue use supplies >=200 exp; only 100 exp remains. No output-derived oracle.
  await expect(page.locator("#resultBox .action-chip.blue")).toBeVisible();
  const count = await page.locator("html").getAttribute("lang");
  await expect(page.locator("#resultBox .action-chip-count")).toHaveText(
    count === "ko" ? "1회" : count === "ja" ? "1回" : "1 use");
  await expect(page.locator("#detailBox")).toContainText("100%");
  await expect.poll(async () => page.evaluate(() =>
    window.operationalAudit.workers.flatMap(worker => worker.messages)
      .some(message => (message as { type?: string }).type === "result"))).toBe(true);
  const workers = await page.evaluate(() => window.operationalAudit.workers);
  expect(workers).toHaveLength(1);
  expect(networkEvidence.get(page)!.requests).toEqual(expect.arrayContaining([
    { method: "GET", url: `${origin}/${CERTIFIED_WASM_ASSET.file}`, resourceType: "fetch" },
  ]));
  expect(workers[0]!.messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "initComplete", engineProfile: CERTIFIED_STAGING_ENGINE_PROFILE }),
    expect.objectContaining({ type: "result", engineProfile: CERTIFIED_STAGING_ENGINE_PROFILE, output: expect.objectContaining({
      status: "completed", refusal: null,
      provenance: expect.objectContaining({ solverVersion: "certified-exact-rust-wasm-v1" }),
      current: expect.objectContaining({
        status: "use_certified", kit: "blue", uses: 1, pieces: 10, optimalActionMask: 1,
        value: expect.objectContaining({ successP: { numerator: "1", denominator: "1" } }),
      }),
    }) }),
  ]));
  const final = workers[0]!.messages.find(message =>
    (message as { type?: string }).type === "result") as { output: CertifiedRuntimeOutput };
  expect(final.output.runtimeBinding.engineProfile).toEqual(CERTIFIED_STAGING_ENGINE_PROFILE);
  expect(final.output.diagnostics.wasmMemoryBytes).toBeGreaterThan(0);
  expect(final.output.current?.value.expectedTotalConsumptionC).toEqual({ numerator: "10", denominator: "1" });
  expect(final.output.current?.value.expectedConsumed).toEqual([
    { numerator: "10", denominator: "1" },
    { numerator: "0", denominator: "1" },
    { numerator: "0", denominator: "1" },
  ]);
}

for (const [id, path, lang] of [
  ["P001", "/", "ko"], ["P002", "/en/", "en"], ["P003", "/ja/", "ja"],
] as const) {
  test(id, async ({ page }) => {
    await boot(page, path);
    await expect(page.locator("html")).toHaveAttribute("lang", lang);
    await expect(page.locator("#calculateButton")).toBeDisabled();
    expect(await page.evaluate(() => window.operationalAudit.workers)).toEqual([]);
    await calculateOneBlue(page);
  });
}
test("P004", async ({ page }) => {
  await boot(page);
  await page.locator('[data-theme-mode="dark"]').click();
  await page.locator("#language-menu-trigger").click();
  await page.getByRole("menuitemradio", { name: "日本語", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/ja/`);
  await page.locator('[data-level="4"]').click();
  await page.locator("#blueStock").fill("73"); await page.locator("#blueStock").blur();
  const inventory = await page.evaluate(() => window.decisionPersistence.inventory());
  expect(inventory).toMatchObject({ local: { collectionThemeMode: "dark" }, session: {}, cookie: "" });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.locator("body")).toHaveClass(/theme-dark/);
  await expect(page.locator('[data-grade="R"][aria-pressed="true"]')).toHaveCount(1);
  await expect(page.locator('[data-level="0"][aria-pressed="true"]')).toHaveCount(1);
  await expect(page.locator("#blueStock")).toHaveValue("");
  expect(await page.evaluate(() => window.decisionPersistence.inventory())).toEqual(inventory);
});
test("P005", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.decisionPersistence.configure(true));
  await calculateOneBlue(page);
  await page.locator("#resultBox .success-button").click();
  await page.locator("#resultBox .outcome-panel").getByRole("button", { name: enMessages["common.superSuccessYesConfirm"], exact: true }).click();
  await expect(page.locator("#blueStock")).toHaveValue("");
  await expect(page.locator('[data-level="15"][aria-pressed="true"]')).toHaveCount(1);
  await page.reload();
  await expect(page.locator("#blueStock")).toHaveValue("");
  await expect(page.locator('[data-grade="R"][aria-pressed="true"]')).toHaveCount(1);
  await expect(page.locator('[data-level="0"][aria-pressed="true"]')).toHaveCount(1);
  expect(await page.evaluate(() => window.decisionPersistence.inventory())).toMatchObject({
    local: {}, session: {}, cookie: "",
  });
});
test("P006", async ({ page }) => {
  await boot(page);
  await page.locator("#desktop-tab-stats").click();
  await expect(page.locator("#globalStatsPanel")).toContainText(enMessages["stats.unconfigured"]);
  await page.locator("#desktop-tab-calc").click();
  await calculateOneBlue(page);
  expect(await page.evaluate(() => window.decisionPersistence.evidence().forbidden)).toEqual([]);
});
test("P007", async ({ page, context }) => {
  const legacyLanguageKey = "collection-kit-calculator.language";
  await context.setStorageState({
    cookies: [],
    origins: [{ origin, localStorage: [{ name: legacyLanguageKey, value: "en" }] }],
  });
  await boot(page, "/");
  await expect(page).toHaveURL(`${origin}/`);
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  expect((await page.evaluate(() => window.decisionPersistence.inventory())).local)
    .toEqual({ [legacyLanguageKey]: "en" });
  expect(await page.evaluate(() => window.decisionPersistence.evidence().forbidden)).toEqual([]);
  const seeded = await page.evaluate(() => window.decisionPersistence.seed("2026-10-08T12:00:00.000Z"));
  await page.reload();
  await expect(page).toHaveURL(`${origin}/`);
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  await expect(page.locator("#blueStock")).toHaveValue("");
  await expect(page.locator("[data-account-trigger], [data-account-checking]")).toHaveCount(0);
  expect(await page.evaluate(() => window.decisionPersistence.inventory(true))).toEqual(seeded);
  await page.locator('[data-grade="SR"]').click();
  await page.locator('[data-level="15"]').click();
  await expect(page.locator("#resultBox")).toContainText(koMessages["result.finalTarget"]);
  await expect(page.locator("#calculateButton")).toBeDisabled();
  expect(await page.evaluate(() => window.operationalAudit.workers)).toEqual([]);
  expect(await page.evaluate(() => window.decisionPersistence.inventory(true))).toEqual(seeded);
  expect(await page.evaluate(() => window.decisionPersistence.evidence().forbidden)).toEqual([]);
  for (const [path, language] of [["/en/", "en"], ["/ja/", "ja"]] as const) {
    await boot(page, path);
    await expect(page).toHaveURL(`${origin}${path}`);
    await expect(page.locator("html")).toHaveAttribute("lang", language);
    expect(await page.evaluate(() => window.decisionPersistence.inventory(true))).toEqual(seeded);
    expect(await page.evaluate(() => window.decisionPersistence.evidence().forbidden)).toEqual([]);
    expect(await page.evaluate(() => window.operationalAudit.workers)).toEqual([]);
  }
});
test("P008", async ({ page, context }) => {
  await context.route(`${origin}/${CERTIFIED_WASM_ASSET.file}`, route => route.abort("failed"));
  await boot(page);
  await page.locator('[data-grade="SR"]').click();
  await page.locator('[data-level="14"]').click();
  await page.locator("#currentExp").fill("2900"); await page.locator("#currentExp").blur();
  await page.locator("#blueStock").fill("10"); await page.locator("#blueStock").blur();
  await page.locator("#calculateButton").click();
  await expect(page.locator("#resultBox")).toContainText(enMessages["result.solverError"]);
  await expect(page.locator("#resultBox .recommendation")).toHaveCount(0);
  await expect(page.locator("#blueStock")).toHaveValue("10");
  expect(await page.evaluate(() => window.operationalAudit.workers)).toHaveLength(1);
});
