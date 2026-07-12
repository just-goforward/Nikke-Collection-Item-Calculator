import { createRoot } from "react-dom/client";

import App from "./App";
import "./styles.css";

function boot() {
  const app = document.getElementById("app");
  if (!app) throw new Error("App root element was not found.");

  const root = createRoot(app);
  root.render(<App />);
}

function renderBootFailure(error: unknown) {
  console.error("Calculator boot failed.", error);
  const app = document.getElementById("app");
  if (!app) return;
  app.replaceChildren();
  const panel = document.createElement("main");
  panel.className = "boot-error";
  panel.setAttribute("role", "alert");
  const title = document.createElement("h1");
  title.textContent = "계산기를 불러오지 못했습니다.";
  const detail = document.createElement("p");
  detail.textContent = "페이지를 새로고침한 뒤 다시 시도해주세요.";
  panel.append(title, detail);
  app.append(panel);
}

try {
  boot();
} catch (error) {
  renderBootFailure(error);
}
