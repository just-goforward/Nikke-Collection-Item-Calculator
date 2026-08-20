import { afterEach, describe, expect, it, vi } from "vitest";

import { makeStatsSubmissionEnvelope } from "./statsSubmitClient";

describe("makeStatsSubmissionEnvelope", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("attaches the referrer host only to confirmed result events", () => {
    vi.stubGlobal("window", {
      crypto: {
        getRandomValues(values: Uint32Array) {
          values.set([1, 2]);
          return values;
        },
      },
      location: { host: "nikkecollection.com" },
    });
    vi.stubGlobal("document", { referrer: "https://search.example/results" });

    const resultEnvelope = makeStatsSubmissionEnvelope({ kind: "kit_result" });
    const diagnosticEnvelope = makeStatsSubmissionEnvelope({ kind: "solver_diagnostic" });

    expect(resultEnvelope).toMatchObject({ sourceHost: "search.example" });
    expect(diagnosticEnvelope).not.toHaveProperty("sourceHost");
    expect(resultEnvelope).not.toHaveProperty("clientTime");
    expect(diagnosticEnvelope).not.toHaveProperty("clientTime");
  });
});
