import { expect, test, type Page, type Route } from "@playwright/test";
import tailwindcss from "@tailwindcss/vite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { CERTIFIED_STAGING_ENGINE_PROFILE } from "../shared/certifiedEngineProfile";
import { forecastAsyncFixtures } from "./forecast-async.fixtures";
import type { BootOptions } from "./decision-analytics-browser";
import type { SyntheticResult } from "./decision-analytics-client";
import { installPersistenceAudit, type PersonalInventory } from "./decision-analytics-persistence";

type Snapshot = ReturnType<Window["decisionAnalytics"]["snapshot"]>;
type Stage = Snapshot["events"][number]["stage"];
let server: ViteDevServer;
let origin: string;
let fixtures: Awaited<ReturnType<typeof forecastAsyncFixtures>>;
const blocked = new WeakMap<Page, string[]>();
type Held = { requested: boolean; release: () => void };
const held = new WeakMap<Page, Map<string, Held>>();
const phases = new WeakMap<Page, Array<{ label: string; state: Snapshot; inventory?: PersonalInventory }>>();
const input = { grade: "R" as const, level: 0, exp: 0,
  stock: { blue: 59, purple: 39, yellow: 19 } };
const currentLeaf = "#resultBox .recommendation";
const preservationLeaf = "#resultBox .callout";
const waitLeaf = "#detailBox .metric-grid > .metric:nth-child(3)";
let devClientTransportSuppressions = 0;

test.use({ serviceWorkers: "block" });
test.beforeAll(async () => {
  fixtures = await forecastAsyncFixtures();
  server = await createServer({
    configFile: false, root: process.cwd(),
    cacheDir: mkdtempSync(join(tmpdir(), "decision-analytics-vite-")),
    define: {
      "import.meta.env.VITE_SERVICE_CERTIFIED_SOLVER": JSON.stringify("true"),
      "import.meta.env.VITE_FORECAST_RUNTIME": JSON.stringify("staging"),
      "import.meta.env.VITE_FORECAST_PUBLIC_KEY_ID": JSON.stringify(fixtures.trust.keyId),
      "import.meta.env.VITE_FORECAST_PUBLIC_KEY_BASE64": JSON.stringify(fixtures.trust.publicKeyBase64),
      __APP_REVISION__: JSON.stringify("TEST-ONLY-mounted-v3"),
      __STATS_DELIVERY_HEALTH_EMIT_ENABLED__: "false",
    },
    optimizeDeps: { noDiscovery: true, include: [
      "react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime",
    ] },
    plugins: [
      tailwindcss(),
      {
        name: "decision-analytics-external-client-only",
        enforce: "pre",
        transform(code, id) {
          if (!id.replaceAll("\\", "/").endsWith("/vite/dist/client/client.mjs")) return;
          // Vite 8.3.5's dev client connects unconditionally even with hmr:false.
          // Retain its real CSS utilities; remove only its fixture-only transport startup.
          const startup = "transport.connect(createHMRHandler(handleMessage));";
          if (code.split(startup).length !== 2) throw new Error("vite_835_devclient_startup_changed");
          ++devClientTransportSuppressions;
          return { code: code.replace(startup, ""), map: null };
        },
        resolveId(source, importer) {
          if (importer?.replaceAll("\\", "/").endsWith("/src/hooks/serviceCertifiedAdapter.ts") &&
              /certifiedRuntime\/browserClient(?:\.ts)?$/.test(source))
            return resolve("e2e/decision-analytics-client.ts");
          if (importer?.replaceAll("\\", "/").endsWith("/src/hooks/useStatsSubmission.ts") &&
              (source === "../lib/statsSubmitClient" || source === "../lib/statsRuntime"))
            return resolve("e2e/decision-analytics-browser.tsx");
        },
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            const pathname = new URL(request.url!, "http://fixture.invalid").pathname;
            if (!["/decision-analytics-test", "/", "/en/", "/ja/"].includes(pathname)) { next(); return; }
            const locale = pathname === "/en/" ? "en" : pathname === "/ja/" ? "ja" : "ko";
            response.setHeader("Content-Type", "text/html");
            response.end(`<!doctype html><html lang="${locale}" data-locale="${locale}"><head>` +
              '<title>TEST-ONLY decision integration</title><meta name="viewport" content="width=device-width,initial-scale=1">' +
              '<link rel="icon" href="data:,">' +
              '<link rel="stylesheet" href="/src/styles.css">' +
              ["ko", "en", "ja"].map((language) =>
                `<link rel="stylesheet" data-locale-font="${language}" data-load-state="loaded" href="/decision-analytics-font.css">`).join("") +
              '</head><body><div id="app"></div>' +
              '<script type="module" src="/e2e/decision-analytics-browser.tsx"></script></body></html>');
          });
          vite.middlewares.use("/decision-analytics-font.css", (_request, response) => {
            response.setHeader("Content-Type", "text/css");
            // Keep production layout CSS; typography is outside this proof.
            response.end("/* local system-font fixture; no external font service */");
          });
        },
      },
    ],
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, ws: false, forwardConsole: false },
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("fixture_address_missing");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); });

