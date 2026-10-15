import assert from "node:assert/strict";
import type { CertifiedSupplySnapshot } from "../../../shared/certifiedSupply.ts";
import { fromWire, mapTriple, q, wire } from "../../certified-staging-oracle.ts";
import {
  independentFourthCohort,
  priceFourCohortSupply,
} from "../../certified-staging-oracle-four-cohort-pricing.ts";
import { normalizeExact, validateGenerationEnvironment } from "../v6/evidence.ts";
import { pinnedBytes, type SourceIdentity, sha256, sourceIdentity } from "../v6/history.ts";
import {
  EVIDENCE_FILES as HISTORICAL_EVIDENCE_FILES,
  readV7Evidence,
  V7_PINS_SHA,
} from "../v7/evidence.ts";
import { readHistoricalPublication } from "../v7/history.ts";
import { V8_PINS_SHA } from "./anchor.ts";
import type { FourCohorts } from "./physical.ts";

export const V8_ROOT = "scripts/certified-staging-approved-panel/v8";
export const EVIDENCE_VERSION = "approved24-independent-evidence-v8";
export const PHYSICAL_VERSION = "independent-four-cohort-physical-supply-rates-v8";
export const SNAPSHOT_VERSION = "certified-daily-v3";
export const RULE_ID = "schedule-kit-v3:documented-physical-supply-v2";
export const LAW_VERSION = "documented-physical-supply-v2";
export const WEEKLY_LAW_ID = "deterministic:10,10,0";
export const COHORT_MIGRATION = "four-prior-positive-cohort3-population-v3";
export const PUBLICATION_FILES = [
  "snapshot.json",
  "independent-physical-cohorts.json",
  "panel.json",
  "provenance.json",
  "pins.json",
].map((name) => `${V8_ROOT}/${name}`);
/** Runtime closure of the isolated calculator plus the v8 harness itself. */
export const GENERATION_SOURCES = [
  "scripts/certified-staging-oracle.ts",
  "shared/game.ts",
  "scripts/certified-staging-oracle-tuples.ts",
  "scripts/certified-staging-oracle-fixtures.ts",
  "scripts/certified-staging-approved-panel.ts",
  "scripts/certified-staging-oracle-four-cohort-pricing.ts",
  "scripts/certified-staging-oracle-fixtures/cohort3-dispatch-v1.json",
  "scripts/certified-staging-approved-panel/v6/evidence.ts",
  "scripts/certified-staging-approved-panel/v6/history.ts",
  "scripts/certified-staging-approved-panel/v7/evidence.ts",
  "scripts/certified-staging-approved-panel/v7/history.ts",
  ...["physical.ts", "evidence.ts", "calculate.ts", "panel.ts", "snapshot.ts", "generate.ts"].map(
    (name) => `${V8_ROOT}/${name}`,
  ),
];
export const ANCHOR_FILE = `${V8_ROOT}/anchor.ts`;
export const EVIDENCE_FILES = [
  ...new Set([
    ...HISTORICAL_EVIDENCE_FILES,
    ...GENERATION_SOURCES,
    ANCHOR_FILE,
    ...PUBLICATION_FILES,
  ]),
];
type Wire = ReturnType<typeof wire>;
type WireTriple = readonly [Wire, Wire, Wire];
export type PhysicalEvidenceV8 = {
  version: string;
  generatedAt: string;
  computeMs: number;
  sources: SourceIdentity[];
  sourceHash: string;
  cohorts: readonly [WireTriple, WireTriple, WireTriple, WireTriple];
  population: readonly [Wire, Wire, Wire, Wire];
  rate: WireTriple;
};
export type EvidenceProvenance = {
  version: string;
  generationEnvironment: {
    nodeVersion: string;
    packageLockSha256: string;
    biomeSha256: string;
  };
  generation: ReturnType<typeof sourceIdentity> & {
    isolatedCacheEmpty: true;
    physicalEnumeration: "sequential-draw-state-merged";
    oracleRows: 24;
    independentWaiting: "UNVERIFIED_NOT_REGENERATED";
  };
  historical: { v7PinsSha256: string; cohortMigration: typeof COHORT_MIGRATION };
  snapshot: SourceIdentity & {
    meaning: "approved forecast input only; not an expected solver output";
    sources: SourceIdentity[];
  };
  physicalEnumeration: SourceIdentity;
  panel: SourceIdentity;
};

/** Public v3 population mix over 0..3 rerolls. */
export const POPULATION = [q(1, 7), q(2, 7), q(3, 7), q(1, 7)] as const;
export function cohortsFromWire(cohorts: PhysicalEvidenceV8["cohorts"]): FourCohorts {
  const [c0, c1, c2, c3] = cohorts.map((triple) => mapTriple(triple, fromWire));
  assert.ok(c0 && c1 && c2 && c3 && cohorts.length === 4);
  return [c0, c1, c2, c3];
}

