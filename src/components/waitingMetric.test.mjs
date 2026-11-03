import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

// Bundle in memory: no Vite build hooks, forecast preparation or solver execution.
const bundle = await build({
  stdin: {
    contents: `
      export { serviceCertifiedViews, withoutRecommendedWait } from "./src/hooks/serviceCertifiedPresentation";
      export { handleSolveFailure, executeSolveAndRender } from "./src/hooks/calculatorSolveFlow";
      export { invalidatedDetailView } from "./src/hooks/useCalculatorApp";
      export { ServiceCertifiedCancelled } from "./src/hooks/serviceCertifiedTypes";
      import { useCalculatorResultRendering } from "./src/hooks/calculatorResultRendering";
      import React from "react";
      import { renderToString } from "react-dom/server";
      import { DetailPanelRegion } from "./src/AppLayout";
      import { I18nProvider } from "./src/i18n/locale";
      export function completeView() {
        let detail;
        function Completion() {
          const renderer = useCalculatorResultRendering({
            actionTransitionIdRef: { current: 0 }, latestResultRef: { current: null },
            setDetailView(value) { detail = value; },
            setResultView() {}, setValidationView() {}
          });
          renderer.renderMaxLevelState("SR", 15);
          return null;
        }
        renderToString(React.createElement(Completion));
        return detail;
      }
      export function render(view, loading = false) {
        return renderToString(React.createElement(I18nProvider, null,
          React.createElement(DetailPanelRegion, { calculator: {
            detailView: view, resultView: { type: loading ? "loading" : "empty" },
            actions: { runMonteCarloValidation() {} }, validationView: {
            buttonLabel: { key: "detail.notApplicable" }, disabled: true,
            message: { key: "detail.notApplicable" }, status: "idle"
          } }, showSolverBackend: false })));
      }`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true, write: false, platform: "node", format: "esm",
  define: { "import.meta.env": '{"VITE_SERVICE_CERTIFIED_SOLVER":"true"}' },
  packages: "external", jsx: "automatic",
});
// External packages resolve relative to this test, not a temporary directory.
const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const source = bundle.outputFiles[0].text.replace(
  /from "(react(?:-dom)?(?:\/[^"]*)?)"/g,
  (_, name) => `from ${JSON.stringify(new URL(`file:///${require.resolve(name).replaceAll("\\", "/")}`).href)}`,
);
const { serviceCertifiedViews, withoutRecommendedWait, render,
  handleSolveFailure, executeSolveAndRender, invalidatedDetailView,
  ServiceCertifiedCancelled, completeView } =
  await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

test("waiting card persists with authoritative states and clears stale dates on edits", () => {
  const idle = { type: "empty", message: { key: "detail.notApplicable" } };
  assert.equal(waitingText(render(idle)), "계산 전");
  assert.equal(waitingText(render({ type: "loading" }, true)), "비교 중");
  const input = { start: { grade: "SR", level: 0 } };
  const output = {
    status: "completed",
    current: { status: "preserve", value: { display: { successP: 0.4 } } },
    waiting: { status: "unresolved" },
  };
  const value = { output, final: true, action: null };
  const view = () => serviceCertifiedViews(input, value).detail;
  const key = () => view().waitingLabel?.key;
  assert.equal(key(), "detail.wait.incomplete");
  assert.equal(waitingText(render(view())), "대기 비교 미완료");
  output.stableRecommendation = {
    selection: { status: "STABLE_WAIT_UNCONFIRMED" }, guidance: { status: "INCOMPLETE" },
  };
  assert.equal(key(), "detail.wait.unresolved");
  assert.equal(waitingText(render(view())), "대기 추천 미확정");
  output.stableRecommendation.guidance = { status: "WITHHELD" };
  assert.equal(key(), "detail.wait.withheld");
  assert.equal(waitingText(render(view())), "예측 불확실 · 추천 보류");
  assert.equal(withoutRecommendedWait(view()).waitingLabel, undefined);
  output.stableRecommendation = { selection: { status: "NOW" }, guidance: { status: "NOW" } };
  assert.equal(key(), "detail.wait.now");
  assert.equal(waitingText(render(view())), "지금 강화 가능");
  output.stableRecommendation = { selection: { status: "WAIT", day: 3 }, guidance: { status: "WAIT", day: 3 } };
  const wait = view();
  assert.equal(wait.recommendedWaitDays, 3);
  output.stableRecommendation.guidance.day = 4;
  assert.equal(key(), "detail.wait.incomplete");
  assert.equal(view().recommendedWaitDays, undefined);
  output.stableRecommendation.guidance.day = 3;
  assert.equal(waitingText(render(wait)), "3일 후");
  const reset = withoutRecommendedWait(wait);
  assert.equal(reset.recommendedWaitDays, undefined);
  assert.equal(reset.waitingLabel, undefined);
  assert.equal(reset.successProbability, wait.successProbability);
  assert.equal(reset.greatSuccessProbability, wait.greatSuccessProbability);
  assert.equal(waitingText(render(reset)), "계산 전");
  assert.equal(waitingText(render(wait, true)), "비교 중");
  assert.equal(waitingText(render(idle)), "계산 전");
  value.final = false;
  assert.equal(key(), "detail.wait.incomplete");
  assert.equal(view().recommendedWaitDays, undefined);
  value.final = true;
  output.claimNotice = {};
  assert.equal(key(), "detail.wait.claim");
  assert.equal(waitingText(render(view())), "보상 수령 확인 필요");
  delete output.claimNotice;
  output.status = "refused";
  assert.equal(key(), "detail.wait.error");
  assert.equal(waitingText(render(view())), "대기 효과 확인 불가");
  output.status = "completed";
  input.start.level = 15;
  output.current.status = "complete";
  assert.equal(key(), "detail.wait.complete");
  assert.equal(waitingText(render(view())), "강화 완료");
});

