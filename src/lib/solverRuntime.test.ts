import { afterEach, describe, expect, it, vi } from "vitest";

import type { StatsConfig } from "../types";
import {
  solverBackendFromRuntime,
  solverBackendShouldFailLoud,
  solverWasmUrl,
} from "./solverRuntime";

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

  it("uses rust phase2 by default", () => {
    setRuntime("");

    expect(solverBackendFromRuntime()).toBe("rust-phase2");
    expect(solverBackendShouldFailLoud()).toBe(false);
  });

  it("allows explicitly opting out to the JS solver", () => {
    setRuntime("?solverBackend=js-phase2");

    expect(solverBackendFromRuntime()).toBe("js-phase2");
    expect(solverBackendShouldFailLoud()).toBe(false);
  });

  it("keeps rust min-E[f] research-only even in staging by using the default backend", () => {
    setRuntime("?statsEnv=staging&solverBackend=rust-min-ef");

    expect(solverBackendFromRuntime()).toBe("rust-phase2");
    expect(solverBackendShouldFailLoud()).toBe(false);
  });

  it("enables explicit rust phase2 in staging as fail-loud", () => {
    setRuntime("?statsEnv=staging&solverBackend=rust-phase2");

    expect(solverBackendFromRuntime()).toBe("rust-phase2");
    expect(solverBackendShouldFailLoud()).toBe(true);
  });

  it("enables rust phase2 rerank only for staging", () => {
    setRuntime("?statsEnv=staging&solverBackend=rust-phase2-rerank");

    expect(solverBackendFromRuntime()).toBe("rust-phase2-rerank");
    expect(solverBackendShouldFailLoud()).toBe(true);
  });

  it("does not enable rust phase2 rerank outside staging", () => {
    setRuntime("?solverBackend=rust-phase2-rerank");

    expect(solverBackendFromRuntime()).toBe("rust-phase2");
    expect(solverBackendShouldFailLoud()).toBe(false);
  });

  it("resolves the wasm URL relative to the current document", () => {
    setRuntime("?statsEnv=staging&solverBackend=rust-phase2", "https://example.test/path/");

    expect(solverWasmUrl()).toBe("https://example.test/path/solver_rs.wasm");
  });
});
