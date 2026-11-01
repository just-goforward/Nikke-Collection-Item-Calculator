/// <reference path="../src/global.d.ts" />
import { act, StrictMode, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { forecastAsyncFixtures } from "./forecast-async.fixtures";
import * as client from "./decision-analytics-client";
import type { DecisionEvent } from "../shared/decisionAnalyticsV3";
import type { useCalculatorApp } from "../src/hooks/useCalculatorApp";
import type { createDecisionBridge } from "../src/analytics/decisionBridge";
import type { createOutcomeBridge } from "../src/analytics/outcomeBridge";
import type { RunProvider } from "../src/analytics/decisionRun";
import type { CollectionState, Stock } from "../src/types";
import type { StatsSubmissionEnvelope } from "../src/lib/statsSubmissionQueue";
export {
  cleanupStatsSubmissionDom, loadTurnstileApi, makeStatsSubmissionEnvelope,
} from "../src/lib/statsSubmitClient";
import type { TurnstileTokenProvider } from "../src/lib/turnstileTokenProvider";

type Fixtures = Awaited<ReturnType<typeof forecastAsyncFixtures>>;
type Model = ReturnType<typeof useCalculatorApp>;
type Bridge = ReturnType<typeof createDecisionBridge> | ReturnType<typeof createOutcomeBridge>;
type Input = CollectionState & { stock: Stock };
export type BootOptions = {
  harness?: "app" | "core";
  mode?: "enabled" | "off" | "unconfigured" | "baseline";
  legacyAccountFlag?: boolean;
  legacyStatsConfig?: boolean;
  seedPersonal?: boolean;
  denyStorage?: boolean;
  composition?: "strict" | "production";
  productionPortFailure?: boolean;
  outcomeV4?: boolean;
  holdOutcomeTransport?: boolean;
};
type Guards = {
  unexpected: string[];
  visibility: DocumentVisibilityState;
};
declare global {
  interface Window {
    decisionAnalytics: typeof api;
    decisionAnalyticsGuards: Guards;
    IS_REACT_ACT_ENVIRONMENT: boolean;
  }
}

let root: Root | null = null;
let bridge: Bridge | undefined;
let model: Model | undefined;
let refreshRuntime: (() => Promise<void>) | undefined;
let fixtures: Fixtures;
let publication: "a" | "b" | "off" = "a";
let capturedAttempt: Model["actions"]["submitSuccessAttempt"] | undefined;
let capturedOutcome: Model["actions"]["applyOutcome"] | undefined;
let releaseAct: (() => void) | undefined;
let clockAct: Promise<void> | undefined;
let coreHarness = false;
let rootComposition: "strict" | "production" = "strict";
let cleanupProductionFixture: (() => void) | undefined;
let outcomeTransportHeld = false;
const productionDelivery = {
  requests: 0, tokens: 0, idsBeforeSecurity: -1, idsAtSecurityReady: -1,
  actions: [] as unknown[],
  wires: [] as Array<{
    url: string; credentials: RequestCredentials | undefined; referrerPolicy: ReferrerPolicy | undefined;
    headers: [string, string][]; body: Record<string, unknown>;
  }>,
};
const events: DecisionEvent[] = [];
const sentAt: Array<{ stage: string; level: number | null; blueStock: string | null }> = [];
const legacyEvents: StatsSubmissionEnvelope[] = [];
let legacyHold = false;
let legacyPending = 0;
let legacyConfigured = false;
let legacyProviderUses = 0;
const releaseLegacy: Array<() => void> = [];
const tasks: Array<{ done: boolean; rejected: string | null }> = [];
const counts = { analyticsIds: 0, analyticsSchedules: 0, analyticsTimers: 0, forecastFetches: 0,
  mounts: 0, cleanups: 0 };
const timers = new Set<Parameters<typeof window.clearTimeout>[0]>();
const intervals = new Set<Parameters<typeof window.clearInterval>[0]>();
const listeners = new Map<EventTarget, Map<string, Map<EventListenerOrEventListenerObject, Set<boolean>>>>();

function installResourceCounters() {
  const setTimeoutOriginal = window.setTimeout.bind(window);
  const clearTimeoutOriginal = window.clearTimeout.bind(window);
  window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const id = setTimeoutOriginal(() => {
      timers.delete(id);
      if (typeof handler === "function") handler(...args);
      else throw new Error("string_timer_prohibited");
    }, timeout);
    timers.add(id);
    return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = (id) => {
    if (id !== undefined) timers.delete(id);
    clearTimeoutOriginal(id);
  };
  const setIntervalOriginal = window.setInterval.bind(window);
  const clearIntervalOriginal = window.clearInterval.bind(window);
  window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const id = setIntervalOriginal(handler, timeout, ...args);
    intervals.add(id);
    return id;
  }) as typeof window.setInterval;
  window.clearInterval = (id) => {
    if (id !== undefined) intervals.delete(id);
    clearIntervalOriginal(id);
  };
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function(type, listener, options) {
    if (listener && (this === window || this === document)) {
      const byType = listeners.get(this) ?? new Map();
      listeners.set(this, byType);
      const byListener = byType.get(type) ?? new Map();
      byType.set(type, byListener);
      const captures = byListener.get(listener) ?? new Set();
      byListener.set(listener, captures);
      captures.add(typeof options === "boolean" ? options : options?.capture === true);
    }
    return add.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function(type, listener, options) {
    if (listener) listeners.get(this)?.get(type)?.get(listener)?.delete(
      typeof options === "boolean" ? options : options?.capture === true,
    );
    return remove.call(this, type, listener, options);
  };
}

