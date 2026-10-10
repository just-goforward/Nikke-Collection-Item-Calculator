import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type Browser, chromium, expect, type Page, test } from "@playwright/test";
import { build, type PreviewServer, preview } from "vite";
import { certifiedMessages } from "../src/certifiedUi/messages";
import { enMessages } from "../src/i18n/messages.en";
import {
  expectApprovedReviewHealthAttempts,
  isReviewCollector,
  type ReviewHealthAttempt,
  serveReviewHealth,
} from "./reviewHealth";

type VisibilityTraceEntry = {
  phase: string;
  wall?: number;
  message?: { type: string; id?: number; generation?: number; deadlineAt?: number };
  state?: DocumentVisibilityState;
  trusted?: boolean;
};

declare global {
  interface Window {
    __visibilityTrace: VisibilityTraceEntry[];
    __hideOnCurrent?: boolean;
    __currentVisibility?: () => Promise<void>;
    __holdCertifiedPreparation?: boolean;
    __releaseCertifiedPreparation?: () => void;
    __observeCertifiedPreparation: (preparation: Promise<unknown>) => Promise<unknown>;
  }
}

const visibilityPort = Number(process.env["CERTIFIED_VISIBILITY_PORT"] ?? 4299);
const debugPort = Number(process.env["CERTIFIED_VISIBILITY_CDP_PORT"] ?? 27634);
const visibilityAdapter =
  process.env["CERTIFIED_VISIBILITY_ADAPTER"] ?? (process.platform === "win32" ? "native" : "tab");
if (!["native", "tab"].includes(visibilityAdapter))
  throw new Error("Unknown certified visibility adapter");
if (visibilityAdapter === "native" && process.platform !== "win32")
  throw new Error("Native certified visibility adapter requires Windows");
const healthAttempts: ReviewHealthAttempt[] = [];
const blockedRequests: string[] = [];
const directory = resolve("benchmarks/results", `certified-visibility-ui-${Date.now()}`);
let child: ChildProcess | undefined;
let browser: Browser | undefined;
let server: PreviewServer | undefined;
let page: Page;
let cover: Page | undefined;
const observations: unknown[] = [];

