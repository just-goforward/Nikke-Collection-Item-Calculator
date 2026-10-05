import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ForecastReviewStatus,
  parseForecastReviewStatus,
  watchForecastReviewStatus,
} from "./forecastReviewStatus";

const changed = { source: "official", itemId: "notice-1", generation: 2, errorCode: null };
const current = { sourceReview: { state: "current", changedSources: [] } };
const pending = { sourceReview: { state: "review_pending", changedSources: [changed] } };

function response(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function visibility() {
  const target = new EventTarget();
  return Object.assign(target, {
    visibilityState: "visible" as DocumentVisibilityState,
    emit(state: DocumentVisibilityState = "visible") {
      this.visibilityState = state;
      target.dispatchEvent(new Event("visibilitychange"));
    },
  });
}

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

describe("public source review metadata boundary", () => {
  it("extracts only advisory status and never accepts candidate data as a forecast", () => {
    const input = Object.freeze({ ...pending, certifiedSnapshot: { revision: "unapproved" } });
    expect(parseForecastReviewStatus(input)).toBe("review_pending");
    expect(input.certifiedSnapshot.revision).toBe("unapproved");
    expect(parseForecastReviewStatus(current)).toBe("current");
  });

  it.each([
    null,
    { sourceReview: { state: "adopted", changedSources: [] } },
    { sourceReview: { state: "current", changedSources: [changed] } },
    { sourceReview: { state: "review_pending", changedSources: [] } },
    { sourceReview: { state: "review_pending", changedSources: Array(21).fill(changed) } },
    { sourceReview: { state: "review_pending", changedSources: [{ ...changed, generation: -1 }] } },
    {
      sourceReview: { state: "review_pending", changedSources: [{ ...changed, generation: 1.5 }] },
    },
    { sourceReview: { state: "review_pending", changedSources: [{ ...changed, itemId: "" }] } },
    { sourceReview: { state: "review_pending", changedSources: [{ ...changed, errorCode: {} }] } },
    { sourceReview: { state: "review_pending", changedSources: [null] } },
  ])("rejects malformed or contradictory health metadata %#", (input) => {
    expect(() => parseForecastReviewStatus(input)).toThrow();
  });
});

function noticeLifecycle() {
  const cleanups: (() => void)[] = [];
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    for (const dispose of cleanups.splice(0)) dispose();
    vi.useRealTimers();
  });

  return function watch(fetcher: typeof fetch) {
    const source = visibility();
    const statuses: ForecastReviewStatus[] = [];
    const dispose = watchForecastReviewStatus({
      fetch: fetcher,
      visibility: source,
      onStatus: (status) => statuses.push(status),
    });
    cleanups.push(dispose);
    return { source, statuses, dispose };
  };
}

describe("read-only review notice refresh", () => {
  const watch = noticeLifecycle();

  it("reports shared processing uncertainty without inventing a changed notice or replacing the approved forecast", async () => {
    const payload = {
      ...current,
      sourceReview: { ...current.sourceReview, processingBlocked: true },
      certifiedSnapshot: { revision: "unapproved" },
    };
    const { statuses } = watch(vi.fn<typeof fetch>().mockResolvedValue(response(payload)));
    await settle();
    expect(statuses).toEqual(["unknown"]);
    expect(payload.certifiedSnapshot.revision).toBe("unapproved");
    expect(
      parseForecastReviewStatus({
        sourceReview: { ...current.sourceReview, processingBlocked: false },
      }),
    ).toBe("current");
  });

  it("uses the approved public endpoint with no credentials, bodies, or admin headers", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(pending));
    const { statuses } = watch(fetcher);
    await settle();
    expect(statuses).toEqual(["review_pending"]);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://collection-kit-forecast-collector-staging.tbvj159.workers.dev/health",
    );
    expect(fetcher.mock.calls[0]?.[1]).toEqual({
      method: "GET",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds repeated visibility events and performs no periodic polling", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(current));
    const { source } = watch(fetcher);
    for (let i = 0; i < 100; i++) source.emit();
    await settle();
    for (let i = 0; i < 100; i++) source.emit();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    source.emit("hidden");
    expect(fetcher).toHaveBeenCalledTimes(1);
    source.emit();
    for (let i = 0; i < 100; i++) source.emit();
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("backs off failures, reports unknown after pending, and clears warnings only on validated recovery", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(pending))
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(response(current));
    const { source, statuses } = watch(fetcher);
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    source.emit();
    await settle();
    expect(statuses).toEqual(["review_pending", "unknown"]);
    await vi.advanceTimersByTimeAsync(119_999);
    source.emit();
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    source.emit();
    await settle();
    expect(statuses).toEqual(["review_pending", "unknown", "current"]);
  });
});

