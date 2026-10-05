import { parentPort, workerData } from "node:worker_threads";
import { installLifecycleFixture } from "./lifecycleFixtureWorker.ts";

if (!parentPort) throw new Error("Fixture requires Worker thread.");
const port = parentPort;
installLifecycleFixture(
  (listener) => port.on("message", listener),
  (message) => port.postMessage(message),
  Number(workerData?.initializationDelayMs ?? 0),
);
