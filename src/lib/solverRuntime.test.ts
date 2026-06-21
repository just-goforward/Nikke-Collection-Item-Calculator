import { afterEach, describe, expect, it, vi } from "vitest";

import type { StatsConfig } from "../types";
import { solverBackendFromRuntime, solverWasmUrl } from "./solverRuntime";

const productionConfig: StatsConfig = {
  endpoint: "https://production.example.workers.dev/",
  turnstileSiteKey: "production-key",
  staging: {
    endpoint: "https://staging.example.workers.dev/",
    turnstileSiteKey: "staging-key",
  },
};

function setRuntime(search: string, href = "https://example.test/app/index.html") {
  vi.stubGlobal("window", {
    COLLECTION_STATS_CONFIG: productionConfig,
    location: { href, search },
  });
  vi.stubGlobal("document", {
    baseURI: href,
  });
}

describe("solver runtime selection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses rust min-E[f] by default", () => {
    setRuntime("");

    expect(solverBackendFromRuntime()).toBe("rust-min-ef");
  });

  it("allows explicitly opting out to the JS solver", () => {
    setRuntime("?solverBackend=js-phase2");

    expect(solverBackendFromRuntime()).toBe("js-phase2");
  });

  it("uses the production default solver in staging", () => {
    setRuntime("?statsEnv=staging");

    expect(solverBackendFromRuntime()).toBe("rust-min-ef");
  });

  it("applies the same explicit backend override in staging", () => {
    setRuntime("?statsEnv=staging&solverBackend=rust-phase2");

    expect(solverBackendFromRuntime()).toBe("rust-phase2");
  });

  it("ignores the removed rerank backend in staging", () => {
    setRuntime("?statsEnv=staging&solverBackend=rust-phase2-rerank");

    expect(solverBackendFromRuntime()).toBe("rust-min-ef");
  });

  it("does not enable rust phase2 rerank outside staging", () => {
    setRuntime("?solverBackend=rust-phase2-rerank");

    expect(solverBackendFromRuntime()).toBe("rust-min-ef");
  });

  it("allows explicit rust min-E[f] outside staging", () => {
    setRuntime("?solverBackend=rust-min-ef");

    expect(solverBackendFromRuntime()).toBe("rust-min-ef");
  });

  it("resolves the wasm URL relative to the current document", () => {
    setRuntime("?statsEnv=staging&solverBackend=rust-phase2", "https://example.test/path/");

    expect(solverWasmUrl()).toBe("https://example.test/path/solver_rs.wasm");
  });
});
