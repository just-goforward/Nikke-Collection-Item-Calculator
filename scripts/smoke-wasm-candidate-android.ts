import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const DEFAULT_ADB = String.raw`C:\Users\PC\AppData\Local\Android\Sdk\platform-tools\adb.exe`;
const DEFAULT_SERIAL = "R3CN90M590A";
const EXPECTED_SEMANTIC_BITS = "3fbf64e435ab1f1e";

function requiredPath(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function adb(adbPath: string, serial: string, ...args: string[]) {
  return execFileSync(adbPath, ["-s", serial, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
}

function deviceMetadata(adbPath: string, serial: string) {
  const property = (name: string) => adb(adbPath, serial, "shell", "getprop", name);
  const meminfo = adb(adbPath, serial, "shell", "cat", "/proc/meminfo");
  const battery = adb(adbPath, serial, "shell", "dumpsys", "battery");
  const chrome = adb(adbPath, serial, "shell", "dumpsys", "package", "com.android.chrome");
  const temperature = battery.match(/temperature:\s*(\d+)/)?.[1];
  return {
    abi: property("ro.product.cpu.abilist"),
    android: property("ro.build.version.release"),
    api: property("ro.build.version.sdk"),
    batteryTemperatureC: temperature ? Number(temperature) / 10 : null,
    chromeVersion: chrome.match(/versionName=([^\s]+)/)?.[1] ?? "unknown",
    memTotal: meminfo.match(/^MemTotal:\s*(.+)$/m)?.[1] ?? "unknown",
    model: property("ro.product.model"),
    serial,
  };
}

const workerSource = `
function f64Bits(value) {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value, false);
  return new DataView(buffer).getBigUint64(0, false).toString(16).padStart(16, "0");
}

function requireExport(exports, name) {
  const value = exports[name];
  if (typeof value !== "function") throw new Error("Missing WASM export " + name);
  return value;
}

self.onmessage = async () => {
  try {
    const response = await fetch("/candidate.wasm", { cache: "no-store" });
    if (!response.ok) throw new Error("WASM fetch failed with " + response.status);
    const { instance } = await WebAssembly.instantiateStreaming(response);
    const exports = instance.exports;
    requireExport(exports, "configureMinEfMemo")(21);
    requireExport(exports, "configureNodeBudget")(2_000_000);

    const solve = requireExport(exports, "solveMinEf");
    const status = requireExport(exports, "getSolveStatus");
    const action = requireExport(exports, "minEfAction");
    const expectedCost = requireExport(exports, "minEfExpectedCost");
    const nodeCount = requireExport(exports, "minEfNodeCount");
    const release = requireExport(exports, "releaseMinEfMemo");

    solve(780, 100_000, 100_000, 100_000, 0.75, 3, 0);
    const maximum = {
      action: action(),
      expectedCostBits: f64Bits(expectedCost()),
      memoryBytes: exports.memory.buffer.byteLength,
      nodeCount: nodeCount(),
      status: status(),
    };
    release();

    solve(0, 60, 120, 900, 0.75, 3, 0);
    const semantic = {
      action: action(),
      expectedCostBits: f64Bits(expectedCost()),
      memoryBytes: exports.memory.buffer.byteLength,
      nodeCount: nodeCount(),
      status: status(),
    };
    release();
    self.postMessage({ maximum, semantic });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }
};
`;

const pageSource = `
<!doctype html>
<meta charset="utf-8">
<title>P4 Android smoke</title>
<script>
window.__p4Result = null;
function runWorker(iteration) {
  return new Promise((resolve, reject) => {
    const worker = new Worker("/worker.js");
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error("Worker " + iteration + " timed out"));
    }, 120000);
    worker.onmessage = ({ data }) => {
      clearTimeout(timeout);
      worker.terminate();
      if (data.error) reject(new Error(data.error));
      else resolve({ iteration, ...data });
    };
    worker.onerror = (event) => {
      clearTimeout(timeout);
      worker.terminate();
      reject(new Error(event.message || "Worker failed"));
    };
    worker.postMessage({ run: true });
  });
}
(async () => {
  try {
    const runs = [];
    for (let iteration = 1; iteration <= 3; iteration += 1) {
      runs.push(await runWorker(iteration));
    }
    window.__p4Result = { ok: true, runs };
  } catch (error) {
    window.__p4Result = {
      ok: false,
      error: error instanceof Error ? error.stack || error.message : String(error),
    };
  }
  await fetch("/result", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(window.__p4Result),
  });
})();
</script>
`;

async function startServer(wasm: Uint8Array) {
  const requests: string[] = [];
  let resolveResult: (value: unknown) => void;
  let rejectResult: (reason: unknown) => void;
  const result = new Promise<unknown>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const server = createServer((request, response) => {
    requests.push(`${request.method ?? "UNKNOWN"} ${request.url ?? ""}`);
    if (request.url === "/result" && request.method === "POST") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        try {
          resolveResult(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          response.writeHead(204);
          response.end();
        } catch (error) {
          rejectResult(error);
          response.writeHead(400);
          response.end();
        }
      });
      return;
    }
    if (request.url === "/candidate.wasm") {
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "application/wasm",
      });
      response.end(wasm);
      return;
    }
    if (request.url === "/worker.js") {
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "text/javascript; charset=utf-8",
      });
      response.end(workerSource);
      return;
    }
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
    });
    response.end(pageSource);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Benchmark server has no TCP port.");
  return { port: address.port, requests, result, server };
}