test.beforeEach(async ({ page, context }) => {
  const unexpected: string[] = [];
  blocked.set(page, unexpected);
  held.set(page, new Map());
  phases.set(page, []);
  page.on("pageerror", (error) => unexpected.push(`pageerror:${error.message}`));
  await context.routeWebSocket("**/*", (socket) => {
    unexpected.push(`websocket:${socket.url()}`);
    socket.close();
  });
  await context.route("**/*", async (route: Route) => {
    const request = route.request(), url = new URL(request.url());
    const allowed = url.origin === origin && request.method() === "GET" &&
      (["/decision-analytics-test", "/", "/en/", "/ja/", "/decision-analytics-font.css"].includes(url.pathname) ||
        ["/src/", "/shared/", "/e2e/decision-analytics-", "/node_modules/", "/@vite/", "/@id/", "/@fs/"]
          .some((prefix) => url.pathname.startsWith(prefix))) &&
      !/\.wasm(?:$|\?)/.test(url.pathname) && !url.pathname.includes("/api/") &&
      !url.pathname.includes("/src/account/");
    if (!allowed) {
      unexpected.push(`${request.method()}:${url.href}`);
      await route.abort();
      return;
    }
    const leaf = url.pathname.endsWith("/RecommendationContent.tsx") ? "current" :
      url.pathname.endsWith("/DetailPanel.tsx") ? "wait" : undefined;
    const gate = leaf ? held.get(page)?.get(leaf) : undefined;
    if (gate) {
      gate.requested = true;
      await new Promise<void>((release) => { gate.release = release; });
    }
    await route.continue();
  });
  await context.addInitScript(() => {
    const guards = { unexpected: [] as string[], visibility: "visible" as DocumentVisibilityState };
    window.decisionAnalyticsGuards = guards;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => guards.visibility });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => guards.visibility !== "visible" });
    const forbidden = (kind: string, detail = ""): never => {
      guards.unexpected.push(`${kind}:${detail}`);
      throw new Error(`${kind}_prohibited`);
    };
    window.fetch = async (input) => forbidden("fetch", input instanceof Request ? input.url : String(input));
    window.Worker = class { constructor() { forbidden("worker"); } } as unknown as typeof Worker;
    window.SharedWorker = class { constructor() { forbidden("shared_worker"); } } as unknown as typeof SharedWorker;
    window.WebSocket = class { constructor() { forbidden("websocket"); } } as unknown as typeof WebSocket;
    window.EventSource = class { constructor() { forbidden("event_source"); } } as unknown as typeof EventSource;
    navigator.sendBeacon = (url) => forbidden("beacon", String(url));
    XMLHttpRequest.prototype.open = function() { forbidden("xhr"); };
  });
  await context.addInitScript(installPersistenceAudit);
});

test.afterEach(async ({ page }, testInfo) => {
  for (const gate of held.get(page)?.values() ?? []) gate.release();
  try {
    const before = await page.evaluate(() => window.decisionAnalytics?.snapshot());
    await page.evaluate(() => window.decisionAnalytics?.unmount());
    const after = await page.evaluate(() => window.decisionAnalytics?.snapshot());
    const evidencePath = testInfo.outputPath("synthetic-evidence.json");
    writeFileSync(evidencePath, JSON.stringify({
      before, after, phases: phases.get(page), blocked: blocked.get(page), devClientTransportSuppressions,
    }, null, 2));
    await testInfo.attach("synthetic-decision-evidence", { path: evidencePath, contentType: "application/json" });
    expect(blocked.get(page), "all unexpected browser requests/errors").toEqual([]);
    expect(after?.unexpected ?? [], "all guarded external effects").toEqual([]);
    expect(after?.intervals ?? 0).toBe(0);
    expect(after?.counts.analyticsTimers ?? 0).toBe(0);
    expect(after?.counts.cleanups ?? 0).toBe(after?.counts.mounts ?? 0);
    expect(after?.tasks.filter((task) => task.rejected !== null) ?? [], "actual core actions must not throw").toEqual([]);
    expect(after?.persistence.forbidden ?? [], "no app access to durable personal state").toEqual([]);
  } finally {
    held.delete(page);
    blocked.delete(page);
    phases.delete(page);
  }
});

