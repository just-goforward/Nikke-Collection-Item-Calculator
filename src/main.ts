import { createApp } from "vue";

import App from "./App.vue";
import { bootCalculator } from "./legacy-controller";
import "./styles.css";

function boot() {
  createApp(App).mount("#app");
  bootCalculator();
}

try {
  boot();
} catch (error) {
  console.error("Calculator boot failed.", error);
}
