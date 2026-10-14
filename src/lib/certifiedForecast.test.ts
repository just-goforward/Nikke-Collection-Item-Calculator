import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { certifiedForecastIdentityWorkspaceBound } from "../../shared/certifiedForecastIdentity";
import { CERTIFIED_FORECAST_SEED_PROVENANCE_HASH } from "../../shared/generated/certifiedEngineBuild";
import { SOLO_RAID_ROUND_HISTORY } from "../../shared/soloRaidCadence";
import registry from "../../shared/supplyForecasts.json";
import {
  certifiedForecastBuildWorkspaceBound,
  prepareCertifiedForecast,
} from "./certifiedForecast";

describe("approved forecast seed identity", () => {
  it("binds sourced raid and collaboration semantic periods and the raw-source manifest", async () => {
    const adopted = registry.forecasts.find((entry) => entry.id === registry.stagingForecastId);
    const snapshot = await prepareCertifiedForecast("2026-08-20T09:30:00+09:00");
    const fullApprovedRegistryHash = createHash("sha256")
      .update(readFileSync(new URL("../../shared/supplyForecasts.json", import.meta.url)))
      .digest("hex");
    const projection = Object.fromEntries(
      Object.entries(adopted ?? {}).filter(([key]) => key !== "profiles"),
    );
    const expected = createHash("sha256")
      .update(
        JSON.stringify({
          adopted: projection,
          fullApprovedRegistryHash,
          rounds: SOLO_RAID_ROUND_HISTORY,
          modelVersion: "documented-physical-supply-v2",
          soloPeriods: [
            {
              round: 40,
              effectiveFrom: "2026-08-20T03:00:00.000Z",
              effectiveUntil: "2026-08-26T19:59:00.000Z",
              scheduleStatus: "confirmed",
            },
          ],
          collaborationPeriods: [
            {
              effectiveFrom: "2026-08-19T20:00:00.000Z",
              effectiveUntil: "2026-09-09T19:59:00.000Z",
            },
          ],
          seedProvenanceHash: CERTIFIED_FORECAST_SEED_PROVENANCE_HASH,
        }),
      )
      .digest("hex");
    expect(snapshot.sourceHash).toBe(expected);
    expect(snapshot.version).toBe("certified-daily-v2");
    expect(certifiedForecastIdentityWorkspaceBound(snapshot)).toBeLessThan(
      certifiedForecastBuildWorkspaceBound(),
    );
    expect(snapshot.revision).toBe(`${adopted?.id}:${expected.slice(0, 16)}`);
    expect(snapshot.provenance).toContain(
      `official_source_manifest:${CERTIFIED_FORECAST_SEED_PROVENANCE_HASH}`,
    );
  });

  it("keeps source revision stable across view generation while semantic snapshots differ", async () => {
    const a = await prepareCertifiedForecast("2026-08-20T09:30:00+09:00");
    const b = await prepareCertifiedForecast("2026-08-21T09:30:00+09:00");
    expect(a.sourceHash).toBe(b.sourceHash);
    expect(a.revision).toBe(b.revision);
    expect(a.coverage.currentDay).not.toBe(b.coverage.currentDay);
  });
});
