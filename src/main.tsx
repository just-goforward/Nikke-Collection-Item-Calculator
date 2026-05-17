import { createRoot } from "react-dom/client";

import App from "./App";
import "./styles.css";

function boot() {
  const app = document.getElementById("app");
  if (!app) throw new Error("App root element was not found.");

  const root = createRoot(app);
  root.render(<App />);
}

try {
  boot();
} catch (error) {
  console.error("Calculator boot failed.", error);
}
