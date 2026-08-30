import { createRoot } from "react-dom/client";

import App from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { detectInitialLocale, I18nProvider, prepareInitialLocale, translate } from "./i18n/locale";
import { prepareRuntimeSupplyForecast } from "./lib/supplyForecastRuntime";
import "./styles.css";

function boot() {
  const app = document.getElementById("app");
  if (!app) throw new Error("App root element was not found.");
  document.documentElement.dataset["buildRevision"] = __APP_REVISION__;
  prepareInitialLocale();

  const root = createRoot(app);
  root.render(
    <I18nProvider>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </I18nProvider>,
  );
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
  const locale = detectInitialLocale();
  title.textContent = translate(locale, "boot.title");
  const detail = document.createElement("p");
  detail.textContent = translate(locale, "boot.detail");
  panel.append(title, detail);
  app.append(panel);
}

const forecastPreparation = prepareRuntimeSupplyForecast();
if (forecastPreparation) {
  void forecastPreparation.then(boot).catch(renderBootFailure);
} else {
  try {
    boot();
  } catch (error) {
    renderBootFailure(error);
  }
}
