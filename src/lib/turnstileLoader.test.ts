import { afterEach, describe, expect, it, vi } from "vitest";

type ScriptEvent = "load" | "error";
type FakeScript = {
  dataset: Record<string, string>;
  setAttribute: (name: string, value: string) => void;
  addEventListener: (event: ScriptEvent, listener: () => void) => void;
  removeEventListener: (event: ScriptEvent, listener: () => void) => void;
  remove: () => void;
};

function fakeTurnstileApi() {
  return {
    render: vi.fn(() => "widget"),
    execute: vi.fn(),
    reset: vi.fn(),
    remove: vi.fn(),
  };
}

function installTurnstileDom() {
  const scripts: Array<{
    element: FakeScript;
    dispatch: (event: ScriptEvent) => void;
    removed: () => boolean;
  }> = [];
  const windowState: { turnstile: ReturnType<typeof fakeTurnstileApi> | undefined } = {
    turnstile: undefined,
  };

  vi.stubGlobal("window", windowState);
  vi.stubGlobal("document", {
    querySelector: () => scripts.find((script) => !script.removed())?.element ?? null,
    createElement: () => {
      const listeners = new Map<ScriptEvent, Set<() => void>>();
      let removed = false;
      const element = {
        dataset: {},
        setAttribute: vi.fn(),
        addEventListener(event: ScriptEvent, listener: () => void) {
          const registered = listeners.get(event) ?? new Set();
          registered.add(listener);
          listeners.set(event, registered);
        },
        removeEventListener(event: ScriptEvent, listener: () => void) {
          listeners.get(event)?.delete(listener);
        },
        remove() {
          removed = true;
        },
      };
      scripts.push({
        element,
        dispatch(event) {
          for (const listener of [...(listeners.get(event) ?? [])]) listener();
        },
        removed: () => removed,
      });
      return element;
    },
    head: {
      append: vi.fn(),
    },
  });

  return { scripts, windowState };
}

describe("Turnstile script loader", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("shares one script across concurrent consumers", async () => {
    const { scripts, windowState } = installTurnstileDom();
    const { loadTurnstileScriptApi } = await import("./turnstileScriptLoader");

    const first = loadTurnstileScriptApi();
    const second = loadTurnstileScriptApi();
    const api = fakeTurnstileApi();
    windowState.turnstile = api;
    scripts[0]?.dispatch("load");

    await expect(first).resolves.toBe(api);
    await expect(second).resolves.toBe(api);
    expect(scripts).toHaveLength(1);
    expect(document.head.append).toHaveBeenCalledTimes(1);
  });

  it("allows a fresh attempt after a script error", async () => {
    const { scripts, windowState } = installTurnstileDom();
    const { loadTurnstileScriptApi } = await import("./turnstileScriptLoader");

    const failed = loadTurnstileScriptApi();
    scripts[0]?.dispatch("error");
    await expect(failed).rejects.toThrow("Turnstile script failed.");
    expect(scripts[0]?.removed()).toBe(true);

    const retried = loadTurnstileScriptApi();
    const api = fakeTurnstileApi();
    windowState.turnstile = api;
    scripts[1]?.dispatch("load");

    await expect(retried).resolves.toBe(api);
    expect(scripts).toHaveLength(2);
    expect(document.head.append).toHaveBeenCalledTimes(2);
  });

  it("times out a stalled script and resets for retry", async () => {
    vi.useFakeTimers();
    const { scripts } = installTurnstileDom();
    const { loadTurnstileScriptApi } = await import("./turnstileScriptLoader");

    const stalled = loadTurnstileScriptApi();
    const rejection = expect(stalled).rejects.toThrow("Turnstile script timed out.");
    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
    expect(scripts[0]?.removed()).toBe(true);
    void loadTurnstileScriptApi().catch(() => undefined);
    expect(scripts).toHaveLength(2);
  });
});