function hold(page: Page, leaf: "current" | "wait") {
  held.get(page)!.set(leaf, { requested: false, release: () => {} });
}
function release(page: Page, leaf: "current" | "wait") {
  const gate = held.get(page)!.get(leaf);
  if (!gate?.requested) throw new Error(`lazy_leaf_not_requested:${leaf}`);
  gate.release();
  held.get(page)!.delete(leaf);
}
type HarnessClockMode = "controlled" | "real";
async function boot(
  page: Page,
  options: BootOptions = {},
  installClock = true,
  clockMode: HarnessClockMode = "controlled",
) {
  await page.goto(`${origin}/decision-analytics-test`);
  return initializePage(page, options, installClock, clockMode);
}
async function initializePage(
  page: Page,
  options: BootOptions,
  installClock: boolean,
  clockMode: HarnessClockMode = "controlled",
) {
  await page.waitForFunction(() => Boolean(window.decisionAnalytics));
  if (clockMode === "controlled") {
    if (installClock) await page.clock.install({ time: new Date(fixtures.asOf) });
    else await page.clock.setSystemTime(new Date(fixtures.asOf));
    await page.clock.pauseAt(new Date(fixtures.asOf));
  }
  const seeded = await page.evaluate(async ({ options, asOf }) => {
    window.decisionPersistence.configure(options.denyStorage === true);
    return options.seedPersonal ? window.decisionPersistence.seed(asOf) : null;
  }, { options, asOf: fixtures.asOf });
  await page.evaluate(async ({ fixtures, options }) => {
    await window.decisionAnalytics.initialize(fixtures, options);
  }, { fixtures, options });
  if (options.composition === "production") {
    await expect.poll(async () => (await state(page)).counts).toMatchObject({ mounts: 1, cleanups: 0 });
  } else {
    await expect.poll(async () => (await state(page)).counts).toMatchObject({ mounts: 2, cleanups: 1 });
  }
  return seeded;
}
async function reloadApp(page: Page, options: BootOptions) {
  await page.reload();
  await initializePage(page, { ...options, seedPersonal: false }, false);
}
async function recordPhase(page: Page, label: string, inventory?: PersonalInventory) {
  const value = await state(page);
  phases.get(page)!.push({ label, state: value, ...(inventory ? { inventory } : {}) });
  return value;
}
async function state(page: Page): Promise<Snapshot> {
  await page.evaluate(() => window.decisionAnalytics.flush());
  return page.evaluate(() => window.decisionAnalytics.snapshot());
}
function stages(value: Snapshot, stage: Stage) {
  return value.events.filter((event) => event.stage === stage);
}
async function tick(page: Page, milliseconds: number) {
  await page.evaluate(() => window.decisionAnalytics.openAct());
  await page.clock.runFor(milliseconds);
  await page.evaluate(() => window.decisionAnalytics.closeAct());
}
async function beginCore(page: Page, snapshot = input) {
  await page.evaluate((value) => window.decisionAnalytics.action("restore", value), snapshot);
  await page.evaluate(() => window.decisionAnalytics.action("calculate"));
  await page.evaluate(() => window.decisionAnalytics.waitRequest(0));
}
async function beginApp(page: Page, level = 0) {
  await page.locator(`[data-level="${level}"]`).click();
  for (const [id, value] of [["blueStock", "59"], ["purpleStock", "39"], ["yellowStock", "19"]]) {
    await page.locator(`#${id}`).fill(value!);
    await page.locator(`#${id}`).blur();
  }
  await page.locator("#calculateButton").click();
  await page.evaluate(() => window.decisionAnalytics.waitRequest(0));
}
async function finish(
  page: Page,
  index = 0,
  result: SyntheticResult = {},
  clockMode: HarnessClockMode = "controlled",
) {
  await page.evaluate(({ index, result }) => window.decisionAnalytics.finish(index, result), { index, result });
  if (clockMode === "controlled") await tick(page, 300);
}
async function showLeaf(page: Page, selector: string) {
  const leaf = page.locator(selector);
  await expect(leaf).toBeVisible();
  await leaf.scrollIntoViewIfNeeded();
  await expect(leaf).toBeInViewport();
}
async function expose(page: Page) {
  release(page, "current");
  release(page, "wait");
  await showLeaf(page, currentLeaf);
  await expect.poll(async () => stages(await state(page), "current_presented").length).toBe(1);
  await showLeaf(page, waitLeaf);
  await expect.poll(async () => stages(await state(page), "wait_presented").length).toBe(1);
}

test("same acquired final stores Current AND WAIT; neither lazy fallback counts as exposure", async ({ page }) => {
  hold(page, "current"); hold(page, "wait");
  await boot(page);
  await beginApp(page);
  await page.evaluate(() => window.decisionAnalytics.current(0));
  expect(stages(await state(page), "calculation")).toEqual([]);
  await tick(page, 120);
  await page.evaluate(() => window.decisionAnalytics.finish(0));
  expect(stages(await state(page), "calculation")).toEqual([]);
  await tick(page, 180);
  const accepted = await state(page);
  expect(stages(accepted, "calculation")).toHaveLength(1);
  expect(stages(accepted, "current_presented")).toEqual([]);
  expect(stages(accepted, "wait_presented")).toEqual([]);
  const expectedHash = (JSON.parse(fixtures.a.pointer.statement) as { contentHash: string }).contentHash;
  expect(stages(accepted, "calculation")[0]!.data).toEqual({
    producerVersion: "TEST-ONLY-mounted-v3",
    producerCodeHash: CERTIFIED_STAGING_ENGINE_PROFILE.codeHash,
    publicationContentHash: expectedHash, currentAction: "use_blue", waitRecommended: true,
    holdings: { blue: "fifty_to_one_ninety_nine", purple: "ten_to_forty_nine", yellow: "ten_to_forty_nine" },
    expectedSupply: { blue: "one_to_nine", purple: "zero", yellow: "ten_to_forty_nine" },
  });
  expect(expectedHash).not.toBe(accepted.requests[0]!.sourceHash);
  await expect.poll(() => held.get(page)!.get("current")!.requested).toBe(true);
  release(page, "current");
  await showLeaf(page, currentLeaf);
  await expect.poll(async () => stages(await state(page), "current_presented").length).toBe(1);
  expect(stages(await state(page), "wait_presented")).toEqual([]);
  await expect.poll(() => held.get(page)!.get("wait")!.requested).toBe(true);
  release(page, "wait");
  await showLeaf(page, waitLeaf);
  await expect.poll(async () => stages(await state(page), "wait_presented").length).toBe(1);
  const complete = await state(page);
  expect(stages(complete, "wait_presented")).toHaveLength(1);
  expect(new Set(complete.events.map((event) => event.decisionId)).size).toBe(1);
  expect(stages(complete, "outcome_confirmation")).toEqual([]);
  expect(stages(complete, "attempt_self_report")).toEqual([]);
  await page.locator("#calculateButton").click();
  await page.evaluate(() => window.decisionAnalytics.waitRequest(1));
  await finish(page, 1);
  const repeated = await state(page);
  const calculations = stages(repeated, "calculation");
  expect(calculations).toHaveLength(2);
  expect(calculations[0]!.decisionId).not.toBe(calculations[1]!.decisionId);
  expect(repeated.requests[1]!.stock).toEqual(repeated.requests[0]!.stock);
  expect(repeated.requests[1]!.grade).toBe(repeated.requests[0]!.grade);
  expect(repeated.requests[1]!.level).toBe(repeated.requests[0]!.level);
  for (const event of calculations) {
    expect(Object.keys(event.data).sort()).toEqual([
      "currentAction", "expectedSupply", "holdings", "producerCodeHash",
      "producerVersion", "publicationContentHash", "waitRecommended",
    ]);
    expect(event.data).toMatchObject({ currentAction: "use_blue", waitRecommended: true });
  }
  await recordPhase(page, "same tab and same physical input: separate calculations, no visitor dimension");
});

