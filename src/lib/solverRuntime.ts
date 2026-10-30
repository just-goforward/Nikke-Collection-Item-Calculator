export type SolverBackend = "js-phase2" | "rust-phase2" | "rust-min-ef";

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
  return DEFAULT_SOLVER_BACKEND;
}

export function solverWasmUrl(): string {
  if (typeof document !== "undefined" && document.baseURI) {
    return new URL(LEGACY_WASM_ASSET.file, document.baseURI).toString();
  }
  if (typeof window !== "undefined") {
    return new URL(LEGACY_WASM_ASSET.file, window.location.href).toString();
  }
  return LEGACY_WASM_ASSET.file;
}

export function parallelValidationFromRuntime(): boolean {
  if (typeof window === "undefined") return false;
  const params = runtimeSearchParams();
  if (params.get("statsEnv") !== "staging" || params.get("parallelValidation") !== "1") {
    return false;
  }
  return window.matchMedia?.("(hover: hover) and (pointer: fine)").matches === true;
}
import { LEGACY_WASM_ASSET } from "../../shared/generated/wasmRuntimeAssets";

