import { describe, expect, it, vi } from "vitest";
import { STATS_DELIVERY_EVENT_KINDS } from "../../shared/solverRecoveryContract";

import { type TurnstileApi, TurnstileTokenProvider } from "./turnstileTokenProvider";

const TURNSTILE_CALLBACK_KEY = "callback";

describe("TurnstileTokenProvider", () => {
  it.each(STATS_DELIVERY_EVENT_KINDS)(
    "creates an exact %s action widget and resets its completed attempt",
    async (kind) => {
      const options = new Map<string, Record<string, unknown>>();
      const callbackFor = (id: string): ((token: string) => void) | undefined => {
        const callback = options.get(id)?.[TURNSTILE_CALLBACK_KEY];
        return typeof callback === "function" ? (callback as (token: string) => void) : undefined;
      };
      const api: TurnstileApi = {
        render: vi.fn((_container, config) => {
          const id = `widget-${String(config.action)}`;
          options.set(id, config);
          return id;
        }),
        execute: vi.fn((id) => {
          callbackFor(id)?.(`token-${id}`);
        }),
        reset: vi.fn(),
        remove: vi.fn(),
      };
      const provider = new TurnstileTokenProvider(
        "site-key",
        async () => api,
        () => ({}) as HTMLElement,
      );

      const token = await provider.issueToken(kind);
      provider.reset(kind);

      expect(token).toBe(`token-widget-${kind}`);
      expect(api.render).toHaveBeenCalledTimes(1);
      expect(options.get(`widget-${kind}`)).toMatchObject({
        action: kind,
        execution: "execute",
      });
      expect(options.get(`widget-${kind}`)).not.toHaveProperty("size");
      expect(api.reset).toHaveBeenCalledWith(`widget-${kind}`);
    },
  );

  it("keeps action-specific widgets separate across sequential kinds", async () => {
    const options = new Map<string, Record<string, unknown>>();
    const callbackFor = (id: string): ((token: string) => void) | undefined => {
      const callback = options.get(id)?.[TURNSTILE_CALLBACK_KEY];
      return typeof callback === "function" ? (callback as (token: string) => void) : undefined;
    };
    const api: TurnstileApi = {
      render: vi.fn((_container, config) => {
        const id = `widget-${String(config.action)}`;
        options.set(id, config);
        return id;
      }),
      execute: vi.fn((id) => {
        callbackFor(id)?.(`token-${id}`);
      }),
      reset: vi.fn(),
      remove: vi.fn(),
    };
    const provider = new TurnstileTokenProvider(
      "site-key",
      async () => api,
      () => ({}) as HTMLElement,
    );

    const resultToken = await provider.issueToken("kit_result");
    provider.reset("kit_result");
    const diagnosticToken = await provider.issueToken("solver_diagnostic");
    provider.reset("solver_diagnostic");
    const invariantToken = await provider.issueToken("runtime_invariant");
    provider.reset("runtime_invariant");
    const recoveryToken = await provider.issueToken("solver_recovery");
    provider.reset("solver_recovery");

    expect(resultToken).toBe("token-widget-kit_result");
    expect(diagnosticToken).toBe("token-widget-solver_diagnostic");
    expect(invariantToken).toBe("token-widget-runtime_invariant");
    expect(recoveryToken).toBe("token-widget-solver_recovery");
    expect(new Set([resultToken, diagnosticToken, invariantToken, recoveryToken]).size).toBe(4);
    expect(api.render).toHaveBeenCalledTimes(4);
    expect(options.get("widget-kit_result")).toMatchObject({
      action: "kit_result",
      execution: "execute",
    });
    expect(options.get("widget-solver_diagnostic")).toMatchObject({
      action: "solver_diagnostic",
      execution: "execute",
    });
    expect(options.get("widget-runtime_invariant")).toMatchObject({
      action: "runtime_invariant",
      execution: "execute",
    });
    expect(options.get("widget-solver_recovery")).toMatchObject({
      action: "solver_recovery",
      execution: "execute",
    });
    expect(options.get("widget-kit_result")).not.toHaveProperty("size");
    expect(options.get("widget-solver_diagnostic")).not.toHaveProperty("size");
    expect(options.get("widget-runtime_invariant")).not.toHaveProperty("size");
    expect(options.get("widget-solver_recovery")).not.toHaveProperty("size");
    expect(api.execute).toHaveBeenNthCalledWith(1, "widget-kit_result");
    expect(api.execute).toHaveBeenNthCalledWith(2, "widget-solver_diagnostic");
    expect(api.execute).toHaveBeenNthCalledWith(3, "widget-runtime_invariant");
    expect(api.execute).toHaveBeenNthCalledWith(4, "widget-solver_recovery");
    expect(api.reset).toHaveBeenNthCalledWith(1, "widget-kit_result");
    expect(api.reset).toHaveBeenNthCalledWith(2, "widget-solver_diagnostic");
    expect(api.reset).toHaveBeenNthCalledWith(3, "widget-runtime_invariant");
    expect(api.reset).toHaveBeenNthCalledWith(4, "widget-solver_recovery");
  });

  it("removes created widgets on disposal", async () => {
    const api: TurnstileApi = {
      render: vi.fn(() => "widget-kit_result"),
      execute: vi.fn(() => undefined),
      reset: vi.fn(),
      remove: vi.fn(),
    };
    const provider = new TurnstileTokenProvider(
      "site-key",
      async () => api,
      () => ({}) as HTMLElement,
      1,
    );

    const pending = provider.issueToken("kit_result").catch(() => undefined);
    await vi.waitFor(() => {
      expect(api.render).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "kit_result" }),
      );
    });
    provider.dispose();
    await pending;

    expect(api.remove).toHaveBeenCalledWith("widget-kit_result");
  });

  it("does not create widgets after disposal during script loading", async () => {
    let releaseApi: ((api: TurnstileApi) => void) | undefined;
    const api: TurnstileApi = {
      render: vi.fn(() => "widget-kit_result"),
      execute: vi.fn(),
      reset: vi.fn(),
      remove: vi.fn(),
    };
    const provider = new TurnstileTokenProvider(
      "site-key",
      () =>
        new Promise<TurnstileApi>((resolve) => {
          releaseApi = resolve;
        }),
      () => ({}) as HTMLElement,
    );

    const pending = provider.issueToken("kit_result").catch(() => undefined);
    await vi.waitFor(() => expect(releaseApi).toBeTypeOf("function"));
    provider.dispose();
    releaseApi?.(api);
    await pending;

    expect(api.render).not.toHaveBeenCalled();
  });
});