for (const leaf of ["current", "wait"] as const) {
  test(`hidden ${leaf} leaf is not exposure even when the other leaf is visible`, async ({ page }) => {
    hold(page, "current"); hold(page, "wait");
    await boot(page); await beginApp(page); await finish(page);
    const selector = leaf === "current" ? currentLeaf : waitLeaf;
    await page.addStyleTag({ content: `${selector} { visibility: hidden !important; }` });
    await exposeExceptHidden(page, leaf);
    expect(stages(await state(page), leaf === "current" ? "current_presented" : "wait_presented")).toEqual([]);
    expect(stages(await state(page), leaf === "current" ? "wait_presented" : "current_presented")).toHaveLength(1);
  });
}
async function exposeExceptHidden(page: Page, leaf: "current" | "wait") {
  await expect.poll(() => [...held.get(page)!.values()].every((gate) => gate.requested)).toBe(true);
  release(page, "current"); release(page, "wait");
  const hidden = page.locator(leaf === "current" ? currentLeaf : waitLeaf);
  await expect(hidden).toBeAttached();
  await expect(hidden).toBeHidden();
  await showLeaf(page, leaf === "current" ? waitLeaf : currentLeaf);
  await expect.poll(async () =>
    stages(await state(page), leaf === "current" ? "wait_presented" : "current_presented").length).toBe(1);
}

for (const condition of ["inert", "hidden", "synthetic-background"] as const) {
  test(`${condition} shell excludes independently committed Current and WAIT`, async ({ page }) => {
    hold(page, "current"); hold(page, "wait");
    await boot(page); await beginApp(page); await finish(page);
    if (condition === "synthetic-background")
      await page.evaluate(() => window.decisionAnalytics.visibility("hidden"));
    else await page.locator("#calculatorWorkspace").evaluate((element, condition) => {
      if (condition === "inert") element.setAttribute("inert", "");
      else (element as HTMLElement).hidden = true;
    }, condition);
    await expect.poll(() => [...held.get(page)!.values()].every((gate) => gate.requested)).toBe(true);
    release(page, "current"); release(page, "wait");
    await expect(page.locator(currentLeaf)).toBeAttached();
    await expect(page.locator(waitLeaf)).toBeAttached();
    const value = await state(page);
    expect(stages(value, "current_presented")).toEqual([]);
    expect(stages(value, "wait_presented")).toEqual([]);
  });
}

test("375px keeps one-line three-column inventory and probability cards plus conditional WAIT", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  hold(page, "current"); hold(page, "wait");
  await boot(page);
  for (const [id, value] of [["blueStock", "59"], ["purpleStock", "39"], ["yellowStock", "19"]]) {
    await page.locator(`#${id}`).fill(value!); await page.locator(`#${id}`).blur();
  }
  const inventory = await page.locator("#blueStock, #purpleStock, #yellowStock").evaluateAll(
    (elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width };
    }),
  );
  expect(inventory).toHaveLength(3);
  expect(Math.max(...inventory.map((rect) => rect.y)) - Math.min(...inventory.map((rect) => rect.y))).toBeLessThanOrEqual(1);
  expect(inventory.every((rect) => rect.width > 0)).toBe(true);
  await page.locator(".mobile-action-bar button").filter({ hasText: /계산/ }).click();
  await page.evaluate(() => window.decisionAnalytics.waitRequest(0));
  await finish(page);
  await expect.poll(() => [...held.get(page)!.values()].every((gate) => gate.requested)).toBe(true);
  await expose(page);
  const cards = page.locator("#detailBox .metric-grid > .metric");
  await expect(cards).toHaveCount(3);
  const geometry = await cards.evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width };
  }));
  expect(Math.max(...geometry.map((rect) => rect.y)) - Math.min(...geometry.map((rect) => rect.y))).toBeLessThanOrEqual(1);
  expect(geometry.every((rect) => rect.width > 0)).toBe(true);
  expect(geometry[0]!.x).toBeLessThan(geometry[1]!.x);
  expect(geometry[1]!.x).toBeLessThan(geometry[2]!.x);
  await page.locator("#mobile-tab-input").click();
  await page.locator("#blueStock").fill("60");
  await page.locator("#blueStock").blur();
  await page.locator(".mobile-action-bar button").filter({ hasText: /계산/ }).click();
  await page.evaluate(() => window.decisionAnalytics.waitRequest(1));
  await finish(page, 1, { wait: false });
  await expect(cards).toHaveCount(2);
});

test("obsolete lazy leaves cannot publish presentation into a replacement episode", async ({ page }) => {
  hold(page, "current"); hold(page, "wait");
  await boot(page); await beginApp(page); await finish(page);
  const oldId = stages(await state(page), "calculation")[0]!.decisionId;
  await page.locator('[data-level="1"]').click();
  await expect.poll(() => [...held.get(page)!.values()].every((gate) => gate.requested)).toBe(true);
  release(page, "current"); release(page, "wait");
  await expect(page.locator(currentLeaf)).toBeAttached();
  await expect(page.locator(waitLeaf)).toHaveCount(0);
  expect(stages(await state(page), "current_presented")).toEqual([]);
  expect(stages(await state(page), "wait_presented")).toEqual([]);
  await page.locator("#calculateButton").click();
  await page.evaluate(() => window.decisionAnalytics.waitRequest(1));
  await finish(page, 1);
  await showLeaf(page, currentLeaf);
  await expect.poll(async () => stages(await state(page), "current_presented").length).toBe(1);
  await showLeaf(page, waitLeaf);
  await expect.poll(async () => stages(await state(page), "wait_presented").length).toBe(1);
  const value = await state(page);
  expect(stages(value, "calculation")).toHaveLength(2);
  for (const stage of ["current_presented", "wait_presented"] as const) {
    expect(stages(value, stage)).toHaveLength(1);
    expect(stages(value, stage)[0]!.decisionId).not.toBe(oldId);
  }
});

