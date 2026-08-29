import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createDynamicHpProfileMatrix,
  type Registry,
  writeDynamicHpProfileMatrix,
} from "./dynamic-hp-profile-matrix";
import { HP_CANDIDATES } from "./min-ef-hp-model";

const REGISTRY: Registry = {
  version: 2,
  approvedForecastId: "supply-2026-08-24-v1",
  forecasts: [
    {
      id: "supply-2026-08-24-v1",
      rulesVersion: "schedule-kit-v2",
      profiles: [
        {
          id: "supply-2026-08-24-v1@approved",
          effectiveFrom: "2026-08-24T00:00:00.000Z",
          effectiveUntil: null,
          scheduleStatus: "confirmed",
          expectedGain: { blue: 1, purple: 2, yellow: 3 },
        },
      ],
    },
  ],
};

describe("dynamic H/p profile matrix", () => {
  it("covers 21/28/35-day confirmed and estimated normal/day1/day2/day3 contexts", () => {
    const matrix = createDynamicHpProfileMatrix(REGISTRY, "off");

    expect(matrix).toHaveLength(25);
    expect(HP_CANDIDATES).toHaveLength(49);
    expect(matrix.filter((entry) => entry.cycleDays !== null)).toHaveLength(24);
    expect(new Set(matrix.map((entry) => entry.id)).size).toBe(matrix.length);
    for (const entry of matrix) {
      expect(Number.isFinite(entry.context.expectedGain.blue)).toBe(true);
      expect(Number.isFinite(entry.context.expectedGain.purple)).toBe(true);
      expect(Number.isFinite(entry.context.expectedGain.yellow)).toBe(true);
      expect(entry.evidenceProfiles).toHaveLength(1);
    }
  });

  it("evaluates identical gain vectors once while preserving every profile as evidence", () => {
    const forecast = REGISTRY.forecasts[0];
    const profile = forecast?.profiles[0];
    if (!forecast || !profile) throw new Error("fixture_forecast_missing");
    const registry: Registry = {
      ...REGISTRY,
      forecasts: [
        {
          ...forecast,
          profiles: [
            profile,
            {
              ...profile,
              id: "supply-2026-08-24-v1@duplicate-date",
              effectiveFrom: "2026-08-25T00:00:00.000Z",
            },
          ],
        },
      ],
    };
    const raw = createDynamicHpProfileMatrix(registry, "off");
    const deduplicated = createDynamicHpProfileMatrix(registry);
    const approvedGroup = deduplicated.find((entry) =>
      entry.evidenceProfiles.some((profile) =>
        profile.context.forecastProfileId.endsWith("@duplicate-date"),
      ),
    );

    expect(deduplicated.length).toBeLessThan(raw.length);
    expect(approvedGroup?.evidenceProfiles.map((profile) => profile.id)).toEqual([
      "approved-00",
      "approved-01",
    ]);
    expect(approvedGroup?.gainVectorSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(
      new Set(deduplicated.flatMap((entry) => entry.evidenceProfiles.map((profile) => profile.id)))
        .size,
    ).toBe(raw.length);
  });

  it("creates a missing results directory before writing the matrix", async () => {
    const root = await mkdtemp(join(tmpdir(), "dynamic-hp-matrix-"));
    const outputPath = join(root, "nested", "matrix.json");
    try {
      const matrix = await writeDynamicHpProfileMatrix(REGISTRY, pathToFileURL(outputPath), "off");
      expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(matrix);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