function listenerCounts() {
  return [...listeners.entries()].flatMap(([target, types]) =>
    [...types.entries()].map(([type, callbacks]) => [
      `${target === document ? "document" : "window"}:${type}`,
      [...callbacks.values()].reduce((sum, captures) => sum + captures.size, 0),
    ] as const)).filter(([, count]) => count > 0).sort(([a], [b]) => a.localeCompare(b));
}

function launch(action: () => unknown) {
  const task = { done: false, rejected: null as string | null };
  tasks.push(task);
  try {
    void Promise.resolve(action()).catch((error: unknown) => {
      task.rejected = error instanceof Error ? error.message : String(error);
    }).finally(() => { task.done = true; });
  } catch (error) {
    task.rejected = error instanceof Error ? error.message : String(error);
    task.done = true;
  }
}

async function commit(callback: () => void | Promise<void>) {
  // A browser-driven App is not a unit-test act scope: real UI animations and
  // deferred loading advance under Playwright's clock and DOM assertions.
  if (coreHarness) await act(callback);
  else await callback();
}

async function flush() {
  if (coreHarness) await act(async () => { await Promise.resolve(); });
  if (!outcomeTransportHeld) await bridge?.flush();
}

async function initialize(value: Fixtures, options: BootOptions = {}) {
  fixtures = value;
  outcomeTransportHeld = options.holdOutcomeTransport === true;
  installResourceCounters();
  coreHarness = options.harness === "core";
  rootComposition = options.composition ?? "strict";
  legacyConfigured = options.legacyStatsConfig === true;
  window.IS_REACT_ACT_ENVIRONMENT = coreHarness;
  window.COLLECTION_ACCOUNT_CONFIG = { enabled: options.legacyAccountFlag === true };
  if (options.legacyStatsConfig) window.COLLECTION_STATS_CONFIG = {
    staging: { endpoint: "https://staging.nikkecollection.com", turnstileSiteKey: "TEST-ONLY-security" },
  };
  const { CERTIFIED_STAGING_ENGINE_PROFILE } = await import("../shared/certifiedEngineProfile");
  const { createDecisionBridge: createBridge } = await import("../src/analytics/decisionBridge");
  const { I18nProvider } = await import("../src/i18n/locale");
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.origin === location.origin && (url.pathname === "/api/forecast" ||
        url.pathname === "/api/forecast/version") && (!init?.method || init.method === "GET")) {
      ++counts.forecastFetches;
      const next = fixtures[publication];
      return Response.json({ pointer: next.pointer, remainingMs: 60_000,
        ...(url.pathname === "/api/forecast" ? { artifact: next.artifact } : {}) });
    }
    return nativeFetch(input, init);
  };
  const producer: RunProvider = {
    producerVersion: "TEST-ONLY-mounted-v3",
    producerCodeHash: CERTIFIED_STAGING_ENGINE_PROFILE.codeHash,
    forecasts: [value.a, value.b].map((entry) => ({
      contentHash: (JSON.parse(entry.pointer.statement) as { contentHash: string }).contentHash,
      expectedSupply: { blue: "one_to_nine", purple: "zero", yellow: "ten_to_forty_nine" },
    })),
    bindAcquisition(source, actual) {
      const entry = source.find((item) => item.contentHash === actual.contentHash);
      return entry ? { ...entry, ...actual } : undefined;
    },
  };
  bridge = createBridge({
    enabled: options.mode !== "off" && options.mode !== "baseline",
    ...(options.mode === "unconfigured" ? {} : {
      producer, allowedProducers: [{
        producerVersion: producer.producerVersion, producerCodeHash: producer.producerCodeHash,
      }],
    }),
    now: () => performance.now(),
    randomUUID: () => `00000000-0000-4000-8000-${String(++counts.analyticsIds).padStart(12, "0")}`,
    send: async (event) => {
      events.push(structuredClone(event));
      const pressed = document.querySelector<HTMLElement>("#levelGrid [aria-pressed=true]");
      sentAt.push({ stage: event.stage,
        level: model?.statePanel.level ?? (pressed ? Number(pressed.dataset["level"]) : null),
        blueStock: document.querySelector<HTMLInputElement>("#blueStock")?.value ?? null });
      return { ok: true, duplicate: false };
    },
    schedule(callback, delay) {
      ++counts.analyticsSchedules;
      ++counts.analyticsTimers;
      const timer = window.setTimeout(callback, delay);
      return () => { --counts.analyticsTimers; window.clearTimeout(timer); };
    },
  });
  if (options.productionPortFailure || options.outcomeV4) {
    const { decisionProductionFixture } = await import("./decision-analytics-production.fixture");
    const fixture = decisionProductionFixture({
      producer: { producerVersion: producer.producerVersion, producerCodeHash: producer.producerCodeHash },
      cases: [value.a, value.b].map(publication => ({
        publication, expectedSupply: { blue: "one_to_nine", purple: "zero", yellow: "ten_to_forty_nine" },
      })),
      environment: {
        origin: "https://nikkecollection.com",
        now: () => performance.now(),
        randomUUID: () => `00000000-0000-4000-8000-${String(++counts.analyticsIds).padStart(12, "0")}`,
        fetch: async (url, init) => {
          if (!init || url !== "https://nikkecollection.com/api/decision-outcomes" || init.method !== "POST")
            throw new Error("synthetic_transport_target_mismatch");
          ++productionDelivery.requests;
          productionDelivery.wires.push({
            url, credentials: init.credentials, referrerPolicy: init.referrerPolicy,
            headers: Array.from(new Headers(init.headers).entries()),
            body: JSON.parse(String(init.body)),
          });
          if (outcomeTransportHeld) await new Promise<void>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("TEST_ONLY_transport_aborted")), { once: true });
          });
          if (options.productionPortFailure) throw new Error("TEST_ONLY_delivery_unavailable");
          return Response.json({ ok: true, duplicate: false });
        },
        loadTurnstile: async () => {
          productionDelivery.idsBeforeSecurity = counts.analyticsIds;
          await Promise.resolve();
          productionDelivery.idsAtSecurityReady = counts.analyticsIds;
          let callback: unknown;
          return {
            render: (_container, options) => {
              productionDelivery.actions.push(options["action"]);
              callback = options["callback"];
              return "TEST_ONLY_widget";
            },
            reset: () => undefined,
            remove: () => undefined,
            execute: () => {
              if (typeof callback === "function")
                callback(`TEST_ONLY_fresh_decision_token_${++productionDelivery.tokens}`);
            },
          };
        },
        createContainer: () => {
          const container = document.createElement("div");
          document.body.append(container);
          return container;
        },
      },
    });
    cleanupProductionFixture = fixture.cleanup;
    bridge = await fixture.create();
    if (!bridge?.enabled) throw new Error("synthetic_production_port_required");
  }
  // The fixture owns this external bridge beyond StrictMode's simulated
  // effect cleanup; the real port still owns each run's unmount retirement.
  const decision = options.mode === "baseline" ? undefined : {
    enabled: bridge.enabled, providerReady: bridge.providerReady, lifecycle: bridge.lifecycle,
  };
  const { runtimeForecast } = await import("../src/lib/runtimeForecast");
  refreshRuntime = () => runtimeForecast.refresh();
  const { useEffect } = await import("react");
  let content;
  if (options.harness === "core") {
    const { useCalculatorApp: useApp } = await import("../src/hooks/useCalculatorApp");
    const { useDecisionPort } = await import("../src/analytics/useDecisionPort");
    function Core() {
      const port = useDecisionPort(decision);
      const next = useApp(false, port.lifecycle);
      useLayoutEffect(() => { model = next; });
      useEffect(() => {
        ++counts.mounts;
        return () => { ++counts.cleanups; };
      }, []);
      return <output data-testid="actual-core-state">{JSON.stringify({
        level: next.statePanel.level, result: next.resultView.type,
        busy: next.inputLocked, modal: next.modal.open,
      })}</output>;
    }
    content = <Core />;
  } else {
    const { default: App } = await import("../src/App");
    function MountedApp() {
      useEffect(() => {
        ++counts.mounts;
        return () => { ++counts.cleanups; };
      }, []);
      return <App {...(decision ? { decision } : {})} />;
    }
    content = <MountedApp />;
  }
  root = createRoot(document.getElementById("app")!);
  if (rootComposition === "production") {
    const { AppErrorBoundary } = await import("../src/components/AppErrorBoundary");
    await commit(() => { root!.render(
      <I18nProvider><AppErrorBoundary>{content}</AppErrorBoundary></I18nProvider>,
    ); });
  } else {
    await commit(() => { root!.render(<StrictMode><I18nProvider>{content}</I18nProvider></StrictMode>); });
  }
  await flush();
}