test.beforeAll(async () => {
  test.setTimeout(120_000);
  await mkdir(directory, { recursive: true });
  await build({
    configLoader: "native",
    ...(process.env["SOLVER_A_VITE_CACHE_DIR"]
      ? { cacheDir: process.env["SOLVER_A_VITE_CACHE_DIR"] }
      : {}),
    build: { outDir: join(directory, "dist") },
    plugins: [
      {
        name: "visibility-observation-and-preparation-gate",
        enforce: "pre",
        transform(code, id) {
          if (!id.endsWith("/useCertifiedRun.ts")) return;
          return code
            .replace(
              "prepareCertifiedForecast(asOf),",
              "globalThis.__observeCertifiedPreparation(prepareCertifiedForecast(asOf)),",
            )
            .replace(
              "onSnapshot(currentSnapshot);",
              `globalThis.__visibilityTrace?.push({ phase: "prepared_snapshot_accepted" });\n      onSnapshot(currentSnapshot);`,
            )
            .replace(
              "const kind = certifiedRunError(failure,",
              `globalThis.__visibilityTrace?.push({ phase: "client_rejection", code: failure.code, boundCause: controller.signal.reason === visibility?.cause, reason: controller.signal.reason });\n        const kind = certifiedRunError(failure,`,
            )
            .replace(
              "setResult(run.output);",
              `globalThis.__visibilityTrace?.push({ phase: "client_result", status: run.output.status, reason: run.output.refusal?.reason, boundCause: controller.signal.reason === visibility?.cause });\n      setResult(run.output);`,
            );
        },
      },
    ],
  });
  server = await preview({
    configFile: false,
    ...(process.env["SOLVER_A_VITE_CACHE_DIR"]
      ? { cacheDir: process.env["SOLVER_A_VITE_CACHE_DIR"] }
      : {}),
    build: { outDir: join(directory, "dist") },
    preview: { host: "127.0.0.1", port: visibilityPort, strictPort: true },
  });
  const args = [
    "--no-sandbox",
    "--disable-gpu",
    "--disable-features=CalculateNativeWinOcclusion",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--proxy-server=http://127.0.0.1:1",
    "--proxy-bypass-list=127.0.0.1;localhost;[::1]",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]",
    `--remote-debugging-port=${debugPort}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${join(directory, "owned-profile")}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];
  child = spawn(chromium.executablePath(), args, { windowsHide: true, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      break;
    } catch {
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, {
    noDefaults: true,
    timeout: 5000,
  });
  const context = browser.contexts()[0];
  if (!context) throw new Error("Owned browser context missing");
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (!isLoopback(url) && !isReviewCollector(url))
      blockedRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
  });
  // Keep browser verification local; only the approved metadata GET is answered by a local mock.
  await context.route(
    (url) => !isLoopback(url),
    (route) => route.abort("blockedbyclient"),
  );
  await serveReviewHealth(context, () => "blocked", healthAttempts);
  await context.addInitScript(() => {
    const trace: unknown[] = [];
    Object.assign(globalThis, { __visibilityTrace: trace });
    // Only hold delivery of the real forecast promise; hashing, validation and all solvers run normally.
    window.__observeCertifiedPreparation = (preparation) => {
      trace.push({ phase: "forecast_preparation_started", at: performance.now() });
      const prepared = preparation.then((value) => {
        trace.push({ phase: "forecast_preparation_completed", at: performance.now() });
        return value;
      });
      if (!window.__holdCertifiedPreparation) return prepared;
      window.__holdCertifiedPreparation = false;
      return new Promise((resolve, reject) => {
        window.__releaseCertifiedPreparation = () => {
          trace.push({ phase: "forecast_preparation_released", at: performance.now() });
          void prepared.then(resolve, reject);
        };
        void prepared.catch(reject);
      });
    };
    document.addEventListener("visibilitychange", (event) =>
      trace.push({
        phase: "visibility",
        state: document.visibilityState,
        trusted: event.isTrusted,
        at: performance.now(),
      }),
    );
    const original = AbortController.prototype.abort;
    AbortController.prototype.abort = function (reason) {
      trace.push({ phase: "abort", reason, at: performance.now() });
      return original.call(this, reason);
    };
    const NativeWorker = Worker;
    globalThis.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener("message", (event) => {
          trace.push({
            phase: "worker_response",
            type: event.data.type,
            id: event.data.id,
            generation: event.data.generation,
            at: performance.now(),
          });
          const host = window;
          if (event.data.type === "current" && host.__hideOnCurrent)
            void host.__currentVisibility?.();
        });
      }
      override postMessage(message: unknown) {
        trace.push({ phase: "worker_post", message, at: performance.now(), wall: Date.now() });
        super.postMessage(message);
      }
      override terminate() {
        trace.push({ phase: "worker_terminate", at: performance.now() });
        super.terminate();
      }
    };
  });
  page = await context.newPage();
  observations.push({
    args,
    visibilityAdapter,
    noDefaults: true,
    browserVersion: browser.version(),
    syntheticVisibilityOverride: false,
    manualVisibilityEventDispatch: false,
  });
});

test.beforeEach(async () => {
  const context = browser?.contexts()[0];
  if (!context) throw new Error("Owned browser context missing");
  if (page && !page.isClosed()) await page.close();
  page = await context.newPage();
  if (visibilityAdapter === "tab" && (!cover || cover.isClosed())) {
    cover = await context.newPage();
    await cover.goto("about:blank");
  }
  await page.goto(`http://127.0.0.1:${visibilityPort}/?statsEnv=staging&engine=certified`);
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
  await selectEnglish();
  await bringVisible();
  await expect(calculateButton()).toBeEnabled();
});

test.afterEach(async ({ browserName }, testInfo) => {
  if (page && !page.isClosed())
    observations.push({
      test: testInfo.title,
      retry: testInfo.retry,
      adapter: visibilityAdapter,
      browserName,
      trace: await page.evaluate(() => window.__visibilityTrace),
    });
  expectApprovedReviewHealthAttempts(
    healthAttempts,
    "visibility flows may only use the credential-free approved GET",
  );
});

