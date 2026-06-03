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

  it("keeps the JS solver outside staging", () => {
    setRuntime("?solverBackend=rust-min-ef");

    expect(solverBackendFromRuntime()).toBe("js-phase2");
  });

  it("enables rust min-E[f] only for staging", () => {
    setRuntime("?statsEnv=staging&solverBackend=rust-min-ef");

    expect(solverBackendFromRuntime()).toBe("rust-min-ef");
  });

  it("resolves the wasm URL relative to the current document", () => {
    setRuntime("?statsEnv=staging&solverBackend=rust-min-ef", "https://example.test/path/");

    expect(solverWasmUrl()).toBe("https://example.test/path/solver_rs.wasm");
  });
});
