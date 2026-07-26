import { chromium, type Page } from "@playwright/test";
import { type PreviewServer, preview } from "vite";

type Mode = "dedicated" | "shared";
type ProbeSnapshot = {
  results: Array<{ at: number; type: string }>;
  started: Array<{ at: number; type: string }>;
};

const PORT = 4176;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const REPEATS = Math.max(1, Math.trunc(Number(process.env["WORKER_BENCH_REPEATS"]) || 10));

async function installProbe(page: Page) {
  await page.addInitScript(() => {
    const OriginalWorker = window.Worker;
    const probe: ProbeSnapshot = { results: [], started: [] };
    Reflect.set(window, "__workerConcurrencyProbe", probe);

    class InstrumentedWorker extends OriginalWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        const taskTypes = new Map<number, string>();
        const originalPostMessage = this.postMessage.bind(this);
        Object.defineProperty(this, "postMessage", {
          value: (message: unknown) => {
            if (message && typeof message === "object") {
              const id = Number(Reflect.get(message, "id"));
              const type = String(Reflect.get(message, "type") || "unknown");
              if (Number.isFinite(id)) taskTypes.set(id, type);
            }
            originalPostMessage(message);
          },
        });
        this.addEventListener("message", (event) => {
          const message = event.data;
          if (!message || typeof message !== "object") return;
          const id = Number(Reflect.get(message, "id"));
          const type = taskTypes.get(id) || "unknown";
          const responseType = Reflect.get(message, "type");
          const progress = Reflect.get(message, "progress");
          if (
            responseType === "progress" &&
            progress &&
            typeof progress === "object" &&
            Reflect.get(progress, "phase") === "worker-started"
          ) {
            probe.started.push({ at: performance.now(), type });
          }
          if (responseType === "result") probe.results.push({ at: performance.now(), type });
        });
      }
    }
    Object.defineProperty(window, "Worker", { configurable: true, value: InstrumentedWorker });
  });
}

async function probe(page: Page): Promise<ProbeSnapshot> {
  return page.evaluate(() => {
    const value = Reflect.get(window, "__workerConcurrencyProbe");
    if (!value || typeof value !== "object") throw new Error("Worker probe unavailable.");
    return {
      results: Array.from(Reflect.get(value, "results") || []),
      started: Array.from(Reflect.get(value, "started") || []),
    };
  });
}

async function waitForTaskCount(
  page: Page,
  field: keyof ProbeSnapshot,
  type: string,
  count: number,
) {
  await page.waitForFunction(
    ({ expectedCount, expectedType, probeField }) => {
      const value = Reflect.get(window, "__workerConcurrencyProbe");
      if (!value || typeof value !== "object") return false;
      const records = Reflect.get(value, probeField);
      return (
        Array.isArray(records) &&
        records.filter((record) => Reflect.get(record, "type") === expectedType).length >=
          expectedCount
      );
    },
    { expectedCount: count, expectedType: type, probeField: field },
    { timeout: 30_000 },
  );
}

async function runOnce(mode: Mode, repeat: number) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  try {
    await installProbe(page);
    const parallel = mode === "dedicated" ? "1" : "0";
    await page.goto(`${ORIGIN}/?statsEnv=staging&demoStats=1&parallelValidation=${parallel}`);
    await page.locator("#blueStock").fill("300");
    await page.locator("#purpleStock").fill("150");
    await page.locator("#yellowStock").fill("150");
    await page.locator("#calculateButton").click();
    await waitForTaskCount(page, "results", "solve", 1);

    await page.locator(".validation-details summary").click();
    await waitForTaskCount(page, "started", "validate", 1);
    const solveResultsBefore = (await probe(page)).results.filter(
      (record) => record.type === "solve",
    ).length;
    await page.locator("#blueStock").fill("290");
    const requestedAt = await page.evaluate(() => performance.now());
    await page.locator("#calculateButton").click();
    await waitForTaskCount(page, "results", "solve", solveResultsBefore + 1);
    const latest = (await probe(page)).results.filter((record) => record.type === "solve").at(-1);
    if (!latest) throw new Error("Solve result timing was not captured.");
    return { elapsedMs: latest.at - requestedAt, mode, repeat, status: "completed" as const };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      mode,
      repeat,
      status: "error" as const,
    };
  } finally {
    await browser.close();
  }
}

function quantile(values: number[], q: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] ?? null;
}

let server: PreviewServer | null = null;
try {
  server = await preview({
    base: "./",
    configFile: false,
    preview: { host: "127.0.0.1", port: PORT, strictPort: true },
    root: process.cwd(),
  });
  const records: Array<Awaited<ReturnType<typeof runOnce>>> = [];
  for (const mode of ["shared", "dedicated"] as const) {
    for (let repeat = 0; repeat < REPEATS; repeat += 1) records.push(await runOnce(mode, repeat));
  }
  const summary = Object.fromEntries(
    (["shared", "dedicated"] as const).map((mode) => {
      const elapsed = records.flatMap((record) =>
        record.mode === mode && record.status === "completed" ? [record.elapsedMs] : [],
      );
      return [
        mode,
        {
          completed: elapsed.length,
          p50Ms: quantile(elapsed, 0.5),
          p95Ms: quantile(elapsed, 0.95),
        },
      ];
    }),
  );
  console.log(
    JSON.stringify(
      { generatedAt: new Date().toISOString(), records, repeats: REPEATS, summary },
      null,
      2,
    ),
  );
} finally {
  if (server) await new Promise<void>((resolve) => server?.httpServer.close(() => resolve()));
}
