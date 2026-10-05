import type { DependencyList, EffectCallback } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StatsRuntimeMode } from "../lib/statsRuntime";
import type { StatsApiResponse } from "../schemas";
import type { StatsView } from "../ui-types";

type EffectSlot = { dependencies: DependencyList | undefined; cleanup: (() => void) | undefined };
type PendingEffect = {
  index: number;
  dependencies: DependencyList | undefined;
  effect: EffectCallback;
};

// Drive the real hook's asynchronous closures without a DOM. Browser rendering and focus
// remain separate Playwright contracts; this dispatcher models dependency changes and cleanup.
const driver = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as PendingEffect[],
  effectSlots: new Map<number, EffectSlot>(),
  published: [] as unknown[],
  mode: "staging" as StatsRuntimeMode,
  endpoint: "https://stats.example.invalid",
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const sameDependencies = (left: DependencyList | undefined, right: DependencyList | undefined) =>
    left !== undefined &&
    right !== undefined &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]));
  return {
    ...actual,
    useCallback: (callback: unknown, dependencies: DependencyList) => {
      const index = driver.cursor++;
      const previous = driver.slots[index] as
        | { callback: unknown; dependencies: DependencyList }
        | undefined;
      if (!previous || !sameDependencies(previous.dependencies, dependencies)) {
        driver.slots[index] = { callback, dependencies };
      }
      return (driver.slots[index] as { callback: unknown }).callback;
    },
    useEffect: (effect: EffectCallback, dependencies?: DependencyList) => {
      const index = driver.cursor++;
      const previous = driver.effectSlots.get(index);
      if (!previous || !sameDependencies(previous.dependencies, dependencies)) {
        driver.effects.push({ index, dependencies, effect });
      }
    },
    useRef: (initial: unknown) => {
      const index = driver.cursor++;
      driver.slots[index] ??= { current: initial };
      return driver.slots[index];
    },
    useState: (initial: unknown) => {
      const index = driver.cursor++;
      if (!(index in driver.slots)) driver.slots[index] = { value: initial };
      const slot = driver.slots[index] as { value: unknown };
      return [
        slot.value,
        (next: unknown) => {
          slot.value = typeof next === "function" ? next(slot.value) : next;
          driver.published.push(slot.value);
        },
      ];
    },
  };
});
vi.mock("../lib/statsRuntime", () => ({
  statsRuntimeMode: () => driver.mode,
  statsApiBase: () => driver.endpoint,
}));

let useStatsQuery: typeof import("./useStatsQuery")["useStatsQuery"];
const fetchMock = vi.fn<typeof fetch>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function stats(events: number): StatsApiResponse {
  return {
    windowDays: 0,
    today: "2026-10-05",
    summary: {
      events,
      attempts: events * 2,
      greatSuccesses: events,
      greatSuccessRate: 0.5,
      todayEvents: 0,
      todayAttempts: 0,
      todayGreatSuccesses: 0,
      mostUsedKit: null,
      mostUsedKitPieces: 0,
    },
    byKit: [],
    levelKitStats: [],
    segmentStats: [],
    successAttemptDistribution: [],
  };
}

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function render(enabled = true) {
  return StatsQueryHarness(enabled);
}

function StatsQueryHarness(enabled: boolean) {
  driver.cursor = 0;
  driver.effects = [];
  const result = useStatsQuery(enabled);
  for (const pending of driver.effects) {
    driver.effectSlots.get(pending.index)?.cleanup?.();
    const cleanup = pending.effect();
    driver.effectSlots.set(pending.index, {
      dependencies: pending.dependencies,
      cleanup: typeof cleanup === "function" ? cleanup : undefined,
    });
  }
  return result;
}

async function mount(enabled = true) {
  ({ useStatsQuery } = await import("./useStatsQuery"));
  return render(enabled);
}

function view(): StatsView {
  return (driver.slots[0] as { value: StatsView }).value;
}