/** Public v3 contract checks on the approved INPUT; nothing here is an expectation. */
export function assertV3Snapshot(snapshot: CertifiedSupplySnapshot) {
  assert.equal(snapshot.version, SNAPSHOT_VERSION);
  assert.equal(snapshot.rules.length, 1);
  assert.equal(snapshot.rules[0]?.id, RULE_ID);
  assert.deepEqual(snapshot.rules[0]?.weeklyFixed, [{ lawId: WEEKLY_LAW_ID, count: 1 }]);
  assert.ok(snapshot.laws.length > 0);
  for (const law of snapshot.laws) {
    assert.notEqual(law.kind, "finite", "v3 forbids finite laws");
    assert.equal(law.modelVersion, LAW_VERSION);
  }
  const weekly = snapshot.events.filter((event) => event.kind === "weekly-kits");
  assert.ok(weekly.length > 0);
  for (const event of weekly) {
    // Wednesday 05:00 KST is Tuesday 20:00 UTC.
    const at = new Date(event.at);
    assert.equal(at.getUTCDay(), 2);
    assert.equal(at.getUTCHours(), 20);
    assert.equal(at.getUTCMinutes(), 0);
    assert.deepEqual(event.refs, [{ lawId: WEEKLY_LAW_ID, count: 1 }]);
  }
}

export function receivedEventIds(snapshot: CertifiedSupplySnapshot) {
  return snapshot.events
    .filter(
      (event) =>
        event.gameDate === snapshot.coverage.currentDay &&
        Date.parse(event.at) <= Date.parse(snapshot.asOf),
    )
    .map((event) => event.id);
}

/** Exact cross-algorithm agreement: cohorts 0..2 equal the sealed v6 ordered-draw
 * enumeration and cohort 3 equals the separately pinned prototype artifact. */
export function validateFourCohorts(cohorts: PhysicalEvidenceV8["cohorts"], root = process.cwd()) {
  assert.equal(cohorts.length, 4);
  for (const triple of cohorts) {
    assert.equal(triple.length, 3);
    for (const value of triple) {
      const exact = fromWire(value);
      assert.ok(exact.n >= 0n && exact.d > 0n);
      assert.deepEqual(wire(exact), value, "Independent physical exact identity drift");
    }
  }
  const historical = readHistoricalPublication(root);
  assert.deepEqual(
    normalizeExact(cohorts.slice(0, 3)),
    normalizeExact(historical.physical.cohorts),
    "Four-cohort enumeration disagrees with sealed v6 cohorts",
  );
  assert.deepEqual(
    normalizeExact(cohorts[3]),
    normalizeExact(independentFourthCohort().map(wire)),
    "Cohort 3 disagrees with the pinned prototype artifact",
  );
}

/** `pinsSha` defaults to the reviewed tracked anchor; disposable publications pass
 * the digest of the pins they just generated. */
export function readV8Evidence(root = process.cwd(), pinsSha = V8_PINS_SHA) {
  const pins = JSON.parse(
    pinnedBytes({ path: `${V8_ROOT}/pins.json`, sha256: pinsSha }, root).toString(),
  ) as {
    version: string;
    provenance: SourceIdentity;
  };
  assert.equal(pins.version, EVIDENCE_VERSION);
  assert.equal(pins.provenance.path, `${V8_ROOT}/provenance.json`);
  const provenance = JSON.parse(
    pinnedBytes(pins.provenance, root).toString(),
  ) as EvidenceProvenance;
  assert.equal(provenance.version, EVIDENCE_VERSION);
  validateGenerationEnvironment(provenance.generationEnvironment);
  assert.deepEqual(provenance.historical, {
    v7PinsSha256: V7_PINS_SHA,
    cohortMigration: COHORT_MIGRATION,
  });
  readV7Evidence(root);
  assert.deepEqual(provenance.generation, {
    ...sourceIdentity(GENERATION_SOURCES, root),
    isolatedCacheEmpty: true,
    physicalEnumeration: "sequential-draw-state-merged",
    oracleRows: 24,
    independentWaiting: "UNVERIFIED_NOT_REGENERATED",
  });
  assert.equal(provenance.snapshot.path, `${V8_ROOT}/snapshot.json`);
  assert.equal(
    provenance.snapshot.meaning,
    "approved forecast input only; not an expected solver output",
  );
  assert.ok(provenance.snapshot.sources.length > 0);
  for (const source of provenance.snapshot.sources) pinnedBytes(source, root);
  const snapshot = JSON.parse(
    pinnedBytes(provenance.snapshot, root).toString(),
  ) as CertifiedSupplySnapshot;
  assertV3Snapshot(snapshot);
  assert.equal(provenance.physicalEnumeration.path, `${V8_ROOT}/independent-physical-cohorts.json`);
  const physical = JSON.parse(
    pinnedBytes(provenance.physicalEnumeration, root).toString(),
  ) as PhysicalEvidenceV8;
  assert.equal(physical.version, PHYSICAL_VERSION);
  assert.deepEqual(physical.sources, provenance.generation.sources);
  assert.equal(physical.sourceHash, provenance.generation.sourceHash);
  assert.equal(physical.sourceHash, sha256(JSON.stringify(physical.sources)));
  validateFourCohorts(physical.cohorts, root);
  assert.deepEqual(normalizeExact(physical.population), normalizeExact(POPULATION.map(wire)));
  assert.deepEqual(
    normalizeExact(physical.rate),
    normalizeExact(
      priceFourCohortSupply(snapshot, POPULATION, cohortsFromWire(physical.cohorts)).map(wire),
    ),
  );
  assert.ok(Number.isFinite(physical.computeMs) && physical.computeMs > 0);
  assert.ok(Number.isFinite(Date.parse(physical.generatedAt)));
  assert.equal(provenance.panel.path, `${V8_ROOT}/panel.json`);
  const panel = JSON.parse(pinnedBytes(provenance.panel, root).toString()) as unknown[];
  assert.equal(panel.length, 24);
  return { snapshot, physical, panel, provenance };
}
