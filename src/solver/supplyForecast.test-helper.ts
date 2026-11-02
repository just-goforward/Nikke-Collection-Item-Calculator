import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { ACTIVE_SUPPLY_FORECAST_BASE_PROFILE } from "../../shared/generated/supplyForecast";

/** Only Date is pinned: solver deadlines, timers and performance.now remain real. */
export function installSupplyForecastFixtureClock() {
  const pin = () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(ACTIVE_SUPPLY_FORECAST_BASE_PROFILE.effectiveFrom));
  };
  beforeAll(pin);
  beforeEach(pin);
  afterEach(() => vi.useRealTimers());
  afterAll(() => vi.useRealTimers());
}
