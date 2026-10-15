import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CertifiedSupplySnapshot } from "../../../shared/certifiedSupply.ts";
import {
  calculateIndependentApprovedPanel,
  independentApprovedPricing,
} from "../../certified-staging-approved-panel.ts";
import { fromWire, mapTriple, type QTriple, q, wire } from "../../certified-staging-oracle.ts";
import { independentDispatchExpectations } from "../../certified-staging-oracle-physical-supply.ts";
import { normalizeExact, PHYSICAL_CACHE } from "../v6/evidence.ts";
import { sourceIdentity } from "../v6/history.ts";
import { GENERATION_SOURCES, PHYSICAL_VERSION } from "./evidence.ts";
import { readHistoricalPublication } from "./history.ts";

/** Preserve the approved24 population, embedding its three priors in v2 with
 * an explicit zero fourth prior. This is not new coverage of positive cohort 3.
 * Every current objective/action/gap is recomputed by the independent Bellman
 * oracle. The exact price equality below proves that the embedding preserves
 * those objectives, rather than copying expectations from a shipped solver. */
export function calculatePanel(
  snapshot: CertifiedSupplySnapshot,
  cohorts: readonly [QTriple, QTriple, QTriple],
) {
  assert.equal(snapshot.version, "certified-daily-v2");
  assert.equal(snapshot.rules[0]?.id, "schedule-kit-v2:documented-physical-supply-v2");
  assert.ok(snapshot.laws.every((law) => law.modelVersion === "documented-physical-supply-v2"));
  const receivedEventIds = snapshot.events
    .filter(
      (event) =>
        event.gameDate === snapshot.coverage.currentDay &&
        Date.parse(event.at) <= Date.parse(snapshot.asOf),
    )
    .map((event) => event.id);
  return calculateIndependentApprovedPanel(cohorts).map((row) => {
    assert.equal(row.input.asOf, snapshot.asOf);
    assert.deepEqual(
      mapTriple(
        independentApprovedPricing(snapshot, mapTriple(row.expected.cohortWeights, fromWire)),
        wire,
      ),
      row.expected.rates,
      "The v2 embedding must preserve the independently calculated prices",
    );
    const cohortWeights = [...row.expected.cohortWeights, wire(q(0))] as const;
    return {
      ...row,
      input: { ...row.input, cohortWeights, receivedEventIds },
      expected: { ...row.expected, cohortWeights },
    };
  });
}

/** This entry point runs in a copied, cache-empty workspace without product
 * modules. It enumerates ordered physical draws afresh; no ignored cache is read. */
export function calculateFresh(snapshot: CertifiedSupplySnapshot) {
  assert.equal(existsSync(PHYSICAL_CACHE), false, "Fresh enumeration requires an empty cache");
  const before = sourceIdentity(GENERATION_SOURCES);
  const historical = readHistoricalPublication();
  const started = performance.now();
  const cohorts = independentDispatchExpectations();
  assert.deepEqual(
    normalizeExact(mapTriple(cohorts, (row) => mapTriple(row, wire))),
    normalizeExact(historical.physical.cohorts),
  );
  const physical = {
    version: PHYSICAL_VERSION,
    generatedAt: new Date().toISOString(),
    computeMs: performance.now() - started,
    ...before,
    cohorts: mapTriple(cohorts, (row) => mapTriple(row, wire)),
    rate: mapTriple(independentApprovedPricing(snapshot, [q(1, 3), q(1, 3), q(1, 3)]), wire),
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
