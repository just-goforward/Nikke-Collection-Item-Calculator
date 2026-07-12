import { afterEach, describe, expect, it, vi } from "vitest";

import type { StatsConfig } from "../types";
import { statsApiBase, statsRuntimeMode, statsSubmissionConfig } from "./statsRuntime";

const productionConfig: StatsConfig = {
  endpoint: "https://production.example.workers.dev/",
  turnstileSiteKey: "production-key",
};

function setRuntime(
  search: string,
  config: StatsConfig = productionConfig,
  hostname = "example.test",
) {
  vi.stubGlobal("window", {
    COLLECTION_STATS_CONFIG: config,
    location: { hostname, search },
  });
}

describe("stats runtime mode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses production endpoints by default and for unknown environments", () => {
    setRuntime("?statsEnv=preview");

    expect(statsRuntimeMode()).toBe("production");
    expect(statsApiBase()).toBe("https://production.example.workers.dev");
    expect(statsSubmissionConfig()).toEqual({
      endpoint: "https://production.example.workers.dev",
      turnstileSiteKey: "production-key",
    });
  });

  it("disables API reads and submissions by default on local preview origins", () => {
    setRuntime("", productionConfig, "127.0.0.1");

    expect(statsRuntimeMode()).toBe("disabled");
    expect(statsApiBase()).toBe("");
    expect(statsSubmissionConfig()).toBeNull();
  });

  it("disables API reads and submissions in demo mode, including when staging is requested", () => {
    setRuntime("?demoStats=1&statsEnv=staging", {
      ...productionConfig,
      staging: {
        endpoint: "https://staging.example.workers.dev",
        turnstileSiteKey: "staging-key",
      },
    });

    expect(statsRuntimeMode()).toBe("demo");
    expect(statsApiBase()).toBe("");
    expect(statsSubmissionConfig()).toBeNull();
  });

  it("disables API reads and submissions for automated non-statistics flows", () => {
    setRuntime("?statsEnv=disabled");

    expect(statsRuntimeMode()).toBe("disabled");
    expect(statsApiBase()).toBe("");
    expect(statsSubmissionConfig()).toBeNull();
  });

  it("uses staging endpoints only when the full staging configuration exists", () => {
    setRuntime("?statsEnv=staging", {
      ...productionConfig,
      staging: {
        endpoint: "https://staging.example.workers.dev/",
        turnstileSiteKey: "staging-key",
      },
    });

    expect(statsRuntimeMode()).toBe("staging");
    expect(statsApiBase()).toBe("https://staging.example.workers.dev");
    expect(statsSubmissionConfig()).toEqual({
      endpoint: "https://staging.example.workers.dev",
      turnstileSiteKey: "staging-key",
    });
  });

  it("fails closed when staging is requested without a complete configuration", () => {
    setRuntime("?statsEnv=staging", {
      ...productionConfig,
      staging: { endpoint: "https://staging.example.workers.dev" },
    });

    expect(statsRuntimeMode()).toBe("staging-misconfigured");
    expect(statsApiBase()).toBe("");
    expect(statsSubmissionConfig()).toBeNull();
  });
});