describe("read-only review notice cancellation", () => {
  const watch = noticeLifecycle();

  it("aborts a hung request at five seconds and ignores a late response even when fetch ignores abort", async () => {
    let resolveLate: (value: Response) => void = () => undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveLate = resolve;
        }),
    );
    const { source, statuses } = watch(fetcher);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(statuses).toEqual(["unknown"]);
    resolveLate(response(current));
    await settle();
    source.emit();
    expect(statuses).toEqual(["unknown"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposal cancels active work, removes visibility subscription and suppresses late updates", async () => {
    let resolveLate: (value: Response) => void = () => undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveLate = resolve;
        }),
    );
    const { source, statuses, dispose } = watch(fetcher);
    dispose();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    resolveLate(response(pending));
    await vi.advanceTimersByTimeAsync(3_600_000);
    source.emit();
    expect(statuses).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("removes its abort listener after both success and timeout", async () => {
    const cleanups: ReturnType<typeof vi.spyOn>[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      if (!options?.signal) throw new Error("missing_abort_signal");
      cleanups.push(vi.spyOn(options.signal, "removeEventListener"));
      if (cleanups.length === 1) return response(current);
      return new Promise<Response>(() => undefined);
    });
    const { source } = watch(fetcher);
    await settle();
    expect(cleanups[0]).toHaveBeenCalledWith("abort", expect.any(Function));
    await vi.advanceTimersByTimeAsync(60_000);
    source.emit();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(cleanups[1]).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("read-only review notice failure boundaries", () => {
  const watch = noticeLifecycle();

  it("cancels an oversized chunked body without buffering the entire response", async () => {
    const cancel = vi.fn();
    const bytes = new TextEncoder().encode("x".repeat(40 * 1024));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(bytes);
      },
      cancel,
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(body, { headers: { "content-type": "application/json" } }));
    const { statuses } = watch(fetcher);
    await settle();
    expect(cancel).toHaveBeenCalledWith("review_health_size_limit");
    expect(statuses).toEqual(["unknown"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds repeated failures at a fifteen minute backoff", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    const { source } = watch(fetcher);
    await settle();
    for (const delay of [120_000, 240_000, 480_000, 900_000]) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      source.emit();
      await settle();
      const count = fetcher.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1);
      source.emit();
      await settle();
      expect(fetcher).toHaveBeenCalledTimes(count + 1);
    }
    await vi.advanceTimersByTimeAsync(899_999);
    source.emit();
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it.each([
    () => new Response("unavailable", { status: 503 }),
    () => new Response("{}", { headers: { "content-type": "text/html" } }),
    () => response({ sourceReview: { state: "adopted", changedSources: [] } }),
    () => new Response("{", { headers: { "content-type": "application/json" } }),
    () => response({ padding: "x".repeat(65_536), ...current }),
  ])(
    "reports unknown instead of trusting failed, malformed, or oversized replies %#",
    async (reply) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply());
      const { statuses } = watch(fetcher);
      await settle();
      expect(statuses).toEqual(["unknown"]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
