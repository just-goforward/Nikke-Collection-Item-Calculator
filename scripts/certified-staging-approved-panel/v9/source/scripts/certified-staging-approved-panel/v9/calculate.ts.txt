import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CertifiedSupplySnapshot } from "../../../shared/certifiedSupply.ts";
import { mapTriple, wire } from "../../certified-staging-oracle.ts";
import { priceFourCohortSupply } from "../../certified-staging-oracle-four-cohort-pricing.ts";
import { sourceIdentity } from "../v6/history.ts";
import { calculatePanel } from "../v8/calculate.ts";
import { POPULATION, validateFourCohorts } from "../v8/evidence.ts";
import { independentFourCohorts } from "../v8/physical.ts";
import { GENERATION_SOURCES, PHYSICAL_VERSION } from "./evidence.ts";

/** Runs in a copied workspace without product modules; enumerates afresh. The v8
 * independent enumeration and Bellman/pricing panel calculation are reused unchanged. */
export function calculateFresh(snapshot: CertifiedSupplySnapshot) {
  const before = sourceIdentity(GENERATION_SOURCES);
  const started = performance.now();
  const cohorts = independentFourCohorts();
  const computeMs = performance.now() - started;
  const wireCohorts = [
    mapTriple(cohorts[0], wire),
    mapTriple(cohorts[1], wire),
    mapTriple(cohorts[2], wire),
    mapTriple(cohorts[3], wire),
  ] as const;
  validateFourCohorts(wireCohorts);
  const physical = {
    version: PHYSICAL_VERSION,
    generatedAt: new Date().toISOString(),
    computeMs,
    ...before,
    cohorts: wireCohorts,
    population: POPULATION.map(wire),
    rate: mapTriple(priceFourCohortSupply(snapshot, POPULATION, cohorts), wire),
  };
  const panel = calculatePanel(snapshot, cohorts);
  assert.deepEqual(sourceIdentity(GENERATION_SOURCES), before, "Generation source drift");
  return { physical, panel };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const snapshot = JSON.parse(
    readFileSync("snapshot-input.json", "utf8"),
  ) as CertifiedSupplySnapshot;
  console.log(JSON.stringify(calculateFresh(snapshot)));
}