function unmount() {
  for (const effect of driver.effectSlots.values()) effect.cleanup?.();
  driver.effectSlots.clear();
}

function signalAt(index: number): AbortSignal {
  const signal = fetchMock.mock.calls[index]?.[1]?.signal;
  if (!signal) throw new Error(`Missing AbortSignal for request ${index}.`);
  return signal;
}

async function expectEvents(events: number) {
  await vi.waitFor(() =>
    expect(view()).toMatchObject({ type: "stats", stats: { summary: { events } } }),
  );
}

async function expectError(key: string) {
  await vi.waitFor(() => expect(view()).toEqual({ type: "error", message: { key } }));
}

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock("../schemas");
  vi.doUnmock("../lib/statsView");
  vi.doUnmock("../lib/demoStats");
  fetchMock.mockReset();
  driver.slots = [];
  driver.cursor = 0;
  driver.effects = [];
  driver.effectSlots.clear();
  driver.published = [];
  driver.mode = "staging";
  driver.endpoint = "https://stats.example.invalid";
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", {
    setTimeout: (callback: () => void, delay: number) => globalThis.setTimeout(callback, delay),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(id),
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.doUnmock("../schemas");
  vi.doUnmock("../lib/statsView");
  vi.doUnmock("../lib/demoStats");
});

describe("stats response and retry contracts", () => {
  it("rejects an invalid schema and retries with no-store without publishing the invalid payload", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ summary: { events: 999 } }))
      .mockResolvedValueOnce(response(stats(7)));
    await mount();
    await expectError("stats.invalidResponse");
    expect(driver.published.some((value) => (value as StatsView).type === "stats")).toBe(false);
    render().retryStats();
    await expectEvents(7);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => call[1]?.cache)).toEqual(["default", "no-store"]);
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({ Accept: "application/json" });
  });

  it("distinguishes HTTP failure from network failure and permits an explicit retry", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ error: "unavailable" }, 503))
      .mockResolvedValueOnce(response(stats(3)));
    await mount();
    await expectError("stats.loadFailed");
    render().retryStats();
    await expectEvents(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces fetch rejection and recovers only after an explicit retry", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(response(stats(4)));
    await mount();
    await expectError("stats.connectionFailed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    render().retryStats();
    await expectEvents(4);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces JSON decoding rejection and preserves the retry path", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("{", { status: 200 }))
      .mockResolvedValueOnce(response(stats(5)));
    await mount();
    await expectError("stats.connectionFailed");
    render().retryStats();
    await expectEvents(5);
  });

  it("does not fetch while disabled or after a retry requested by a disabled view", async () => {
    const disabled = await mount(false);
    disabled.retryStats();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(view()).toEqual({ type: "hidden" });
  });
});