test("R1 preservation: visible Current counts once while WAIT is still unloaded, then WAIT counts separately", async ({ page }) => {
  hold(page, "wait");
  await boot(page); await beginApp(page); await finish(page, 0, { preserve: true });
  const value = await state(page);
  expect(stages(value, "calculation")[0]!.data).toMatchObject({
    currentAction: "preserve", waitRecommended: true,
  });
  await expect(page.locator(currentLeaf)).toHaveCount(0);
  await showLeaf(page, preservationLeaf);
  await expect.poll(async () => stages(await state(page), "current_presented").length).toBe(1);
  expect(stages(await state(page), "wait_presented")).toEqual([]);
  await expect.poll(() => held.get(page)!.get("wait")!.requested).toBe(true);
  release(page, "wait");
  await showLeaf(page, waitLeaf);
  await expect.poll(async () => stages(await state(page), "wait_presented").length).toBe(1);
  await showLeaf(page, preservationLeaf);
  await showLeaf(page, waitLeaf);
  const final = await recordPhase(page, "visible Current preservation before separately revealed WAIT");
  const current = stages(final, "current_presented"), wait = stages(final, "wait_presented");
  expect(current).toHaveLength(1);
  expect(wait).toHaveLength(1);
  expect(current[0]!.decisionId).toBe(stages(final, "calculation")[0]!.decisionId);
  expect(wait[0]!.decisionId).toBe(current[0]!.decisionId);
  expect(current[0]!.ordinal).toBeLessThan(wait[0]!.ordinal);
});

for (const condition of ["hidden", "inert"] as const) {
  test(`R1 preservation: ${condition} Current is excluded until genuinely revealed`, async ({ page }) => {
    hold(page, "wait");
    await boot(page); await beginApp(page);
    if (condition === "hidden")
      await page.locator("#resultBox").evaluate((node) => node.style.setProperty("visibility", "hidden"));
    if (condition === "inert") await page.locator("#calculatorWorkspace").evaluate((node) => node.setAttribute("inert", ""));
    await finish(page, 0, { preserve: true });
    await expect(page.locator(preservationLeaf)).toBeAttached();
    await page.locator(preservationLeaf).evaluate((node) => node.scrollIntoView({ block: "center" }));
    await expect(page.locator(preservationLeaf)).toBeInViewport();
    const before = await recordPhase(page, `${condition} preservation committed without exposure`);
    expect(stages(before, "calculation")[0]!.data).toMatchObject({ currentAction: "preserve", waitRecommended: true });
    expect(stages(before, "current_presented")).toEqual([]);
    expect(stages(before, "wait_presented")).toEqual([]);
    if (condition === "hidden") {
      await expect(page.locator(preservationLeaf)).toBeHidden();
      await page.locator("#resultBox").evaluate((node) => node.style.removeProperty("visibility"));
    } else {
      await expect(page.locator("#calculatorWorkspace")).toHaveAttribute("inert", "");
      await page.locator("#calculatorWorkspace").evaluate((node) => node.removeAttribute("inert"));
    }
    await showLeaf(page, preservationLeaf);
    await expect.poll(async () => stages(await state(page), "current_presented").length).toBe(1);
    expect(stages(await state(page), "wait_presented")).toEqual([]);
  });
}

test("R1 preservation: retired Current cannot attach to the replacement calculation", async ({ page }) => {
  hold(page, "wait");
  await boot(page); await beginApp(page);
  const hidden = await page.addStyleTag({ content: `${preservationLeaf} { visibility: hidden !important; }` });
  await finish(page, 0, { preserve: true });
  const old = stages(await state(page), "calculation")[0]!.decisionId;
  expect(stages(await state(page), "current_presented")).toEqual([]);
  await page.locator('[data-level="1"]').click();
  await hidden.evaluate((node) => { node.parentNode?.removeChild(node); });
  await showLeaf(page, preservationLeaf);
  const stale = await state(page);
  expect(stages(stale, "current_presented")).toEqual([]);
  expect(stages(stale, "terminal")).toHaveLength(1);
  expect(stages(stale, "terminal")[0]).toMatchObject({ decisionId: old, data: { reason: "input_edit" } });
  await page.locator("#calculateButton").click();
  await page.evaluate(() => window.decisionAnalytics.waitRequest(1));
  await finish(page, 1);
  await showLeaf(page, currentLeaf);
  await expect.poll(async () => stages(await state(page), "current_presented").length).toBe(1);
  await expect.poll(() => held.get(page)!.get("wait")!.requested).toBe(true);
  release(page, "wait");
  await showLeaf(page, waitLeaf);
  await expect.poll(async () => stages(await state(page), "wait_presented").length).toBe(1);
  const final = await recordPhase(page, "retired preservation remains unexposed; new Current and WAIT own their receipts");
  expect(stages(final, "calculation")).toHaveLength(2);
  for (const stage of ["current_presented", "wait_presented"] as const) {
    expect(stages(final, stage)).toHaveLength(1);
    expect(stages(final, stage)[0]!.decisionId).not.toBe(old);
  }
});

test("R1 preservation: unrelated final-target callout creates no Current or WAIT episode", async ({ page }) => {
  await boot(page);
  await page.locator('[data-grade="SR"]').click();
  await page.locator('[data-level="15"]').click();
  await showLeaf(page, preservationLeaf);
  const value = await recordPhase(page, "generic completion callout, not a certified preservation recommendation");
  expect(value.requests).toEqual([]);
  expect(value.events).toEqual([]);
  expect(value.counts.analyticsIds).toBe(0);
});