async function main() {
  const adbPath = process.env["ADB_PATH"] ?? DEFAULT_ADB;
  const serial = process.env["ADB_SERIAL"] ?? DEFAULT_SERIAL;
  const wasm = await readFile(requiredPath("WASM_CANDIDATE_PATH"));
  const metadata = deviceMetadata(adbPath, serial);
  const { port, requests, result, server } = await startServer(wasm);
  try {
    adb(adbPath, serial, "reverse", `tcp:${port}`, `tcp:${port}`);
    const launchResult = adb(
      adbPath,
      serial,
      "shell",
      "am",
      "start",
      "--user",
      "0",
      "-n",
      "com.android.chrome/com.google.android.apps.chrome.IntentDispatcher",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      `http://127.0.0.1:${port}/`,
    );
    const timeoutMs = Number(process.env["ANDROID_SMOKE_TIMEOUT_MS"] ?? 360_000);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () =>
          reject(
            new Error(
              `Android Chrome smoke timed out (launch=${launchResult}, requests=${requests.join(",") || "none"}).`,
            ),
          ),
        timeoutMs,
      );
    });
    const smokeResult = (await Promise.race([result, timeout]).finally(() => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    })) as Window["__p4Result"];
    if (!smokeResult?.ok || !smokeResult.runs) {
      throw new Error(smokeResult?.error ?? "Android smoke returned no result.");
    }
    for (const run of smokeResult.runs) {
      if (run.maximum.status !== 0 || run.semantic.status !== 0) {
        throw new Error(`Android run ${run.iteration} returned a non-completed status.`);
      }
      if (run.semantic.action !== 0 || run.semantic.expectedCostBits !== EXPECTED_SEMANTIC_BITS) {
        throw new Error(`Android run ${run.iteration} failed the semantic snapshot.`);
      }
    }
    console.log(
      JSON.stringify(
        {
          artifactBytes: wasm.byteLength,
          device: metadata,
          launchResult,
          result: smokeResult,
          limitations: [
            "This ARM64 device is not a low-memory or 32-bit Android representative.",
            "Worker termination permits memory reclamation; it does not prove immediate RSS shrink.",
            "This device did not expose a Chrome DevTools socket; results returned over the benchmark origin.",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    adb(adbPath, serial, "reverse", "--remove", `tcp:${port}`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

declare global {
  interface Window {
    __p4Result: null | {
      error?: string;
      ok: boolean;
      runs?: Array<{
        iteration: number;
        maximum: { status: number };
        semantic: { action: number; expectedCostBits: string; status: number };
      }>;
    };
  }
}

await main();
