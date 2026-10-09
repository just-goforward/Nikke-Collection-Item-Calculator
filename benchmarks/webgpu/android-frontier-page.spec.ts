import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../compact-exact-graph");
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("Android frontier failure reporting", () => {
  it.each([
    ["device_unavailable: no adapter", "device_unavailable"],
    ["device_lost: reset", "device_lost"],
    ["device_unavailable device_lost", "device_lost"],
    ["unexpected failure", "failure"],
    [17, "failure"],
  ])("classifies %s without running a graph or GPU collection", async (error, outcome) => {
    vi.doMock("../compact-exact-graph", async () => {
      const actual =
        await vi.importActual<typeof import("../compact-exact-graph")>("../compact-exact-graph");
      return {
        ...actual,
        buildCompactStateGraph: () => {
          throw error;
        },
      };
    });
    const body = { dataset: {} as Record<string, string>, textContent: null as string | null };
    const fetchMock = vi.fn().mockResolvedValue(new Response());
    vi.stubGlobal("document", { body });
    vi.stubGlobal("fetch", fetchMock);

    await import("./android-frontier-page");

    const report = { outcome, error: String(error) };
    expect(body.dataset).toEqual({ outcome });
    expect(body.textContent).toBe(JSON.stringify(report, null, 2));
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/__webgpu_result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
  });

  it.each([true, false])("preserves the Error stack preference: %s", async (hasStack) => {
    const error = new Error("device_unavailable: message");
    if (hasStack) error.stack = "device_lost: fixed stack";
    else delete error.stack;
    vi.doMock("../compact-exact-graph", async () => ({
      ...(await vi.importActual<typeof import("../compact-exact-graph")>("../compact-exact-graph")),
      buildCompactStateGraph: () => {
        throw error;
      },
    }));
    const body = { dataset: {} as Record<string, string>, textContent: null as string | null };
    vi.stubGlobal("document", { body });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response()));

    await import("./android-frontier-page");

    expect(body.textContent).toBe(
      JSON.stringify(
        {
          outcome: hasStack ? "device_lost" : "device_unavailable",
          error: hasStack ? "device_lost: fixed stack" : "device_unavailable: message",
        },
        null,
        2,
      ),
    );
  });
});