for (const reason of ["error", "limit", "cancel"] as const) {
  test(`${reason} with a retained nonfinal checkpoint never creates a calculation episode`, async ({ page }) => {
    await boot(page, { harness: "core" }); await beginCore(page);
    await page.evaluate(() => window.decisionAnalytics.current(0));
    await page.evaluate((reason) => window.decisionAnalytics.fail(0, reason), reason);
    await tick(page, 300);
    expect(stages(await state(page), "calculation")).toEqual([]);
  });
}

for (const supersession of ["restore", "forecast", "unmount"] as const) {
  test(`${supersession} during deferred cleanup rejects the old completed candidate`, async ({ page }) => {
    await boot(page, { harness: "core" }); await beginCore(page);
    await tick(page, 120);
    await page.evaluate(() => window.decisionAnalytics.finish(0));
    expect(stages(await state(page), "calculation")).toEqual([]);
    if (supersession === "restore")
      await page.evaluate((value) => window.decisionAnalytics.action("restore", value), { ...input, level: 1 });
    else if (supersession === "forecast")
      await page.evaluate(() => window.decisionAnalytics.publication("b"));
    else await page.evaluate(() => window.decisionAnalytics.unmount());
    await tick(page, 180);
    expect(stages(await state(page), "calculation")).toEqual([]);
  });
}

for (const outcome of ["success", "fail"] as const) {
  test(`accepted ${outcome} belongs to old run before a failing automatic solve`, async ({ page }) => {
    hold(page, "current"); hold(page, "wait");
    await boot(page); await beginApp(page); await finish(page, 0, { uses: outcome === "success" ? 1 : 2 });
    await expect.poll(() => [...held.get(page)!.values()].every((gate) => gate.requested)).toBe(true);
    await expose(page);
    await page.locator("#resultBox .outcome-buttons button").nth(outcome === "success" ? 0 : 1).click();
    expect(stages(await state(page), "outcome_confirmation")).toEqual([]);
    await page.locator("#resultBox").getByRole("button", {
      name: outcome === "success" ? "대성공 O 확정" : "대성공 X 확정", exact: true,
    }).click();
    await page.evaluate(() => window.decisionAnalytics.waitRequest(1));
    const beforeFailure = await state(page);
    const receipt = stages(beforeFailure, "outcome_confirmation");
    expect(receipt).toHaveLength(1);
    expect(receipt[0]!.data).toEqual({ outcome });
    expect(receipt[0]!.decisionId).toBe(stages(beforeFailure, "calculation")[0]!.decisionId);
    expect(beforeFailure.events.findIndex((event) => event.stage === "outcome_confirmation"))
      .toBeLessThan(beforeFailure.events.findIndex((event) => event.stage === "terminal"));
    await page.evaluate(() => window.decisionAnalytics.fail(1, "error"));
    await tick(page, 300);
    expect(stages(await state(page), "outcome_confirmation")).toEqual(receipt);
    expect(stages(await state(page), "attempt_self_report")).toEqual([]);
  });
}

