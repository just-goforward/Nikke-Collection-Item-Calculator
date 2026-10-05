import { installLifecycleFixture } from "./lifecycleFixtureWorker.ts";

installLifecycleFixture(
  (listener) => self.addEventListener("message", (event: MessageEvent) => listener(event.data)),
  (message) => self.postMessage(message),
);
