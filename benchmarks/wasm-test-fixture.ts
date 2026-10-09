import { vi } from "vitest";

const wasmBytesApi: {
  instantiate: (
    bytes: BufferSource,
    imports?: WebAssembly.Imports,
  ) => Promise<WebAssembly.WebAssemblyInstantiatedSource>;
} = WebAssembly;

export function mockWasmInstantiation(exports: WebAssembly.Exports = {}) {
  return vi.spyOn(wasmBytesApi, "instantiate").mockResolvedValue({
    instance: { exports },
    module: {},
  });
}
