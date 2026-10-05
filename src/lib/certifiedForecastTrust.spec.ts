import { describe, expect, it } from "vitest";
import { createCertifiedForecastIdentity } from "../../shared/certifiedForecastIdentity";
import { prepareCertifiedForecast } from "./certifiedForecast";
import {
  assertTrustedCertifiedForecast,
  trustedCertifiedForecastWorkspaceBound,
} from "./certifiedForecastTrust";

describe("shipped approved forecast anchor", () => {
  it("reconstructs the approved forecast independently at the submitted time", async () => {
    const snapshot = await prepareCertifiedForecast("2026-09-30T03:00:00.000Z");
    const accounting: number[] = [];
    const trusted = await assertTrustedCertifiedForecast(snapshot, (bytes) =>
      accounting.push(bytes),
    );
    expect(trusted).toEqual(await createCertifiedForecastIdentity(snapshot));
    expect(accounting).toEqual([trustedCertifiedForecastWorkspaceBound(snapshot), 0]);
  });

  it("rejects a self-consistent changed schedule retaining the declared source hash and revision", async () => {
    const snapshot = await prepareCertifiedForecast("2026-09-30T03:00:00.000Z");
    const forged = structuredClone(snapshot);
    const event = forged.events.find((candidate) => candidate.gameDate === "2026-10-01");
    if (!event) throw new Error("missing trusted future fixture");
    event.at = new Date(Date.parse(event.at) + 60_000).toISOString();
    expect(forged.sourceHash).toBe(snapshot.sourceHash);
    expect(forged.revision).toBe(snapshot.revision);
    expect(await createCertifiedForecastIdentity(forged)).not.toEqual(
      await createCertifiedForecastIdentity(snapshot),
    );
    await expect(assertTrustedCertifiedForecast(forged, () => {})).rejects.toThrow(
      "certified_forecast_not_approved",
    );
  });

  it("rejects a copied approval with changed provenance or coverage", async () => {
    const snapshot = await prepareCertifiedForecast("2026-09-30T03:00:00.000Z");
    for (const forged of [
      { ...snapshot, provenance: [...snapshot.provenance, "unreviewed_claim"] },
      {
        ...snapshot,
        coverage: {
          ...snapshot.coverage,
          past: {
            ...snapshot.coverage.past,
            missing: [...snapshot.coverage.past.missing, "unreviewed"],
          },
        },
      },
    ])
      await expect(assertTrustedCertifiedForecast(forged, () => {})).rejects.toThrow(
        "certified_forecast_not_approved",
      );
  });

  it("fails admission before rebuilding/hashing and releases reserved workspace on rejection", async () => {
    const snapshot = await prepareCertifiedForecast("2026-09-30T03:00:00.000Z");
    const accounting: number[] = [];
    await expect(
      assertTrustedCertifiedForecast(snapshot, (bytes) => {
        accounting.push(bytes);
        if (bytes) throw new Error("metadata_capacity_limit");
      }),
    ).rejects.toThrow("metadata_capacity_limit");
    expect(accounting).toEqual([trustedCertifiedForecastWorkspaceBound(snapshot), 0]);
  });
});
