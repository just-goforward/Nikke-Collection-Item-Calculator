import { expect, it } from "vitest";
import localPolicy from "../../shared/certifiedLocalPolicy.json";
import { q } from "../../shared/certifiedRational";
import {
  assertCertifiedRuntimeSupplySnapshot,
  certifiedCohortWeights,
} from "../../shared/certifiedSupply";
import registry from "../../shared/supplyForecasts.json";
import { prepareCertifiedForecast } from "./certifiedForecast";
import { prepareLocalCertifiedForecast } from "./certifiedLocalForecast";

it("uses the separately derived v5 local policy without retagging its historical evidence", async () => {
  const source = registry.forecasts.find((entry) => entry.id === "supply-2026-10-15-v3");
  const current = registry.forecasts.find((entry) => entry.id === registry.stagingForecastId);
  if (!source || !current) throw new Error("policy_registry_entries_missing");
  const original = assertCertifiedRuntimeSupplySnapshot(Reflect.get(source, "certifiedSnapshot"));
  const approved = await prepareCertifiedForecast(original.asOf);
  const derived = await prepareLocalCertifiedForecast(original.asOf);
  expect(current.id).toBe("supply-2026-10-15-v3");
  expect(registry.approvedForecastId).toBe(current.id);
  expect(registry.forecasts.some((entry) => entry.id === localPolicy.id)).toBe(false);
  expect(localPolicy.approved).toBe(false);
  expect(localPolicy.source.sourceForecastId).toBe(current.id);
  expect(original.version).toBe("certified-daily-v3");
  expect(derived.version).toBe("certified-daily-v5");
  expect(derived.sourceHash).toBe(original.sourceHash);
  expect(derived.revision).not.toBe(original.revision);
  expect(derived.rules).toEqual(original.rules);
  expect(derived.events).toEqual(original.events);
  expect(derived.soloRounds).toEqual(approved.soloRounds);
  expect(derived.cadence).toEqual(original.cadence);
  expect(derived.provenance).toContain("local-unapproved");
  const prepared = await prepareLocalCertifiedForecast(derived.asOf);
  expect(prepared.version).toBe("certified-daily-v5");
  expect(certifiedCohortWeights(undefined, prepared.version)).toEqual([q(1, 6), q(1, 3), q(1, 2)]);
  expect(certifiedCohortWeights(undefined, original.version)).toHaveLength(4);
});
