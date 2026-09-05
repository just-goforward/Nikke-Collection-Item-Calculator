import { afterEach, describe, expect, it, vi } from "vitest";

const EMPTY_WASM = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);

function wasmResponse(contentType = "application/wasm") {
  return new Response(EMPTY_WASM, { headers: { "Content-Type": contentType } });
}

describe("Rust WASM loader", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("uses one fetch when streaming instantiation succeeds", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(wasmResponse()));
    vi.stubGlobal("fetch", fetchMock);
    const { instantiateRustWasmFromUrl } = await import("./rustLoader");

    await expect(instantiateRustWasmFromUrl("/solver.wasm")).resolves.toBeInstanceOf(
      WebAssembly.Instance,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/solver.wasm");
  });

  it("performs a second fetch for the ArrayBuffer fallback", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(wasmResponse("application/octet-stream"))
      .mockResolvedValueOnce(wasmResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { instantiateRustWasmFromUrl } = await import("./rustLoader");

    await expect(instantiateRustWasmFromUrl("/solver.wasm")).resolves.toBeInstanceOf(
      WebAssembly.Instance,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/solver.wasm");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/solver.wasm");
  });

  it("keeps product and research instances in distinct sticky caches", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(wasmResponse()));
    vi.stubGlobal("fetch", fetchMock);
    const { getRustMinEfSolver, getRustPhase2Solver } = await import("./rustProductSolverCache");
    const { getRustPhase2ResearchSolver } = await import("./rustResearchSolverCache");

    const [minEf, phase2, research] = await Promise.all([
      getRustMinEfSolver("/solver.wasm"),
      getRustPhase2Solver("/solver.wasm"),
      getRustPhase2ResearchSolver("/solver.wasm"),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(minEf).not.toBe(phase2);
    expect(phase2).not.toBe(research);
    await expect(getRustMinEfSolver("/other.wasm")).resolves.toBe(minEf);
    await expect(getRustPhase2Solver("/other.wasm")).resolves.toBe(phase2);
    await expect(getRustPhase2ResearchSolver("/other.wasm")).resolves.toBe(research);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retains rejected promises independently in every solver cache", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(new Uint8Array())));
    vi.stubGlobal("fetch", fetchMock);
    const { getRustMinEfSolver, getRustPhase2Solver } = await import("./rustProductSolverCache");
    const { getRustPhase2ResearchSolver } = await import("./rustResearchSolverCache");
    const loadAll = () =>
      Promise.allSettled([
        getRustMinEfSolver("/solver.wasm"),
        getRustPhase2Solver("/solver.wasm"),
        getRustPhase2ResearchSolver("/solver.wasm"),
      ]);

    const first = await loadAll();
    expect(first.map(({ status }) => status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(fetchMock).toHaveBeenCalledTimes(6);

    const second = await loadAll();
    expect(second.map(({ status }) => status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});
