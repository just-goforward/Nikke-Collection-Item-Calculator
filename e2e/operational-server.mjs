import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { localWorkerOptions } from "./operational-worker-config.mjs";
import { privateDirectory, recordOutboundViolation } from "./operational-report.mjs";

export async function startOperationalServer() {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const receipt = JSON.parse(readFileSync(resolve(root, "dist/.vite/local-operational-profile.json"), "utf8"));
  if (receipt.profile !== "local-shared-service-bundled" ||
      receipt.flags.serviceCertifiedSolver !== true ||
      receipt.flags.forecastRuntime !== "bundled" || receipt.flags.onlineTrust !== false)
    throw new Error("OPERATIONAL_PRODUCTION_RECEIPT_INVALID");
  const bundle = await build({
    absWorkingDir: root, entryPoints: ["site-worker/src/worker.ts"], bundle: true,
    format: "esm", platform: "browser", target: "es2022", write: false, logLevel: "silent",
  });
  const worker = new Miniflare(localWorkerOptions(root, bundle.outputFiles[0].text,
    privateDirectory("production-policy-worker"), recordOutboundViolation));
  try {
    const url = await worker.ready;
    if (url.origin !== "http://127.0.0.1:4290") throw new Error("OPERATIONAL_ORIGIN_INVALID");
    return worker;
  } catch (error) {
    await worker.dispose();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const worker = await startOperationalServer();
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    await worker.dispose();
  }
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
}
