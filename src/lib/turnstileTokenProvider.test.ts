import { describe, expect, it, vi } from "vitest";

import { type TurnstileApi, TurnstileTokenProvider } from "./turnstileTokenProvider";

describe("TurnstileTokenProvider", () => {
  it("creates action-specific execute widgets and resets each completed attempt", async () => {
    const options = new Map<string, Record<string, unknown>>();
    const api: TurnstileApi = {
      render: vi.fn((_container, config) => {
        const id = `widget-${String(config.action)}`;
        options.set(id, config);
        return id;
      }),
      execute: vi.fn((id) => {
        const callback = options.get(id)?.callback as ((token: string) => void) | undefined;
        callback?.(`token-${id}`);
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

    expect(resultToken).toBe("token-widget-kit_result");
    expect(diagnosticToken).toBe("token-widget-solver_diagnostic");
    expect(api.render).toHaveBeenCalledTimes(2);
    expect(options.get("widget-kit_result")).toMatchObject({
      action: "kit_result",
      execution: "execute",
    });
    expect(options.get("widget-kit_result")).not.toHaveProperty("size");
    expect(options.get("widget-solver_diagnostic")).toMatchObject({
      action: "solver_diagnostic",
      execution: "execute",
    });
    expect(options.get("widget-solver_diagnostic")).not.toHaveProperty("size");
    expect(api.reset).toHaveBeenNthCalledWith(1, "widget-kit_result");
    expect(api.reset).toHaveBeenNthCalledWith(2, "widget-solver_diagnostic");
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
