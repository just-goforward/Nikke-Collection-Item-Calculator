import { describe, expect, it } from "vitest";
import { certifiedForecastIdentityWorkspaceBound } from "../../shared/certifiedForecastIdentity";
import { CERTIFIED_APPROVED_FORECAST } from "../../shared/generated/certifiedForecastAuthority";
import {
  certifiedForecastBuildWorkspaceBound,
  prepareCertifiedForecast,
} from "./certifiedForecast";

describe("bundled approved v3 authority", () => {
  it("uses the bundled ledger instead of reconstructing a new historical authority", async () => {
    expect(CERTIFIED_APPROVED_FORECAST.id).toBe("supply-2026-10-15-v3");
    expect(CERTIFIED_APPROVED_FORECAST.rulesVersion).toBe("schedule-kit-v3");
    const snapshot = await prepareCertifiedForecast("2026-10-15T05:00:00+09:00");
    const original = CERTIFIED_APPROVED_FORECAST.certifiedSnapshot;
    expect(snapshot.version).toBe("certified-daily-v3");
    expect(snapshot.revision).toBe(original.revision);
    expect(snapshot.sourceHash).toBe(original.sourceHash);
    expect(snapshot.events).toEqual(original.events);
    expect(snapshot.coverage.from).toBe(original.coverage.from);
    expect(snapshot.coverage.past.complete).toBe(false);
    expect(certifiedForecastIdentityWorkspaceBound(snapshot)).toBeLessThan(
      certifiedForecastBuildWorkspaceBound(),
    );
  });

  it("retains source identity across views without extending the approved authority", async () => {
    const a = await prepareCertifiedForecast("2026-10-15T05:00:00+09:00");
    const b = await prepareCertifiedForecast("2027-01-01T05:00:00+09:00");
    expect(a.sourceHash).toBe(b.sourceHash);
    expect(a.revision).toBe(b.revision);
    expect(a.events).toEqual(b.events);
    expect(b.coverage.future.complete).toBe(false);
    expect(b.coverage.future.missing).toContain("authority_coverage");
  });
});
