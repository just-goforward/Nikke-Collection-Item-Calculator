import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACTIVE_SUPPLY_FORECAST,
  ACTIVE_SUPPLY_FORECAST_ID,
} from "../shared/generated/supplyForecast";

describe("frozen production forecast", () => {
  it("preserves the legacy solver's approved bundled constant", () => {
    expect(ACTIVE_SUPPLY_FORECAST_ID).toBe("supply-2026-08-21-v1");
    expect(ACTIVE_SUPPLY_FORECAST.profiles).toEqual([
      {
        id: "supply-2026-08-21-v1@fixed",
        effectiveFrom: "2026-08-21T00:00:00.000Z",
        effectiveUntil: null,
        scheduleStatus: "confirmed",
        expectedGain: { blue: 473.912, purple: 55.808, yellow: 24.736 },
      },
    ]);
  });

  it.each(["--add-v3-fallback", "--format-registry"])(
    "rejects registry mutation through %s",
    (flag) => {
      const before = readFileSync("shared/supplyForecasts.json");
      const result = spawnSync(process.execPath, ["scripts/supply-forecast-codegen.ts", flag], {
        encoding: "utf8",
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("supply_forecast_registry_frozen");
      expect(readFileSync("shared/supplyForecasts.json")).toEqual(before);
    },
  );
});
