import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerResponse } from "../shared/workerProtocol";

const mocks = vi.hoisted(() => ({
  minEf: vi.fn(),
  phase2: vi.fn(),
}));

vi.mock("./wasm/rustMinEfSolver", () => ({ solveRustMinEf: mocks.minEf }));
vi.mock("./wasm/rustPhase2ProductSolver", () => ({ solveRustPhase2: mocks.phase2 }));
vi.mock("./lib/supplyForecastRuntime", () => ({
  prepareRuntimeSupplyForecast: async () => undefined,
}));

const input = {
  start: { grade: "SR", level: 1, exp: 0 },
  stock: { blue: 10, purple: 20, yellow: 30 },
  strategy: "supply",
};

async function worker() {
  const messages: WorkerResponse[] = [];
  const target = {
    postMessage: (message: WorkerResponse) => messages.push(message),
    onmessage: null as ((event: MessageEvent) => Promise<void>) | null,
  };
  vi.stubGlobal("self", target);
  await import("./worker");
  const dispatch = target.onmessage;
  if (!dispatch) throw new Error("Worker did not install its message handler.");
  return {
    messages,
    dispatch: (data: unknown) => dispatch(new MessageEvent("message", { data })),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  mocks.minEf.mockReset();
  mocks.phase2.mockReset();
});

describe("queued Rust worker solve dispatch", () => {
  it("reads phase2 options only after the preceding task and queued-start progress", async () => {
    const protocol = await import("../shared/workerProtocol");
    const parse = vi.spyOn(protocol, "parseWorkerRequest");
    let finishFirst: (result: unknown) => void = () => {
      throw new Error("First task was not initialized.");
    };
    const first = new Promise((resolve) => {
      finishFirst = resolve;
    });
    mocks.minEf.mockReturnValue(first);
    mocks.phase2.mockResolvedValue({ arm: "phase2" });
    const { messages, dispatch } = await worker();
    const firstRun = dispatch({
      type: "solve",
      id: 1,
      input,
      backend: "rust-min-ef",
      wasmUrl: "/solver.wasm",
    });
    await vi.waitFor(() => expect(mocks.minEf).toHaveBeenCalledOnce());
    const secondRun = dispatch({
      type: "solve",
      id: 2,
      input,
      backend: "rust-phase2",
      wasmUrl: "/solver.wasm",
      phase2MemoTier: 20,
      phase2RetryOnMemoFull: true,
    });
    const parsed = parse.mock.results[1]?.value;
    if (!parsed?.success || parsed.data.type !== "solve") {
      throw new Error("Expected a parsed second solve request.");
    }
    let reads = 0;
    Object.defineProperty(parsed.data, "phase2MemoTier", {
      get() {
        expect(messages).toContainEqual({
          type: "progress",
          id: 2,
          progress: { phase: "worker-started", queueWaitMs: expect.any(Number) },
        });
        reads += 1;
        return 22;
      },
    });
    parsed.data.phase2RetryOnMemoFull = false;
    await Promise.resolve();
    expect(reads).toBe(0);
    expect(mocks.phase2).not.toHaveBeenCalled();

    finishFirst({ arm: "min-ef" });
    await Promise.all([firstRun, secondRun]);

    expect(reads).toBe(2);
    expect(mocks.minEf).toHaveBeenCalledExactlyOnceWith(
      input,
      "/solver.wasm",
      expect.any(Function),
    );
    expect(mocks.phase2).toHaveBeenCalledExactlyOnceWith(
      input,
      "/solver.wasm",
      expect.any(Function),
      { initialMemoTier: 22, retryOnMemoFull: false },
    );
    expect(messages.filter((message) => message.type === "result")).toEqual([
      {
        type: "result",
        id: 1,
        result: { arm: "min-ef" },
        timing: { queueWaitMs: expect.any(Number), executionMs: expect.any(Number) },
      },
      {
        type: "result",
        id: 2,
        result: { arm: "phase2" },
        timing: { queueWaitMs: expect.any(Number), executionMs: expect.any(Number) },
      },
    ]);
  });

  it("omits absent phase2 overrides", async () => {
    mocks.phase2.mockResolvedValue({ possible: true });
    const { dispatch } = await worker();
    await dispatch({
      type: "solve",
      id: 1,
      input,
      backend: "rust-phase2",
      wasmUrl: "/solver.wasm",
    });
    expect(mocks.phase2).toHaveBeenCalledExactlyOnceWith(
      input,
      "/solver.wasm",
      expect.any(Function),
      {},
    );
  });

  it("preserves typed solve errors and runs the following queued task", async () => {
    const { messages, dispatch } = await worker();
    const { RustSolveError, RUST_STATUS_MEMO_FULL } = await import("./wasm/rustStatus");
    mocks.minEf.mockRejectedValue(
      new RustSolveError("root solve", RUST_STATUS_MEMO_FULL, "status", 123),
    );
    mocks.phase2.mockResolvedValue({ recovered: true });
    await Promise.all([
      dispatch({ type: "solve", id: 1, input, backend: "rust-min-ef", wasmUrl: "/solver.wasm" }),
      dispatch({ type: "solve", id: 2, input, backend: "rust-phase2", wasmUrl: "/solver.wasm" }),
    ]);
    expect(messages).toContainEqual({
      type: "error",
      id: 1,
      code: "memo_full",
      fallbackEligible: true,
      message: "Rust solver root solve failed with status memo_full.",
      nodeCount: 123,
      retryable: true,
    });
    expect(messages).toContainEqual({
      type: "result",
      id: 2,
      result: { recovered: true },
      timing: { queueWaitMs: expect.any(Number), executionMs: expect.any(Number) },
    });
  });
});
