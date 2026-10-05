import type { CertifiedInput } from "../certified/types.ts";
import type { CertifiedRequest } from "./protocol.ts";
import { createCertifiedWorkerHandler } from "./workerHandler.ts";

const handler = createCertifiedWorkerHandler((message) => self.postMessage(message));
self.addEventListener("message", (event: MessageEvent<CertifiedRequest<CertifiedInput>>) => {
  void handler.handle(event.data);
});
