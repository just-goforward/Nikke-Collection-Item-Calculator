import { statsRuntimeMode } from "./statsRuntime";

export type SolverBackend = "js-phase2" | "rust-phase2" | "rust-phase2-rerank" | "rust-min-ef";

const DEFAULT_SOLVER_BACKEND: SolverBackend = "rust-min-ef";

function runtimeSearchParams() {
  if (typeof window === "undefined") return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}

export function solverBackendFromRuntime(): SolverBackend {
  if (typeof window === "undefined") return "js-phase2";
  const params = runtimeSearchParams();
  const backend = params.get("solverBackend");
  if (backend === "js-phase2") return "js-phase2";
  if (backend === "rust-phase2") return "rust-phase2";
  if (backend === "rust-min-ef") return "rust-min-ef";
  if (statsRuntimeMode() === "staging" && backend === "rust-phase2-rerank") {
    return "rust-phase2-rerank";
  }
  return DEFAULT_SOLVER_BACKEND;
}

export function solverBackendShouldFailLoud(): boolean {
  if (typeof window === "undefined") return false;
  if (statsRuntimeMode() !== "staging") return false;
  const backend = runtimeSearchParams().get("solverBackend");
  return backend === "rust-phase2" || backend === "rust-phase2-rerank" || backend === "rust-min-ef";
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
