import { statsRuntimeMode } from "./statsRuntime";

export type SolverBackend = "js-phase2" | "rust-min-ef";

export function solverBackendFromRuntime(): SolverBackend {
  if (typeof window === "undefined") return "js-phase2";
  const params = new URLSearchParams(window.location.search);
  if (statsRuntimeMode() !== "staging") return "js-phase2";
  return params.get("solverBackend") === "rust-min-ef" ? "rust-min-ef" : "js-phase2";
}

export function solverWasmUrl(): string {
  if (typeof document !== "undefined" && document.baseURI) {
    return new URL("solver_rs.wasm", document.baseURI).toString();
  }
  if (typeof window !== "undefined") {
    return new URL("solver_rs.wasm", window.location.href).toString();
  }
  return "solver_rs.wasm";
}