test.afterAll(async () => {
  observations.push({ phase: "blocked_external_requests", attempts: blockedRequests });
  observations.push({ phase: "review_health_attempts", attempts: healthAttempts });
  if (page && !page.isClosed())
    observations.push(
      await page.evaluate(() => ({
        trace: window.__visibilityTrace,
      })),
    );
  if (browser) {
    // Dispose the owned contexts through Playwright before terminating Chrome.
    // A raw CDP Browser.close leaves their API request contexts in the runner.
    for (const context of browser.contexts()) await context.close();
    await browser.close();
  }
  child?.kill();
  if (server)
    await new Promise<void>((done, reject) =>
      server?.httpServer.close((error) => (error ? reject(error) : done())),
    );
  await writeFile(
    join(directory, "observations.json"),
    `${JSON.stringify(observations, null, 2)}\n`,
  );
  console.log(`VISIBILITY_EVIDENCE ${directory}`);
  expect(healthAttempts.map(({ mode }) => mode)).toContain("blocked");
  expectApprovedReviewHealthAttempts(healthAttempts, "visibility metadata attempts");
});

function isLoopback(url: URL) {
  return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

function calculateButton() {
  return page.locator("#calculateButton");
}

/** The certified route uses the shared top bar language menu. */
async function selectEnglish() {
  await page.locator("#language-menu-trigger").click();
  await page.getByRole("menuitemradio", { name: "English", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
}

/** Fill the shared StatePanel and StockPanel controls. */
async function setCertifiedInput(
  grade: "R" | "SR",
  level: number,
  exp: number,
  stock: Record<"blue" | "purple" | "yellow", number>,
) {
  await page
    .getByRole("group", { name: enMessages["state.gradeAria"] })
    .getByRole("button", { name: grade, exact: true })
    .click();
  await page
    .getByRole("button", {
      name: enMessages["common.phase"].replace("{phase}", String(level)),
      exact: true,
    })
    .click();
  if (level !== 15) {
    await page.locator("#currentExp").fill(exp ? String(exp) : "");
    await page.locator("#currentExp").blur();
  }
  for (const [kit, pieces] of Object.entries(stock))
    await page.locator(`#${kit}Stock`).fill(pieces ? String(pieces) : "");
}

async function expectCertifiedInput(grade: "R" | "SR", level: number, exp: string) {
  await expect(
    page
      .getByRole("group", { name: enMessages["state.gradeAria"] })
      .getByRole("button", { name: grade, exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", {
      name: enMessages["common.phase"].replace("{phase}", String(level)),
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#currentExp")).toHaveValue(exp);
}

async function hide() {
  const start = await page.evaluate(() => window.__visibilityTrace.length);
  if (visibilityAdapter === "tab") {
    if (!cover || cover.isClosed()) throw new Error("Owned visibility cover tab missing");
    await cover.bringToFront();
  } else {
    const cdp = await page.context().newCDPSession(page);
    const ownedWindow = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", {
      windowId: ownedWindow.windowId,
      bounds: { windowState: "minimized" },
    });
  }
  await expect
    .poll(() =>
      page.evaluate(
        (index) =>
          window.__visibilityTrace
            .slice(index)
            .some(
              (entry) => entry.phase === "visibility" && entry.state === "hidden" && entry.trusted,
            ),
        start,
      ),
    )
    .toBe(true);
  await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("hidden");
}

async function bringVisible() {
  const { hidden, start } = await page.evaluate(() => ({
    hidden: document.visibilityState === "hidden",
    start: window.__visibilityTrace.length,
  }));
  if (visibilityAdapter === "tab") {
    await page.bringToFront();
  } else {
    const cdp = await page.context().newCDPSession(page);
    const ownedWindow = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", {
      windowId: ownedWindow.windowId,
      bounds: { windowState: "normal" },
    });
    await page.bringToFront();
    const ownPid = child?.pid;
    if (!ownPid) throw new Error("Owned browser PID missing");
    const nativeCommand = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class OwnedWindow { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }'; $p=Get-Process -Id ${ownPid}; $p.Refresh(); $h=$p.MainWindowHandle; if($h -eq 0){throw 'Owned browser window unavailable'}; [OwnedWindow]::ShowWindow($h,9); [OwnedWindow]::SetForegroundWindow($h)`;
    observations.push({
      nativeWindowCommand: nativeCommand,
      result: execFileSync("powershell.exe", ["-NoProfile", "-Command", nativeCommand], {
        windowsHide: true,
        encoding: "utf8",
        timeout: 5000,
      }),
    });
  }
  await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("visible");
  if (hidden)
    await expect
      .poll(() =>
        page.evaluate(
          (index) =>
            window.__visibilityTrace
              .slice(index)
              .some(
                (entry) =>
                  entry.phase === "visibility" && entry.state === "visible" && entry.trusted,
              ),
          start,
        ),
      )
      .toBe(true);
}

test("actual hidden cancellation during forecast preparation discards the late snapshot and requires manual recompute", async () => {
  await page.goto(`http://127.0.0.1:${visibilityPort}/?statsEnv=staging&engine=certified`);
  await selectEnglish();
  await bringVisible();
  await setCertifiedInput("SR", 14, 2900, { blue: 19, purple: 0, yellow: 0 });
  await page.evaluate(() => {
    window.__holdCertifiedPreparation = true;
  });
  await calculateButton().click();
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__releaseCertifiedPreparation)))
    .toBe(true);
  await hide();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__visibilityTrace.some(
          (entry) => entry.phase === "visibility" && entry.state === "hidden" && entry.trusted,
        ),
      ),
    )
    .toBe(true);
  await bringVisible();
  await expect(page.getByTestId("certified-run-notice")).toHaveText(
    certifiedMessages.en.backgroundInterrupted,
  );
  await expect(page.locator(".cert-probability")).toHaveCount(0);
  const interrupted = await page.evaluate(() => window.__visibilityTrace);
  expect(interrupted).toContainEqual(
    expect.objectContaining({
      phase: "abort",
      reason: expect.objectContaining({ kind: "certified_visibility_hidden" }),
    }),
  );
  expect(interrupted).toContainEqual(
    expect.objectContaining({ phase: "client_rejection", boundCause: true }),
  );
  expect(interrupted.filter((entry) => entry.phase === "prepared_snapshot_accepted")).toHaveLength(
    0,
  );
  expect(
    interrupted.filter((entry) => entry.phase === "worker_post" && entry.message?.type === "solve"),
  ).toHaveLength(0);
  await page.evaluate(() => window.__releaseCertifiedPreparation?.());
  await page.waitForTimeout(250);
  const released = await page.evaluate(() => window.__visibilityTrace);
  expect(released).toContainEqual(
    expect.objectContaining({ phase: "forecast_preparation_released" }),
  );
  expect(released).toContainEqual(
    expect.objectContaining({ phase: "forecast_preparation_completed" }),
  );
  expect(released.filter((entry) => entry.phase === "forecast_preparation_started")).toHaveLength(
    1,
  );
  expect(released.filter((entry) => entry.phase === "prepared_snapshot_accepted")).toHaveLength(0);
  expect(
    released.filter((entry) => entry.phase === "worker_post" && entry.message?.type === "solve"),
  ).toHaveLength(0);
  await expect(page.locator(".cert-probability")).toHaveCount(0);
  await expect(page.getByTestId("certified-run-notice")).toHaveText(
    certifiedMessages.en.backgroundInterrupted,
  );
  await calculateButton().click();
  await expect(page.getByTestId("certified-current")).toContainText("100", { timeout: 15000 });
  await expect(page.getByTestId("certified-run-notice")).toHaveCount(0);
  const recomputed = await page.evaluate(() => window.__visibilityTrace);
  expect(recomputed.filter((entry) => entry.phase === "forecast_preparation_started")).toHaveLength(
    2,
  );
  expect(recomputed.filter((entry) => entry.phase === "prepared_snapshot_accepted")).toHaveLength(
    1,
  );
  const requests = recomputed.filter(
    (entry) => entry.phase === "worker_post" && entry.message?.type === "solve",
  );
  expect(requests).toHaveLength(1);
  const request = requests[0];
  if (request?.message?.deadlineAt === undefined || request.wall === undefined)
    throw new Error("Actual solve request timing is missing");
  expect(request.message.deadlineAt - request.wall).toBeLessThanOrEqual(15000);
  observations.push({ preparationGap: true, interrupted, released, recomputed });
});