describe("stats stale responses and cancellation", () => {
  for (const late of ["valid", "invalid", "http-error", "fetch-error", "json-error"] as const) {
    it(`does not overwrite a newer result with an older ${late} response`, async () => {
      const first = deferred<Response>();
      fetchMock.mockReturnValueOnce(first.promise).mockResolvedValueOnce(response(stats(22)));
      await mount();
      const firstSignal = signalAt(0);
      render().retryStats();
      expect(firstSignal.aborted).toBe(true);
      expect(signalAt(1).aborted).toBe(false);
      await expectEvents(22);
      const published = driver.published.length;
      if (late === "fetch-error") first.reject(new TypeError("late network error"));
      else if (late === "json-error") first.resolve(new Response("{", { status: 200 }));
      else if (late === "http-error") first.resolve(response({}, 503));
      else first.resolve(response(late === "valid" ? stats(11) : { summary: null }));
      await vi.dynamicImportSettled();
      expect(view()).toMatchObject({ type: "stats", stats: { summary: { events: 22 } } });
      expect(driver.published).toHaveLength(published);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  }

  it("rejects an old JSON body even when its response arrived before a replacement request", async () => {
    const body = deferred<unknown>();
    const firstResponse = response(stats(11));
    const json = vi.spyOn(firstResponse, "json").mockReturnValue(body.promise);
    fetchMock.mockResolvedValueOnce(firstResponse).mockResolvedValueOnce(response(stats(22)));
    await mount();
    await vi.waitFor(() => expect(json).toHaveBeenCalledOnce());
    render().retryStats();
    await expectEvents(22);
    const published = driver.published.length;
    body.resolve(stats(11));
    await vi.dynamicImportSettled();
    expect(driver.published).toHaveLength(published);
    expect(view()).toMatchObject({ type: "stats", stats: { summary: { events: 22 } } });
  });

  it("treats an AbortError as cancellation without showing a connection error", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await mount();
    render().retryStats();
    first.reject(new DOMException("cancelled", "AbortError"));
    await vi.dynamicImportSettled();
    expect(view()).toMatchObject({ type: "loading" });
    expect(driver.published.some((value) => (value as StatsView).type === "error")).toBe(false);
    second.resolve(response(stats(9)));
    await expectEvents(9);
  });

  it("aborts on disable and ignores a fetch implementation that still completes", async () => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    await mount();
    const signal = signalAt(0);
    render(false);
    expect(signal.aborted).toBe(true);
    const published = driver.published.length;
    pending.resolve(response(stats(18)));
    await vi.dynamicImportSettled();
    expect(driver.published).toHaveLength(published);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts on unmount and ignores a fetch implementation that still completes", async () => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    await mount();
    const signal = signalAt(0);
    unmount();
    expect(signal.aborted).toBe(true);
    const published = driver.published.length;
    pending.resolve(response(stats(18)));
    await vi.dynamicImportSettled();
    expect(driver.published).toHaveLength(published);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels the delayed submission refresh when the query becomes disabled", async () => {
    fetchMock.mockResolvedValueOnce(response(stats(1)));
    await mount();
    await expectEvents(1);
    vi.useFakeTimers();
    render().markSubmitted();
    render(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(view()).toMatchObject({ type: "stats", stats: { summary: { events: 1 } } });
  });

  it("refreshes a dirty hidden view on re-entry while a clean view keeps its loaded result", async () => {
    fetchMock.mockResolvedValueOnce(response(stats(1))).mockResolvedValueOnce(response(stats(2)));
    await mount();
    await expectEvents(1);
    render(false);
    render(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    render(false).markSubmitted();
    render(true);
    await expectEvents(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("stats lazy module failures", () => {
  it("reports a demo module import rejection without fetching an API", async () => {
    driver.mode = "demo";
    vi.doMock("../lib/demoStats", () => {
      throw new Error("demo module load rejected");
    });
    await mount();
    await expectError("stats.loadFailed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a demo view module import rejection without fetching an API", async () => {
    driver.mode = "demo";
    vi.doMock("../lib/statsView", () => {
      throw new Error("demo view module load rejected");
    });
    await mount();
    await expectError("stats.loadFailed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports the API schema module import rejection as a load connection failure", async () => {
    fetchMock.mockResolvedValueOnce(response(stats(6)));
    vi.doMock("../schemas", () => {
      throw new Error("schema module load rejected");
    });
    await mount();
    await expectError("stats.connectionFailed");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reports the API view module import rejection after a valid schema response", async () => {
    fetchMock.mockResolvedValueOnce(response(stats(6)));
    vi.doMock("../lib/statsView", () => {
      throw new Error("API view module load rejected");
    });
    await mount();
    await expectError("stats.connectionFailed");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not publish a retired demo module failure after the query is disabled", async () => {
    driver.mode = "demo";
    const module = deferred<typeof import("../lib/demoStats")>();
    const started = deferred<void>();
    vi.doMock("../lib/demoStats", () => {
      started.resolve();
      return module.promise;
    });
    await mount();
    await started.promise;
    render(false);
    const published = driver.published.length;
    module.reject(new Error("late demo module load rejected"));
    await vi.dynamicImportSettled();
    expect(driver.published).toHaveLength(published);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
