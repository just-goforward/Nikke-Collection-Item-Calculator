import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { calculateIndependentApprovedPanel } from "../../certified-staging-approved-panel.ts";
import { fromWire, mapTriple, wire } from "../../certified-staging-oracle.ts";
import { independentPhysicalRecurringRates } from "../../certified-staging-oracle-physical-supply.ts";
import {
  GENERATION_SOURCES,
  PHYSICAL_CACHE,
  type PhysicalEvidence,
  validatePhysicalEvidence,
} from "./evidence.ts";
import { sourceIdentity } from "./history.ts";

/** Called through the real CLI's static import, only in its cache-empty child. */
export function calculateFresh() {
  const before = sourceIdentity(GENERATION_SOURCES);
  assert.equal(existsSync(PHYSICAL_CACHE), false, "Fresh enumeration requires an empty cache");
  const rates = independentPhysicalRecurringRates();
  const physical = JSON.parse(readFileSync(PHYSICAL_CACHE, "utf8")) as PhysicalEvidence;
  validatePhysicalEvidence(physical);
  assert.deepEqual(mapTriple(rates, wire), physical.rate);
  const rows = calculateIndependentApprovedPanel(
    mapTriple(physical.cohorts, (cohort) => mapTriple(cohort, fromWire)),
  );
  assert.equal(rows.length, 24);
  assert.deepEqual(sourceIdentity(GENERATION_SOURCES), before, "Isolated calculation source drift");
  writeFileSync("approved24.json", `${JSON.stringify(rows, null, 2)}\n`, { flag: "wx" });
  return { physicalComputeMs: physical.computeMs, cases: rows.length };
}