test("actual hidden cancellation discards stale work and requires a new foreground request", async () => {
  await page.goto(`http://127.0.0.1:${visibilityPort}/?statsEnv=staging&engine=certified`);
  await selectEnglish();
  await bringVisible();
  await page.locator("#resetButton").click();
  await expectCertifiedInput("R", 0, "");
  await setCertifiedInput("R", 0, 0, { blue: 300, purple: 200, yellow: 100 });
  await calculateButton().click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__visibilityTrace.filter(
            (entry) => entry.phase === "worker_post" && entry.message?.type === "solve",
          ).length,
      ),
    )
    .toBe(1);
  await hide();
  await bringVisible();
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.__visibilityTrace.some(
            (entry) => entry.phase === "visibility" && entry.state === "hidden" && entry.trusted,
          ),
        ),
      { timeout: 3000 },
    )
    .toBe(true);
  await bringVisible();
  await expect(page.getByTestId("certified-run-notice")).toHaveText(
    certifiedMessages.en.backgroundInterrupted,
  );
  const trace = await page.evaluate(() => window.__visibilityTrace);
  expect(trace).toContainEqual(
    expect.objectContaining({ phase: "visibility", state: "hidden", trusted: true }),
  );
  expect(trace).toContainEqual(
    expect.objectContaining({ phase: "client_rejection", code: "aborted", boundCause: true }),
  );
  await page.waitForTimeout(250);
  await expect(page.locator(".cert-probability")).toHaveCount(0);
  const requestsBeforeRecompute = await page.evaluate(
    () =>
      window.__visibilityTrace.filter(
        (entry) => entry.phase === "worker_post" && entry.message?.type === "solve",
      ).length,
  );
  expect(requestsBeforeRecompute).toBe(1);
  await setCertifiedInput("SR", 14, 2900, { blue: 19, purple: 0, yellow: 0 });
  await calculateButton().click();
  await expect(page.locator(".cert-probability")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("certified-run-notice")).toHaveCount(0);
  await expect(page.getByTestId("certified-current")).toContainText("100");
  const requests = await page.evaluate(() =>
    window.__visibilityTrace.filter(
      (entry) => entry.phase === "worker_post" && entry.message?.type === "solve",
    ),
  );
  expect(requests).toHaveLength(2);
  expect(requests[1]?.message?.id).not.toBe(requests[0]?.message?.id);
  expect(requests[1]?.message?.generation).toBeGreaterThan(requests[0]?.message?.generation ?? 0);
  for (const request of requests) {
    if (request.message?.deadlineAt === undefined || request.wall === undefined)
      throw new Error("Actual solve request timing is missing");
    expect(request.message.deadlineAt - request.wall).toBeLessThanOrEqual(15000);
  }
});

test("actual visibility abort during waiting retains the completed current panel", async () => {
  await setCertifiedInput("R", 0, 0, { blue: 0, purple: 0, yellow: 0 });
  const acknowledge = page.getByRole("button", { name: certifiedMessages.en.already, exact: true });
  while (await acknowledge.count()) await acknowledge.first().click();
  await page.exposeBinding("__currentVisibility", async () => {
    await hide();
    await bringVisible();
  });
  await page.evaluate(() => Object.assign(globalThis, { __hideOnCurrent: true }));
  await calculateButton().click();
  await expect(page.getByTestId("certified-run-notice")).toHaveText(
    certifiedMessages.en.backgroundInterrupted,
  );
  await bringVisible();
  await expect(page.getByTestId("certified-current")).toBeVisible();
  await expect(page.locator(".cert-probability")).toContainText("0");
  const trace = await page.evaluate(() => window.__visibilityTrace);
  expect(trace).toContainEqual(
    expect.objectContaining({
      phase: "client_result",
      status: "partial",
      reason: "worker_abort",
      boundCause: true,
    }),
  );
});
