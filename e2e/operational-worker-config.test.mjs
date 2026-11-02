import { deepStrictEqual } from "node:assert";
import { test } from "node:test";
import { localWorkerOptions } from "./operational-worker-config.mjs";
import { Miniflare, MiniflareOptionsSchema } from "miniflare";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("local worker receives no remote authority and rejects global outbound fetch", () => {
  const options = localWorkerOptions(process.cwd(), "export default {}", process.cwd());
  MiniflareOptionsSchema.parse(options);
  deepStrictEqual(options.cf, false);
  deepStrictEqual(options.telemetry, { enabled: false });
  const worker = options.workers[0];
  deepStrictEqual(Object.keys(worker.config.env).sort(), ["ASSETS", "SITE_ENV"]);
  deepStrictEqual(worker.config.env.ASSETS, { type: "assets" });
  deepStrictEqual(worker.config.assets.runWorkerFirst, true);
  let message;
  try { worker.dev.outboundService.handler(); } catch (error) { message = error.message; }
  deepStrictEqual(message, "OPERATIONAL_OUTBOUND_PROHIBITED");
});

test("worker-first assets actually dispatch to the local user Worker", async () => {
  const root = mkdtempSync(join(tmpdir(), "operational-worker-route-"));
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist/index.html"), "asset-selected");
  const options = localWorkerOptions(root,
    'export default { fetch() { return new Response("worker-selected"); } };', root);
  options.port = 0;
  const worker = new Miniflare(options);
  try {
    const response = await worker.dispatchFetch("http://127.0.0.1/");
    deepStrictEqual(response.status, 200);
    deepStrictEqual(await response.text(), "worker-selected");
  } finally { await worker.dispose(); }
});
