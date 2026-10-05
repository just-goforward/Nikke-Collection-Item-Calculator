import { parentPort } from "node:worker_threads";
import { createCertifiedWorkerHandler } from "./workerHandler.ts";

const port = parentPort;
if (!port) throw new Error("Certified Node Worker requires parentPort.");
const handler = createCertifiedWorkerHandler((message) => port.postMessage(message));
port.on("message", (message) => {
  void handler.handle(message);
});
port.on("close", () => handler.close());
