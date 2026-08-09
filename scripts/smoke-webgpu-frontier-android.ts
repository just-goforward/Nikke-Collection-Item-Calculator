import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";
import {
  assertResearchReportCanBeWritten,
  collectResearchProvenance,
  readOptionalResearchReport,
} from "../benchmarks/research-provenance.ts";
// The module is a browser entry loaded by HTML on the device; this type-only edge keeps it in the source graph.
import type {} from "../benchmarks/webgpu/android-frontier-page.ts";

const DEFAULT_ADB = String.raw`C:\Users\PC\AppData\Local\Android\Sdk\platform-tools\adb.exe`;
const DEFAULT_SERIAL = "R3CN90M590A";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = resolve(REPO_ROOT, "benchmarks/results/webgpu-frontier-android-v2.json");
const CONTRACT = {
  kind: "webgpu-frontier-android",
  version: 2,
  parityScenario: "SR10e2900-balanced30",
  capacityScenario: "R10-balanced300",
  repeats: 3,
  maximumStates: 1_200_000,
  expectedCapacityStop: { outcome: "budget_exceeded", states: 1_162_033, layers: 37 },
} as const;

function adb(adbPath: string, serial: string, ...args: string[]): string {
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
  const chromeActivity = adb(
    adbPath,
    serial,
    "shell",
    "cmd",
    "package",
    "resolve-activity",
    "--brief",
    "--user",
    "0",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    "https://example.com",
    "-p",
    "com.android.chrome",
  );
  const temperature = battery.match(/temperature:\s*(\d+)/u)?.[1];
  return {
    serial,
    model: property("ro.product.model"),
    android: property("ro.build.version.release"),
    api: property("ro.build.version.sdk"),
    abi: property("ro.product.cpu.abilist"),
    memTotal: meminfo.match(/^MemTotal:\s*(.+)$/mu)?.[1] ?? "unknown",
    chromeVersion: chrome.match(/versionName=([^\s]+)/u)?.[1] ?? "unknown",
    chromeActivity: chromeActivity || "unavailable",
    batteryTemperatureC: temperature ? Number(temperature) / 10 : null,
  };
}

const adbPath = process.env["ADB_PATH"] ?? DEFAULT_ADB;
const serial = process.env["ADB_SERIAL"] ?? DEFAULT_SERIAL;
adb(adbPath, serial, "shell", "input", "keyevent", "KEYCODE_WAKEUP");
adb(adbPath, serial, "shell", "wm", "dismiss-keyguard");
const device = deviceMetadata(adbPath, serial);
let resolveResult: (value: unknown) => void = () => {};
let rejectResult: (reason: unknown) => void = () => {};
const resultPromise = new Promise<unknown>((resolvePromise, rejectPromise) => {
  resolveResult = resolvePromise;
  rejectResult = rejectPromise;
});
const vite = await createServer({
  root: REPO_ROOT,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [
    {
      name: "android-webgpu-result",
      configureServer(server) {
        server.middlewares.use("/__webgpu_result", (request, response) => {
          const chunks: Buffer[] = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            try {
              resolveResult(JSON.parse(Buffer.concat(chunks).toString("utf8")));
              response.statusCode = 204;
              response.end();
            } catch (error) {
              rejectResult(error);
              response.statusCode = 400;
              response.end();
            }
          });
        });
      },
    },
  ],
});

let launchResult = "not launched";
let result: unknown;
let reversePort: number | null = null;
try {
  await vite.listen();
  const localUrl = vite.resolvedUrls?.local[0];
  if (!localUrl) throw new Error("Vite did not expose an Android smoke URL.");
  if (
    device.chromeActivity === "unavailable" ||
    /No activity found/iu.test(device.chromeActivity)
  ) {
    throw new Error(`Android Chrome launch failed: ${device.chromeActivity}`);
  }
  const port = Number(new URL(localUrl).port);
  adb(adbPath, serial, "reverse", `tcp:${port}`, `tcp:${port}`);
  reversePort = port;
  launchResult = adb(
    adbPath,
    serial,
    "shell",
    "am",
    "start",
    "--user",
    "0",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    `http://127.0.0.1:${port}/benchmarks/webgpu/android-frontier.html?run=${Date.now()}`,
    "-p",
    "com.android.chrome",
  );
  if (/Activity not started|Error type|does not exist|unable to resolve/iu.test(launchResult)) {
    throw new Error(`Android Chrome launch failed: ${launchResult}`);
  }
  const timeoutMs = Number(process.env["ANDROID_WEBGPU_TIMEOUT_MS"] ?? 360_000);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  result = await Promise.race([
    resultPromise,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Android WebGPU smoke timed out.")), timeoutMs);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
} catch (error) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  result = {
    outcome: /Android Chrome launch failed|unable to resolve|does not exist/iu.test(message)
      ? "device_unavailable"
      : "failure",
    error: message,
  };
} finally {
  if (reversePort !== null) {
    adb(adbPath, serial, "reverse", "--remove", `tcp:${reversePort}`);
  }
  await vite.close();
}

const typedResult = result as {
  outcome?: string;
  exactSetMatch?: boolean;
  census?: { outcome?: string; states?: number; layers?: number };
};
const capacityReproduced =
  typedResult.census?.outcome === CONTRACT.expectedCapacityStop.outcome &&
  typedResult.census.states === CONTRACT.expectedCapacityStop.states &&
  typedResult.census.layers === CONTRACT.expectedCapacityStop.layers;
const provenance = collectResearchProvenance({
  repoRoot: REPO_ROOT,
  studyId: CONTRACT.kind,
  protocolVersion: CONTRACT.version,
  contract: CONTRACT,
  sourceFiles: [
    "benchmarks/compact-exact-graph.ts",
    "benchmarks/webgpu/compact-frontier-kernel.ts",
    "benchmarks/webgpu/android-frontier-page.ts",
    "scripts/smoke-webgpu-frontier-android.ts",
  ],
});
const existing = readOptionalResearchReport(OUTPUT);
assertResearchReportCanBeWritten(existing, provenance);
const report = {
  kind: CONTRACT.kind,
  version: CONTRACT.version,
  provenance,
  contract: CONTRACT,
  device,
  launchResult,
  result,
  checks: { capacityReproduced },
  adoption: {
    grade:
      typedResult.outcome === "completed" && typedResult.exactSetMatch && capacityReproduced
        ? "verification_incomplete"
        : typedResult.outcome === "device_unavailable"
          ? "verification_incomplete"
          : "rejected",
    reason:
      typedResult.outcome === "completed" && typedResult.exactSetMatch && capacityReproduced
        ? "Android integer-frontier parity and capacity stop passed; the full exact candidate remains blocked by the registered state budget."
        : typedResult.outcome === "device_unavailable"
          ? "Chrome is installed as a package but has no resolvable VIEW activity for Android user 0; Android Chrome WebGPU remains unverified."
          : "Android WebGPU availability, parity, or deterministic capacity-stop verification failed.",
  },
};
writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output: OUTPUT, device, result, adoption: report.adoption }, null, 2));
