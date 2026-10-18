import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { CertifiedSupplySnapshot } from "../../../shared/certifiedSupply.ts";
import { wire } from "../../certified-staging-oracle.ts";
import { priceFourCohortSupply } from "../../certified-staging-oracle-four-cohort-pricing.ts";
import { normalizeExact, validateGenerationEnvironment } from "../v6/evidence.ts";
import { pinnedBytes, type SourceIdentity, sha256, type sourceIdentity } from "../v6/history.ts";
import { V8_PINS_SHA } from "../v8/anchor.ts";
import {
  assertV3Snapshot,
  COHORT_MIGRATION,
  cohortsFromWire,
  EVIDENCE_FILES as HISTORICAL_EVIDENCE_FILES,
  type PhysicalEvidenceV8,
  POPULATION,
  readV8Evidence,
  validateFourCohorts,
} from "../v8/evidence.ts";
import { V9_PINS_SHA } from "./anchor.ts";

export const V9_ROOT = "scripts/certified-staging-approved-panel/v9";
export const EVIDENCE_VERSION = "approved24-independent-evidence-v9";
export const PHYSICAL_VERSION = "independent-four-cohort-physical-supply-rates-v9";
export const PUBLICATION_FILES = [
  "snapshot.json",
  "independent-physical-cohorts.json",
  "panel.json",
  "provenance.json",
  "pins.json",
].map((name) => `${V9_ROOT}/${name}`);
/** Runtime closure of the isolated calculator plus the v9 harness itself. The
 * unchanged v8 physical enumeration, panel calculation and snapshot preparation
 * are reused, so they are generation sources of v9 as current bytes. */
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
  ...["anchor.ts", "physical.ts", "evidence.ts", "calculate.ts", "snapshot.ts"].map(
    (name) => `scripts/certified-staging-approved-panel/v8/${name}`,
  ),
  ...["evidence.ts", "calculate.ts", "panel.ts", "generate.ts"].map((name) => `${V9_ROOT}/${name}`),
];
export const ANCHOR_FILE = `${V9_ROOT}/anchor.ts`;
export const V9_ARCHIVE_ROOT = `${V9_ROOT}/source`;
export const SNAPSHOT_SOURCES = [
  "shared/certifiedDispatchExpectations.ts",
  "shared/certifiedForecastIdentity.ts",
  "shared/certifiedRational.ts",
  "shared/certifiedSupply.ts",
  "shared/certifiedSupplyBuild.ts",
  "shared/certifiedSupplyCoherence.ts",
  "shared/certifiedSupplyLaws.ts",
  "shared/certifiedSupplyModel.ts",
  "shared/certifiedSupplyValidation.ts",
  "shared/certifiedVersionPolicy.ts",
  "shared/gameDay.ts",
  "shared/generated/certifiedForecastAuthority.ts",
  "shared/soloRaidCadence.ts",
  "src/lib/certifiedForecast.ts",
];
const archivePath = (path: string) => `${V9_ARCHIVE_ROOT}/${path}.txt`;
export const ARCHIVE_FILES = [...GENERATION_SOURCES, ...SNAPSHOT_SOURCES].map(archivePath);
const archivedBytes = (source: SourceIdentity, root: string) =>
  pinnedBytes({ path: archivePath(source.path), sha256: source.sha256 }, root);
export const EVIDENCE_FILES = [
  ...new Set([
    ...HISTORICAL_EVIDENCE_FILES,
    ...ARCHIVE_FILES,
    ...GENERATION_SOURCES,
    ANCHOR_FILE,
    ...PUBLICATION_FILES,
  ]),
];
export type PhysicalEvidenceV9 = PhysicalEvidenceV8;
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
  historical: { v8PinsSha256: string; cohortMigration: typeof COHORT_MIGRATION };
  snapshot: SourceIdentity & {
    meaning: "approved forecast input only; not an expected solver output";
    sources: SourceIdentity[];
  };
  physicalEnumeration: SourceIdentity;
  panel: SourceIdentity;
};

/** The reviewed anchor authenticates archived source bytes. An explicitly supplied
 * fresh pin authenticates the copied live sources used by that disposable calculation. */
export function readV9Evidence(root = process.cwd(), pinsSha = V9_PINS_SHA) {
  const sourceBytes = pinsSha === V9_PINS_SHA ? archivedBytes : pinnedBytes;
  const pins = JSON.parse(
    pinnedBytes({ path: `${V9_ROOT}/pins.json`, sha256: pinsSha }, root).toString(),
  ) as {
    version: string;
    provenance: SourceIdentity;
  };
  assert.equal(pins.version, EVIDENCE_VERSION);
  assert.equal(pins.provenance.path, `${V9_ROOT}/provenance.json`);
  const provenance = JSON.parse(
    pinnedBytes(pins.provenance, root).toString(),
  ) as EvidenceProvenance;
  assert.equal(provenance.version, EVIDENCE_VERSION);
  validateGenerationEnvironment(provenance.generationEnvironment);
  assert.deepEqual(provenance.historical, {
    v8PinsSha256: V8_PINS_SHA,
    cohortMigration: COHORT_MIGRATION,
  });
  readV8Evidence(root);
  const inventory = readdirSync(resolve(root, V9_ARCHIVE_ROOT), {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => {
      assert.ok(entry.isFile());
      return resolve(entry.parentPath, entry.name);
    });
  assert.deepEqual(inventory.sort(), ARCHIVE_FILES.map((path) => resolve(root, path)).sort());
  const { sources, sourceHash } = provenance.generation;
  assert.deepEqual(
    sources.map(({ path }) => path),
    GENERATION_SOURCES,
  );
  assert.equal(sourceHash, sha256(JSON.stringify(sources)));
  for (const source of sources) sourceBytes(source, root);
  assert.deepEqual(provenance.generation, {
    sources,
    sourceHash,
    isolatedCacheEmpty: true,
    physicalEnumeration: "sequential-draw-state-merged",
    oracleRows: 24,
    independentWaiting: "UNVERIFIED_NOT_REGENERATED",
  });
  assert.equal(provenance.snapshot.path, `${V9_ROOT}/snapshot.json`);
  assert.equal(
    provenance.snapshot.meaning,
    "approved forecast input only; not an expected solver output",
  );
  assert.deepEqual(
    provenance.snapshot.sources.map(({ path }) => path),
    SNAPSHOT_SOURCES,
  );
  for (const source of provenance.snapshot.sources) sourceBytes(source, root);
  const snapshot = JSON.parse(
    pinnedBytes(provenance.snapshot, root).toString(),
  ) as CertifiedSupplySnapshot;
  assertV3Snapshot(snapshot);
  assert.equal(provenance.physicalEnumeration.path, `${V9_ROOT}/independent-physical-cohorts.json`);
  const physical = JSON.parse(
    pinnedBytes(provenance.physicalEnumeration, root).toString(),
  ) as PhysicalEvidenceV9;
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
  assert.equal(provenance.panel.path, `${V9_ROOT}/panel.json`);
  const panel = JSON.parse(pinnedBytes(provenance.panel, root).toString()) as unknown[];
  assert.equal(panel.length, 24);
  return { snapshot, physical, panel, provenance };
}
