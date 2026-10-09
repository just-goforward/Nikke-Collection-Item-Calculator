import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parentPort } from "node:worker_threads";
import { createCertifiedWorkerHandler } from "./workerHandler.ts";

const port = parentPort;
if (!port) throw new Error("Certified Node Worker requires parentPort.");
const handler = createCertifiedWorkerHandler(
  (message) => port.postMessage(message),
  () => readFile(resolve("public/certified_solver.wasm")),
);
port.on("message", (message) => {
  void handler.handle(message);
});
port.on("close", () => handler.close());
