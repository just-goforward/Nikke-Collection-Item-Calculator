import { mkdtemp } from "node:fs/promises";
import { cpus, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import { createServer } from "vite";

export async function measureNodeMinimumWait() {
  const directory = await mkdtemp(join(tmpdir(), "nikke-minimum-wait-"));
  const entries = [
    "src/certifiedRuntime/minimumWaitTiming.ts",
    "src/certifiedRuntime/nodeClient.ts",
    "src/certifiedRuntime/nodeWorker.ts",
  ];
  await build({
    entryPoints: entries,
    outdir: directory,
    outbase: ".",
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const timing: typeof import("../src/certifiedRuntime/minimumWaitTiming.ts") = await import(
    pathToFileURL(join(directory, "src/certifiedRuntime/minimumWaitTiming.js")).href
  );
  const { createNodeCertifiedClient }: typeof import("../src/certifiedRuntime/nodeClient.ts") =
    await import(pathToFileURL(join(directory, "src/certifiedRuntime/nodeClient.js")).href);
  const worker = pathToFileURL(join(directory, "src/certifiedRuntime/nodeWorker.js"));
  const results = [];
  for (const fixture of timing.MINIMUM_WAIT_TIMING_CASES)
    results.push(
      await timing.measureMinimumWaitRequest(fixture.id, () => createNodeCertifiedClient(worker)),
    );
  return {
    environment: {
      runtime: process.version,
      platform: process.platform,
      arch: process.arch,
      os: release(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
    },
    bundleDirectory: directory,
    results,
  };
}

export async function measureChromiumMinimumWait() {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: "127.0.0.1", port: 0, watch: null },
  });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("missing_timing_server_address");
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/benchmarks/certified-minimum-wait.html`);
    const result = await page.evaluate(async () => {
      const { runMinimumWaitBrowserTiming } = await import(
        "../src/certifiedRuntime/minimumWaitTimingPage.ts"
      );
      return runMinimumWaitBrowserTiming();
    });
    return { browserVersion: browser.version(), ...result };
  } finally {
    await browser.close();
    await server.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode !== "node" && mode !== "chromium")
    throw new Error("Use: node scripts/measure-certified-minimum-wait.ts node|chromium");
  const result =
    mode === "node" ? await measureNodeMinimumWait() : await measureChromiumMinimumWait();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
