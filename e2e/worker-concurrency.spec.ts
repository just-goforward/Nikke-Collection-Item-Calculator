import { expect, type Page } from "@playwright/test";
import { type PreviewServer, preview } from "vite";
import { mockStagingStatsEndpoints, serveStagingDocument } from "./smoke.helpers";
import { test } from "./test";

const PORT = 4175;
const ORIGIN = `http://127.0.0.1:${PORT}`;
let previewServer: PreviewServer | null = null;

type WorkerProbe = {
  created: number;
  solveResults: Array<{
    fallbackFrom: string | null;
    fallbackReason: string | null;
    solverBackend: string | null;
  }>;
  terminated: number;
  validationPosted: number;
};

test.beforeAll(async () => {
  previewServer = await preview({
    base: "./",
    configFile: false,
    preview: { host: "127.0.0.1", port: PORT, strictPort: true },
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

async function installWorkerProbe(page: Page, delayValidationMs = 0) {
  await page.addInitScript(
    ({ validationDelay }) => {
      const OriginalWorker = window.Worker;
      Reflect.set(window, "__workerProbe", {
        created: 0,
        solveResults: [],
        terminated: 0,
        validationPosted: 0,
      });

      class InstrumentedWorker extends OriginalWorker {
        constructor(scriptURL: string | URL, options?: WorkerOptions) {
          super(scriptURL, options);
          const probe = Reflect.get(window, "__workerProbe") as WorkerProbe;
          probe.created += 1;
          const originalTerminate = this.terminate.bind(this);
          const originalPostMessage = this.postMessage.bind(this);
          const taskTypes = new Map<number, string>();
          let terminated = false;

          Object.defineProperty(this, "terminate", {
            value: () => {
              if (!terminated) {
                terminated = true;
                probe.terminated += 1;
              }
              originalTerminate();
            },
          });
          Object.defineProperty(this, "postMessage", {
            value: (message: unknown) => {
              if (message !== null && typeof message === "object") {
                const id = Number(Reflect.get(message, "id"));
                const type = String(Reflect.get(message, "type") || "unknown");
                if (Number.isFinite(id)) taskTypes.set(id, type);
              }
              const isValidation =
                message !== null &&
                typeof message === "object" &&
                Reflect.get(message, "type") === "validate";
              if (isValidation) probe.validationPosted += 1;
              if (!isValidation || validationDelay <= 0) {
                originalPostMessage(message);
                return;
              }
              window.setTimeout(() => {
                if (!terminated) originalPostMessage(message);
              }, validationDelay);
            },
          });
          this.addEventListener("message", (event) => {
            const message = event.data;
            if (!message || typeof message !== "object") return;
            const id = Number(Reflect.get(message, "id"));
            if (taskTypes.get(id) !== "solve" || Reflect.get(message, "type") !== "result") return;
            const result = Reflect.get(message, "result");
            const stats =
              result && typeof result === "object" ? Reflect.get(result, "stats") : null;
            probe.solveResults.push({
              fallbackFrom:
                stats && typeof stats === "object"
                  ? String(Reflect.get(stats, "fallbackFrom") || "") || null
                  : null,
              fallbackReason:
                stats && typeof stats === "object"
                  ? String(Reflect.get(stats, "fallbackReason") || "") || null
                  : null,
              solverBackend:
                stats && typeof stats === "object"
                  ? String(Reflect.get(stats, "solverBackend") || "") || null
                  : null,
            });
          });
        }
      }

      Object.defineProperty(window, "Worker", {
        configurable: true,
        value: InstrumentedWorker,
      });
    },
    { validationDelay: delayValidationMs },
  );
}

async function installTurnstileStub(page: Page) {
  await page.addInitScript(() => {
    const widgets = new Map<string, Record<string, unknown>>();
    let nextId = 0;
    Reflect.set(window, "turnstile", {
      execute(widgetId: string) {
        const callback = widgets.get(widgetId)?.["callback"];
        if (typeof callback === "function") {
          window.setTimeout(() => callback("valid-turnstile-token-for-e2e"), 0);
        }
      },
      remove(widgetId: string) {
        widgets.delete(widgetId);
      },
      render(_container: HTMLElement, options: Record<string, unknown>) {
        nextId += 1;
        const widgetId = `widget-${nextId}`;
        widgets.set(widgetId, options);
        return widgetId;
      },
      reset() {},
    });
  });
}

async function workerProbe(page: Page): Promise<WorkerProbe> {
  return page.evaluate(() => {
    const probe = Reflect.get(window, "__workerProbe");
    if (!probe || typeof probe !== "object") throw new Error("Worker probe is unavailable.");
    return {
      created: Number(Reflect.get(probe, "created")),
      solveResults: Array.from(Reflect.get(probe, "solveResults") || []),
      terminated: Number(Reflect.get(probe, "terminated")),
      validationPosted: Number(Reflect.get(probe, "validationPosted")),
    };
  });
}

async function solveSr10(page: Page, yellow: string) {
  await page
    .getByRole("group", { name: "소장품 등급" })
    .getByRole("button", { name: "SR" })
    .click();
  await page.getByRole("button", { name: "10단계", exact: true }).click();
  await page.getByLabel("상급자용 키트").fill(yellow);
  await page.getByRole("button", { name: "계산", exact: true }).click();
  await expect(page.getByText("SR 15 도달 확률").first()).toBeVisible({ timeout: 20_000 });
}

async function openValidation(page: Page) {
  const details = page.locator(".validation-details");
  await details.locator("summary").click();
  await expect(details).toHaveAttribute("open", "");
}

test("staging parallel validation uses a dedicated Worker", async ({ page }) => {
  await installWorkerProbe(page);
  await serveStagingDocument(page, {
    endpoint: "https://staging.example.test",
    turnstileSiteKey: "staging-site-key",
  });
  await mockStagingStatsEndpoints(page, ORIGIN);
  await page.goto(`${ORIGIN}/?statsEnv=staging&parallelValidation=1`);

  await solveSr10(page, "100");
  await expect.poll(async () => (await workerProbe(page)).created).toBe(1);

  await openValidation(page);
  await expect(page.getByText(/가상의 니붕이 .*SR 15/)).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => (await workerProbe(page)).created).toBe(2);
  expect((await workerProbe(page)).terminated).toBe(0);
});

test("input edits let shared validation finish without terminating its Worker", async ({
  page,
}) => {
  await installWorkerProbe(page, 400);
  await page.goto(`${ORIGIN}/?statsEnv=disabled`);
  await solveSr10(page, "100");

  await openValidation(page);
  await expect(page.locator(".validation-chart-loading")).toBeVisible();
  await expect(page.locator(".validation-chart-spinner")).toBeVisible();
  await expect(page.locator(".validation-result")).not.toContainText("0명이 시도를 완료");
  const loadingCard = await page.locator(".validation-chart-card").boundingBox();
  expect(loadingCard?.height || 0).toBeGreaterThanOrEqual(112);

  await page.getByLabel("상급자용 키트").fill("90");
  await page.getByRole("button", { name: "9단계", exact: true }).click();
  await expect(
    page
      .locator(".result-panel")
      .getByText("소장품 상태가 변경되었습니다. 계산 버튼을 눌러 결과를 갱신해주세요."),
  ).toBeVisible();
  expect((await workerProbe(page)).terminated).toBe(0);

  await expect(page.getByText(/가상의 니붕이 .*SR 15/)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".validation-chart-loading")).toHaveCount(0);
  await expect(page.locator(".validation-chart-card")).toBeVisible();
  expect((await workerProbe(page)).terminated).toBe(0);
});

test("a new solve preempts edited-input validation before starting replacement work", async ({
  page,
}) => {
  await installWorkerProbe(page, 2_000);
  await page.goto(`${ORIGIN}/?statsEnv=disabled`);
  await solveSr10(page, "100");

  await openValidation(page);
  await expect(page.locator(".validation-chart-loading")).toBeVisible();
  await expect.poll(async () => (await workerProbe(page)).validationPosted).toBe(1);
  await page.getByLabel("상급자용 키트").fill("90");
  await page.getByRole("button", { name: "9단계", exact: true }).click();
  await expect(
    page
      .locator(".result-panel")
      .getByText("소장품 상태가 변경되었습니다. 계산 버튼을 눌러 결과를 갱신해주세요."),
  ).toBeVisible();
  expect((await workerProbe(page)).terminated).toBe(0);
  await expect(page.locator(".validation-chart-loading")).toBeVisible();

  await page.locator("#calculateButton").click();
  await expect(page.getByText("SR 15 도달 확률").first()).toBeVisible({ timeout: 20_000 });

  await expect.poll(async () => (await workerProbe(page)).created).toBe(2);
  await expect.poll(async () => (await workerProbe(page)).terminated).toBe(1);
  await expect(page.getByText("검증 중 오류가 발생했습니다.")).toHaveCount(0);
});

test("min-E[f] capacity fallback restarts in a fresh phase2 Worker", async ({ page }) => {
  test.setTimeout(60_000);
  const submittedEvents: Array<Record<string, unknown>> = [];
  await installWorkerProbe(page);
  await installTurnstileStub(page);
  await serveStagingDocument(page, {
    endpoint: "https://staging.example.test",
    turnstileSiteKey: "staging-site-key",
  });
  await page.route("https://staging.example.test/api/events", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Origin": ORIGIN,
        },
      });
      return;
    }
    const payload = route.request().postDataJSON();
    if (payload && typeof payload === "object") submittedEvents.push(payload);
    await route.fulfill({
      status: 200,
      headers: { "Access-Control-Allow-Origin": ORIGIN },
      body: '{"ok":true}',
    });
  });
  await page.goto(`${ORIGIN}/?statsEnv=staging`);
  await page.getByLabel("초심자용 키트").fill("400");
  await page.getByLabel("중급자용 키트").fill("200");
  await page.getByLabel("상급자용 키트").fill("100");
  await page.locator("#calculateButton").click();

  await expect(page.getByText("SR 15 도달 확률").first()).toBeVisible({ timeout: 35_000 });
  await expect
    .poll(async () => (await workerProbe(page)).solveResults.at(-1))
    .toMatchObject({
      solverBackend: "rust-phase2",
    });
  await expect
    .poll(
      () =>
        submittedEvents
          .map((payload) => Reflect.get(payload, "event"))
          .find((event) => event && Reflect.get(event, "kind") === "solver_diagnostic"),
      { timeout: 20_000 },
    )
    .toMatchObject({
      fallbackFrom: "rust-min-ef",
      fallbackReason: "memo_full",
      locale: "ko",
      solverBackend: "rust-phase2",
    });
  expect((await workerProbe(page)).created).toBeGreaterThanOrEqual(2);
  expect((await workerProbe(page)).terminated).toBeGreaterThanOrEqual(1);
});