for (const attempt of ["positive", "null"] as const) {
  test(`explicit success remains observed after ${attempt} modal submission; count is separate`, async ({ page }) => {
    hold(page, "current"); hold(page, "wait");
    await boot(page); await beginApp(page, 14); await finish(page);
    await expect.poll(() => [...held.get(page)!.values()].every((gate) => gate.requested)).toBe(true);
    await expose(page);
    await page.locator("#resultBox .outcome-buttons button").first().click();
    await page.locator("#resultBox").getByRole("button", { name: "대성공 O 확정", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const outcome = stages(await state(page), "outcome_confirmation")[0]!;
    expect(outcome.data).toEqual({ outcome: "success" });
    if (attempt === "positive") await dialog.locator(".attempt-choice-button").first().click();
    else await dialog.getByRole("button", { name: "취소", exact: true }).click();
    const value = await state(page), attempts = stages(value, "attempt_self_report");
    expect(stages(value, "outcome_confirmation")).toEqual([outcome]);
    if (attempt === "positive") {
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.data).toEqual({ attempts: "one", outcomeEventId: outcome.eventId });
      expect(attempts[0]!.decisionId).toBe(outcome.decisionId);
    } else expect(attempts).toEqual([]);
  });
}

test("captured real modal/outcome callbacks cannot rebind after restore and a new accepted run", async ({ page }) => {
  await boot(page, { harness: "core" }); await beginCore(page, { ...input, level: 14 }); await finish(page);
  await page.evaluate(() => window.decisionAnalytics.action("outcome", "success"));
  expect((await state(page)).core!.modal.open).toBe(true);
  await page.evaluate(() => window.decisionAnalytics.captureCallbacks());
  await page.evaluate((value) => window.decisionAnalytics.action("restore", value), { ...input, grade: "SR" as const, level: 3 });
  await page.evaluate(() => window.decisionAnalytics.action("calculate"));
  await page.evaluate(() => window.decisionAnalytics.waitRequest(1));
  await finish(page, 1);
  const before = await state(page);
  await page.evaluate(() => window.decisionAnalytics.invokeCaptured());
  const after = await state(page);
  expect(stages(after, "attempt_self_report")).toEqual([]);
  expect(stages(after, "outcome_confirmation")).toEqual(stages(before, "outcome_confirmation"));
  expect(after.requests).toHaveLength(2);
});

test("normalized no-ops preserve the episode; genuine edit captures action before retirement", async ({ page }) => {
  await boot(page, { harness: "core" }); await beginCore(page); await finish(page);
  const before = await state(page);
  await page.evaluate(async () => {
    const api = window.decisionAnalytics;
    await api.action("grade", "R"); await api.action("level", 0.9); await api.action("exp", -1);
    await api.action("stock", { blue: 59.9, purple: 39.9, yellow: 19.9 });
  });
  expect((await state(page)).events).toEqual(before.events);
  await page.evaluate(() => window.decisionAnalytics.action("level", 1));
  const value = await state(page);
  expect(value.events.slice(before.events.length).map((event) => [event.stage, event.data])).toEqual([
    ["first_action", { action: "input_edit" }], ["terminal", { reason: "input_edit" }],
  ]);
  expect(value.sentAt.find((entry) => entry.stage === "first_action")!.level).toBe(0);
  expect(value.core!.state.level).toBe(1);
});

test("outcome follow-up final enters the same acquired-run acceptance path", async ({ page }) => {
  await boot(page, { harness: "core" });
  await page.evaluate((value) => window.decisionAnalytics.action("restore", value), input);
  await page.evaluate(() => window.decisionAnalytics.action("calculate"));
  await page.evaluate(() => window.decisionAnalytics.waitRequest(0));
  await finish(page);
  await page.evaluate(() => window.decisionAnalytics.action("outcome", "fail"));
  await page.evaluate(() => window.decisionAnalytics.waitRequest(1));
  await finish(page, 1);
  expect(stages(await state(page), "calculation")).toHaveLength(2);
});

test("real R15 conversion creates only the accepted SR5 episode", async ({ page }) => {
  await boot(page);
  await page.locator('[data-level="15"]').click();
  for (const [id, value] of [["blueStock", "59"], ["purpleStock", "39"], ["yellowStock", "19"]]) {
    await page.locator(`#${id}`).fill(value!); await page.locator(`#${id}`).blur();
  }
  await page.locator("#resultBox button").first().click();
  await page.evaluate(() => window.decisionAnalytics.waitRequest(0));
  expect((await state(page)).requests[0]).toMatchObject({ grade: "SR", level: 5 });
  expect(stages(await state(page), "calculation")).toEqual([]);
  await finish(page);
  expect(stages(await state(page), "calculation")).toHaveLength(1);
});

test("OFF and unconfigured integrations add no analytics resources relative to actual App baseline", async ({ page }) => {
  const observations: Array<{ mode: string; state: Snapshot }> = [];
  for (const mode of ["baseline", "off", "unconfigured"] as const) {
    await boot(page, { mode }, true, "real");
    await beginApp(page); await finish(page, 0, {}, "real");
    await expect(page.locator(currentLeaf)).toBeVisible();
    await expect(page.locator(waitLeaf)).toBeVisible();
    const value = await state(page);
    expect(value.events).toEqual([]);
    expect(value.counts).toMatchObject({ analyticsIds: 0, analyticsSchedules: 0, analyticsTimers: 0 });
    observations.push({ mode, state: value });
    await page.evaluate(() => window.decisionAnalytics.unmount());
    expect((await state(page)).unexpected, mode).toEqual([]);
  }
  const baseline = observations[0]!.state;
  for (const observation of observations.slice(1)) {
    expect(observation.state.listeners, observation.mode).toEqual(baseline.listeners);
    expect(observation.state.timers, observation.mode).toBe(baseline.timers);
    expect(observation.state.intervals, observation.mode).toBe(baseline.intervals);
    expect(observation.state.counts.forecastFetches, observation.mode).toBe(baseline.counts.forecastFetches);
    expect(observation.state.unexpected, observation.mode).toEqual([]);
  }
});

test("volatile profile ignores and preserves legacy personal records and suspends account initialization", async ({ page }) => {
  const options: BootOptions = {
    composition: "production", legacyAccountFlag: true, legacyStatsConfig: true, seedPersonal: true,
  };
  const seeded = await boot(page, options);
  await recordPhase(page, "fixture-owned inventory seeded before App import", seeded!);
  await expect(page.locator("[data-account-trigger], [data-account-checking]")).toHaveCount(0);
  await expect(page.locator('[data-grade="R"][aria-pressed=true]')).toHaveCount(1);
  await expect(page.locator('[data-level="0"][aria-pressed=true]')).toHaveCount(1);
  await expect(page.locator("#blueStock")).toHaveValue("");
  await tick(page, 30_000);
  expect((await state(page)).legacyEvents).toEqual([]);
  await beginApp(page); await finish(page);
  expect(stages(await state(page), "calculation")).toHaveLength(1);
  expect((await recordPhase(page, "seeded records after real calculation")).persistence.forbidden).toEqual([]);
  const retained = await page.evaluate(() => window.decisionPersistence.inventory(true));
  expect(retained).toEqual(seeded);
  await recordPhase(page, "native inventory unchanged after live calculation", retained);
  await reloadApp(page, options);
  await tick(page, 30_000);
  await expect(page.locator("#blueStock")).toHaveValue("");
  await expect(page.locator("[data-account-trigger], [data-account-checking]")).toHaveCount(0);
  const reloaded = await recordPhase(page, "same persisted records after reload: not restored or replayed");
  expect(reloaded.events).toEqual([]);
  expect(reloaded.legacyEvents).toEqual([]);
  expect(reloaded.persistence.forbidden).toEqual([]);
  const retainedAfterReload = await page.evaluate(() => window.decisionPersistence.inventory(true));
  expect(retainedAfterReload).toEqual(seeded);
  await recordPhase(page, "native inventory unchanged after actual document reload", retainedAfterReload);
});

test("storage-denied edits outcomes conversion and undo work in RAM; reload discards state and pending queue", async ({ page }) => {
  const options: BootOptions = {
    composition: "production", legacyAccountFlag: true, legacyStatsConfig: true, denyStorage: true,
  };
  await boot(page, options);
  await beginApp(page); await finish(page, 0, { uses: 1 });
  await page.evaluate(() => window.decisionAnalytics.holdLegacySender());
  await page.locator("#resultBox").getByRole("button", { name: "대성공 O", exact: true }).click();
  await page.locator("#resultBox").getByRole("button", { name: "대성공 O 확정", exact: true }).click();
  await page.evaluate(() => window.decisionAnalytics.waitRequest(1));
  await finish(page, 1, { uses: 1 });
  await expect.poll(async () => (await state(page)).legacyPending).toBe(1);
  expect(stages(await state(page), "outcome_confirmation").map((event) => event.data)).toEqual([{ outcome: "success" }]);
  await page.locator('[data-grade="R"]').click();
  await page.locator('[data-level="6"]').click();
  for (const [id, value] of [
    ["currentExp", "100"], ["blueStock", "66"], ["purpleStock", "55"], ["yellowStock", "44"],
  ]) { await page.locator(`#${id}`).fill(value!); await page.locator(`#${id}`).blur(); }
  await page.locator("#resetButton").click();
  await expect(page.locator("#blueStock")).toHaveValue("");
  await page.getByRole("button", { name: "입력 초기화 되돌리기", exact: true }).click();
  await expect(page.locator('[data-level="6"][aria-pressed=true]')).toHaveCount(1);
  for (const [id, value] of [
    ["currentExp", "100"], ["blueStock", "66"], ["purpleStock", "55"], ["yellowStock", "44"],
  ]) await expect(page.locator(`#${id}`)).toHaveValue(value!);
  await page.locator('[data-level="15"]').click();
  await page.locator("#resultBox .convert-button").click();
  await page.evaluate(() => window.decisionAnalytics.waitRequest(2));
  await finish(page, 2, { uses: 1 });
  expect(stages(await state(page), "calculation")).toHaveLength(3);
  const beforeReload = await recordPhase(page, "denied storage: real outcome, undo, conversion, pending memory queue");
  expect(beforeReload.legacyEvents).toHaveLength(1);
  expect(beforeReload.legacyProviderUses).toBe(1);
  expect(beforeReload.persistence.forbidden).toEqual([]);
  expect(beforeReload.persistence.calls.some((call) => call.denied && call.key === "collectionThemeMode")).toBe(true);
  await reloadApp(page, options);
  await tick(page, 30_000);
  await expect(page.locator("#blueStock")).toHaveValue("");
  await expect(page.locator('[data-grade="R"][aria-pressed=true]')).toHaveCount(1);
  await expect(page.locator('[data-level="0"][aria-pressed=true]')).toHaveCount(1);
  await expect(page.getByRole("button", { name: "입력 초기화 되돌리기", exact: true })).toHaveCount(0);
  const afterReload = await recordPhase(page, "new document: no restored inputs, undo, decision, or pending delivery");
  expect(afterReload.events).toEqual([]);
  expect(afterReload.legacyEvents).toEqual([]);
  expect(afterReload.legacyPending).toBe(0);
  expect(afterReload.persistence.forbidden).toEqual([]);
  const discarded = await page.evaluate(() => window.decisionPersistence.inventory());
  expect(discarded.local).toEqual({});
  expect(discarded.session).toEqual({});
  expect(discarded.cookie).toBe("");
  await recordPhase(page, "no durable queue or personal keys after storage-denied workflow", discarded);
});

test("fresh durable state is theme only; language follows URL while calculator state resets on reload", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const options: BootOptions = { composition: "production", legacyAccountFlag: true };
  await boot(page, options);
  const fresh = await page.evaluate(() => window.decisionPersistence.inventory());
  expect(fresh.local).toEqual({});
  expect(fresh.session).toEqual({});
  expect(fresh.cookie).toBe("");
  await page.locator('[data-theme-mode="dark"]').click();
  await expect(page.locator("body")).toHaveClass(/theme-dark/);
  await page.locator("#language-menu-trigger").click();
  await page.getByRole("menuitemradio", { name: "English", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/en/`);
  await page.locator('[data-level="4"]').click();
  await page.locator("#blueStock").fill("73"); await page.locator("#blueStock").blur();
  const preference = await page.evaluate(() => window.decisionPersistence.inventory());
  expect(preference.local).toEqual({ collectionThemeMode: "dark" });
  expect(preference.session).toEqual({});
  expect(preference.cookie).toBe("");
  await recordPhase(page, "only theme key written; locale is in URL", preference);
  expect((await recordPhase(page, "theme and URL language changed; collection input remains volatile")).persistence.forbidden).toEqual([]);
  await reloadApp(page, options);
  await expect(page).toHaveURL(`${origin}/en/`);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("body")).toHaveClass(/theme-dark/);
  await expect(page.locator("#blueStock")).toHaveValue("");
  await expect(page.locator('[data-level="0"][aria-pressed=true]')).toHaveCount(1);
  const persisted = await page.evaluate(() => window.decisionPersistence.inventory());
  expect(persisted.local).toEqual({ collectionThemeMode: "dark" });
  expect(persisted.session).toEqual({});
  expect(persisted.cookie).toBe("");
  await recordPhase(page, "reload retains only theme preference and URL-selected language", persisted);
});

test("fixture startup retains local layout CSS without devclient transport or solver requests", async ({ page }) => {
  await boot(page, { mode: "baseline" });
  await expect(page.locator("#calculateButton")).toBeVisible();
  await expect(page.locator("#calculateButton")).toBeDisabled();
  await expect(page.locator("#levelGrid")).toHaveCSS("display", "grid");
  const value = await state(page);
  expect(value.requests).toEqual([]);
  expect(value.events).toEqual([]);
  expect(value.counts.forecastFetches).toBe(0);
  expect(value.unexpected).toEqual([]);
  expect(blocked.get(page)).toEqual([]);
  expect(devClientTransportSuppressions).toBeGreaterThan(0);
});