export const api = {
  initialize, flush,
  waitRequest: client.waitRequest,
  async current(index: number, value: client.SyntheticResult = {}) {
    await commit(async () => { await client.current(index, value); });
    await flush();
  },
  async finish(index: number, value: client.SyntheticResult = {}) {
    await commit(async () => { await client.finish(index, value); });
    await flush();
  },
  async fail(index: number, reason: "error" | "limit" | "cancel") {
    await commit(() => { client.fail(index, reason); });
    await flush();
  },
  async action(name: "restore" | "calculate" | "outcome" | "attempt" | "level" | "exp" | "grade" | "stock",
    value?: Input | number | null | "success" | "fail" | Stock | "R" | "SR") {
    if (!model) throw new Error("core_harness_required");
    await act(async () => {
      const actions = model!.actions;
      switch (name) {
        case "restore": actions.restoreInputSnapshot(value as Input); break;
        case "calculate": launch(actions.calculate); break;
        case "outcome": launch(() => actions.applyOutcome(value as "success" | "fail")); break;
        case "attempt": launch(() => actions.submitSuccessAttempt(value as number | null)); break;
        case "level": actions.setLevel(value as number); break;
        case "exp": actions.setExp(value as number); break;
        case "grade": actions.setGrade(value as "R" | "SR"); break;
        case "stock": actions.setStock(value as Stock); break;
      }
    });
    await flush();
  },
  captureCallbacks() {
    if (!model) throw new Error("core_harness_required");
    capturedAttempt = model.actions.submitSuccessAttempt;
    capturedOutcome = model.actions.applyOutcome;
  },
  async invokeCaptured() {
    await act(async () => {
      launch(() => capturedAttempt?.(1));
      launch(() => capturedOutcome?.("success"));
    });
    await flush();
  },
  async publication(next: typeof publication) {
    publication = next;
    await commit(async () => { await refreshRuntime?.(); });
    await flush();
  },
  async visibility(value: DocumentVisibilityState) {
    window.decisionAnalyticsGuards.visibility = value;
    await commit(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await flush();
  },
  openAct() {
    if (coreHarness) clockAct = Promise.resolve(act(async () => {
      await new Promise<void>((resolve) => { releaseAct = resolve; });
    }));
  },
  async closeAct() { releaseAct?.(); await clockAct; clockAct = undefined; releaseAct = undefined; await flush(); },
  async unmount() {
    await commit(() => { root?.unmount(); root = null; });
    if (outcomeTransportHeld) bridge?.disable();
    await bridge?.flush();
    bridge?.disable();
    cleanupProductionFixture?.();
    for (const release of releaseLegacy.splice(0)) release();
  },
  holdLegacySender() { legacyHold = true; },
  snapshot() {
    return {
      events: structuredClone(events), sentAt: structuredClone(sentAt), tasks: structuredClone(tasks),
      counts: { ...counts }, timers: timers.size, intervals: intervals.size,
      productionDelivery: { ...productionDelivery },
      listeners: listenerCounts(), client: { ...client.evidence },
      requests: client.requests.map((request) => ({
        grade: request.input.grade, level: request.input.level, stock: request.input.stock,
        asOf: request.input.asOf, sourceHash: request.input.snapshot.sourceHash,
        publication: request.input.forecastPublication,
        aborted: request.options.signal?.aborted ?? false,
      })),
      unexpected: [...window.decisionAnalyticsGuards.unexpected],
      legacyEvents: structuredClone(legacyEvents), legacyPending, legacyProviderUses,
      persistence: window.decisionPersistence.evidence(),
      rootComposition,
      core: model ? {
        state: model.statePanel, stock: model.stockPanel.stock, stale: model.stockPanel.isStale,
        result: model.resultView.type, busy: model.inputLocked, modal: model.modal,
      } : null,
    };
  },
};
window.decisionAnalytics = api;

// Only the external legacy delivery/security boundary is substituted. The real
// submission hook, envelope construction, memory outbox and queue still execute.
export async function submitStatsEnvelope(envelope: StatsSubmissionEnvelope): Promise<void> {
  legacyEvents.push(structuredClone(envelope));
  if (legacyHold) {
    ++legacyPending;
    await new Promise<void>((resolve) => releaseLegacy.push(resolve));
    --legacyPending;
  }
}

// Configure the external legacy sender without selecting the unrelated legacy
// staging-supply UI/preparation path via statsEnv in the actual App URL.
export function statsSubmissionConfig() {
  return legacyConfigured ? {
    endpoint: "https://staging.nikkecollection.com", turnstileSiteKey: "TEST-ONLY-security",
  } : null;
}
export function statsSubmissionProvider(): TurnstileTokenProvider {
  ++legacyProviderUses;
  return {} as TurnstileTokenProvider;
}