function waitingText(html) {
  const visible = html.replace(/<template[\s\S]*?<\/template>/g, "");
  const card = visible.split('data-testid="waiting-metric"')[1];
  assert.ok(card, "application detail boundary must expose the waiting card");
  return card.match(/<strong[^>]*>([\s\S]*?)<\/strong>/)[1].replace(/<!--.*?-->/g, "");
}

test("authoritative failure, completion and cancellation reach the app boundary", () => {
  const context = {
    input: {}, inputRevision: 1, inputRevisionRef: { current: 1 },
    latestResultRef: { current: {} }, queueStatsEvent() {},
  };
  const failed = handleSolveFailure({ ...context, error: new Error("synthetic") });
  assert.equal(waitingText(render(failed.views.detail)), "대기 효과 확인 불가");
  assert.equal(waitingText(render(completeView())), "강화 완료");
  const cancelled = handleSolveFailure({ ...context, error: new ServiceCertifiedCancelled() });
  assert.equal(waitingText(render(cancelled.views.detail)), "계산 전");
  assert.equal(context.latestResultRef.current, null);
  context.inputRevisionRef.current = 2;
  const superseded = handleSolveFailure({ ...context, error: new ServiceCertifiedCancelled() });
  assert.equal(superseded.views, undefined, "input/reset state must not be overwritten by late cancellation");
});

test("forecast supersession/off before Current clears Comparing and rejects late output", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const timers = new Set();
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { pathname: "/" },
    setTimeout(callback) { timers.add(callback); return callback; },
    clearTimeout(callback) { timers.delete(callback); },
  } });
  try {
    for (const disposition of ["supersession-late-result", "off-cancellation"]) {
      let detail = { type: "empty", message: { key: "detail.initial" } };
      let result = { type: "empty" };
      let checkpoint;
      let resolve;
      let reject;
      const deferred = new Promise((yes, no) => { resolve = yes; reject = no; });
      const revision = { current: 0 };
      const busy = { current: false };
      let renders = 0;
      const pending = executeSolveAndRender({
        busyRef: busy, unmountedRef: { current: false }, executionRef: { current: 0 },
        inputRevisionRef: revision, latestResultRef: { current: null },
        getCurrentViews: () => ({ detail, result }),
        setDetailView(value) { detail = typeof value === "function" ? value(detail) : value; },
        setResultView(value) { result = typeof value === "function" ? value(result) : value; },
        setCalculateBusy() {}, setLoading() {}, prepareForSolve() {},
        queueStatsEvent() {}, renderResult() { renders++; },
        solveBestAvailable(_input, callback) { checkpoint = callback; return deferred; },
      }, {}, {});
      assert.equal(detail.type, "loading", disposition);
      assert.equal(waitingText(render(detail, result.type === "loading")), "비교 중");
      // The same updater used by forecastInvalidated owns the advanced revision.
      revision.current++;
      detail = invalidatedDetailView(detail);
      if (result.type === "loading") result = { type: "empty" };
      assert.equal(waitingText(render(detail, result.type === "loading")), "계산 전");
      checkpoint({ certified: { final: false } });
      if (disposition === "off-cancellation") reject(new ServiceCertifiedCancelled());
      else resolve({ kind: "service-certified", result: { certified: { final: true } } });
      assert.equal(await pending, false);
      assert.equal(renders, 0, "superseded checkpoints and final results must not publish");
      assert.equal(busy.current, false);
      assert.equal(waitingText(render(detail, result.type === "loading")), "계산 전");
    }
    assert.equal(timers.size, 0);
    const metrics = {
      type: "metrics", successProbability: "40%", greatSuccessProbability: null,
      recommendedWaitDays: 3, waitingLabel: { key: "detail.wait.now" },
      candidates: [], monteCarloRuns: 0, solverLabel: "Certified Rust/WASM",
    };
    const retained = invalidatedDetailView(metrics);
    assert.equal(retained.type, "metrics");
    assert.equal(retained.successProbability, "40%");
    assert.equal(retained.recommendedWaitDays, undefined);
    assert.equal(waitingText(render(retained)), "계산 전");
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete globalThis.window;
  }
});
