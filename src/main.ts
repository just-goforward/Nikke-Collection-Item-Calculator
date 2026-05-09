import { createApp, nextTick } from "vue";

import App from "./App.vue";
import "./styles.css";

async function boot() {
  createApp(App).mount("#app");
  await nextTick();
  const { bootCalculator } = await import("./legacy-controller");
  bootCalculator();
}

boot().catch((error) => {
  console.error("Calculator boot failed.", error);
});
