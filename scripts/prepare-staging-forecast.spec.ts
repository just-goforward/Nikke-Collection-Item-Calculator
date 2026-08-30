import { describe, expect, it } from "vitest";
import {
  activateForecastForStaging,
  selectForecastForStagingRuntime,
} from "./prepare-staging-forecast";

describe("staging forecast preparation", () => {
  it("activates only the approved schedule forecast in an ephemeral build registry", () => {
    const result = activateForecastForStaging(registry(), "supply-2026-08-28-v1");

    expect(result.activeForecastId).toBe("supply-2026-08-28-v1");
    expect(result.stagingForecastId).toBe("supply-2026-08-21-v1");
    expect(result.approvedForecastId).toBe("supply-2026-08-28-v1");
  });

  it("selects the approved forecast for query-driven staging without changing production", () => {
    const result = selectForecastForStagingRuntime(registry(), "supply-2026-08-28-v1");

    expect(result.activeForecastId).toBe("supply-2026-08-21-v1");
    expect(result.stagingForecastId).toBe("supply-2026-08-28-v1");
    expect(result.approvedForecastId).toBe("supply-2026-08-28-v1");
  });

  it("rejects production-active or unapproved staging targets", () => {
    expect(() => activateForecastForStaging(registry(), "supply-2026-08-21-v1")).toThrow(
      "only the inactive approved forecast",
    );
    expect(() =>
      activateForecastForStaging(
        { ...registry(), activeForecastId: "supply-2026-08-28-v1" },
        "supply-2026-08-28-v1",
      ),
    ).toThrow("already active in production");
  });
});

function registry() {
  return {
    version: 3,
    activeForecastId: "supply-2026-08-21-v1",
    stagingForecastId: "supply-2026-08-21-v1",
    approvedForecastId: "supply-2026-08-28-v1",
    forecasts: [
      {
        id: "supply-2026-08-21-v1",
        kind: "fixed",
        rulesVersion: "legacy-28-day-v1",
      },
      {
        id: "supply-2026-08-28-v1",
        kind: "schedule",
        rulesVersion: "schedule-kit-v2",
      },
    ],
  };
}
