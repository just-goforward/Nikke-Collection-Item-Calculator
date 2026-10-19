import type { ComponentType } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { detectInitialLocale, I18nProvider, prepareInitialLocale, translate } from "./i18n/locale";
import { CERTIFIED_ONLY_BUILD, usesCertifiedEngineFromSearch } from "./lib/engineProfile";
import { prepareRuntimeSupplyForecast } from "./lib/supplyForecastRuntime";
import "./styles.css";

function boot(Calculator: ComponentType) {
  const app = document.getElementById("app");
  if (!app) throw new Error("App root element was not found.");
  document.documentElement.dataset["buildRevision"] = __APP_REVISION__;
  prepareInitialLocale();

  const root = createRoot(app);
  root.render(
    <I18nProvider>
      <AppErrorBoundary>
        <Calculator />
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

if (CERTIFIED_ONLY_BUILD || usesCertifiedEngineFromSearch(location.search)) {
  void import("./certifiedUi/CertifiedCalculator")
    .then((module) => boot(module.default))
    .catch(renderBootFailure);
} else {
  const forecastPreparation = prepareRuntimeSupplyForecast();
  if (forecastPreparation) {
    void forecastPreparation.then(() => boot(App)).catch(renderBootFailure);
  } else {
    try {
      boot(App);
    } catch (error) {
      renderBootFailure(error);
    }
  }
}
