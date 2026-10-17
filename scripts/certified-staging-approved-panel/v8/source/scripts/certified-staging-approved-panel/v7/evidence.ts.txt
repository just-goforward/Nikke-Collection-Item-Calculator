import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { CertifiedSupplySnapshot } from "../../../shared/certifiedSupply.ts";
import {
  EVIDENCE_FILES as HISTORICAL_EVIDENCE_FILES,
  GENERATION_SOURCES as HISTORICAL_GENERATION_SOURCES,
  normalizeExact,
  type PhysicalEvidence,
  validateGenerationEnvironment,
} from "../v6/evidence.ts";
import { pinnedBytes, type SourceIdentity, sha256 } from "../v6/history.ts";
import { readHistoricalPublication, V6_PINS_SHA } from "./history.ts";

export const V7_ROOT = "scripts/certified-staging-approved-panel/v7";
/** Reviewed trust anchor: v7 is sealed history and its pins never change. */
export const V7_PINS_SHA = "6eb88521323872b3f19474fa5b2bcd8b03620f42c6e01c829d37c5b5155ccd57";
/** Byte-exact copies of the v7 generation and snapshot sources as sealed in its
 * provenance (recovered from the publication commit). The working tree moved on to
 * supply rules v3, so v7 authenticates these preserved bytes instead. */
export const V7_ARCHIVE_ROOT = `${V7_ROOT}/source`;
export const SNAPSHOT_SOURCES = [
  "shared/certifiedDispatchExpectations.ts",
  "shared/certifiedForecastIdentity.ts",
  "shared/certifiedRational.ts",
  "shared/certifiedSupply.ts",
  "shared/certifiedSupplyBuild.ts",
  "shared/certifiedSupplyLaws.ts",
  "shared/certifiedSupplyModel.ts",
  "shared/certifiedSupplyValidation.ts",
  "shared/generated/certifiedEngineBuild.ts",
  "shared/generated/certifiedForecastAuthority.ts",
  "shared/soloRaidCadence.ts",
  "shared/supplyForecastModel.ts",
  "src/lib/certifiedForecast.ts",
] as const;
const archivePath = (path: string) => `${V7_ARCHIVE_ROOT}/${path}.txt`;
const archivedBytes = (identity: SourceIdentity, root: string) =>
  pinnedBytes({ path: archivePath(identity.path), sha256: identity.sha256 }, root);
export const EVIDENCE_VERSION = "approved24-independent-evidence-v7";
export const PHYSICAL_VERSION = "independent-ordered-physical-supply-rates-v7";
export const PUBLICATION_FILES = [
  "snapshot.json",
  "independent-physical-cohorts.json",
  "panel.json",
  "provenance.json",
  "pins.json",
].map((name) => `${V7_ROOT}/${name}`);
export const GENERATION_SOURCES = [
  ...HISTORICAL_GENERATION_SOURCES,
  ...["history.ts", "evidence.ts", "calculate.ts", "panel.ts", "snapshot.ts", "generate.ts"].map(
    (name) => `${V7_ROOT}/${name}`,
  ),
];
export const ARCHIVE_FILES = [...GENERATION_SOURCES, ...SNAPSHOT_SOURCES].map(archivePath);
export const EVIDENCE_FILES = [
  ...new Set([...HISTORICAL_EVIDENCE_FILES, ...ARCHIVE_FILES, ...PUBLICATION_FILES]),
];
export type EvidenceProvenance = {
  version: string;
  generationEnvironment: {
    nodeVersion: string;
    packageLockSha256: string;
    biomeSha256: string;
  };
  generation: { sources: SourceIdentity[]; sourceHash: string } & {
    isolatedCacheEmpty: true;
    physicalEnumeration: "full-ordered";
    oracleRows: 24;
    independentWaiting: "UNVERIFIED_NOT_REGENERATED";
  };
  historical: { v6PinsSha256: string; cohortMigration: "append-zero-fourth-prior" };
  snapshot: SourceIdentity & {
    meaning: "approved forecast input only; not an expected solver output";
    sources: SourceIdentity[];
  };
  physicalEnumeration: SourceIdentity;
  panel: SourceIdentity;
};

function archiveInventory(root: string) {
  const files = (directory: string): string[] =>
    readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return files(path);
      assert.ok(entry.isFile(), `Archive must contain regular files: ${path}`);
      return [path];
    });
  assert.deepEqual(files(V7_ARCHIVE_ROOT).sort(), [...ARCHIVE_FILES].sort(), "v7 archive drift");
}

export function readV7Evidence(root = process.cwd()) {
  const pins = JSON.parse(
    pinnedBytes({ path: `${V7_ROOT}/pins.json`, sha256: V7_PINS_SHA }, root).toString(),
  ) as {
    version: string;
    provenance: SourceIdentity;
  };
  assert.equal(pins.version, EVIDENCE_VERSION);
  assert.equal(pins.provenance.path, `${V7_ROOT}/provenance.json`);
  const provenance = JSON.parse(
    pinnedBytes(pins.provenance, root).toString(),
  ) as EvidenceProvenance;
  assert.equal(provenance.version, EVIDENCE_VERSION);
  validateGenerationEnvironment(provenance.generationEnvironment);
  assert.deepEqual(provenance.historical, {
    v6PinsSha256: V6_PINS_SHA,
    cohortMigration: "append-zero-fourth-prior",
  });
  const historical = readHistoricalPublication(root);
  archiveInventory(root);
  const { sources, sourceHash } = provenance.generation;
  assert.deepEqual(
    sources.map(({ path }) => path),
    GENERATION_SOURCES,
  );
  assert.equal(sourceHash, sha256(JSON.stringify(sources)));
  for (const source of sources) archivedBytes(source, root);
  assert.deepEqual(provenance.generation, {
    sources,
    sourceHash,
    isolatedCacheEmpty: true,
    physicalEnumeration: "full-ordered",
    oracleRows: 24,
    independentWaiting: "UNVERIFIED_NOT_REGENERATED",
  });
  assert.equal(provenance.snapshot.path, `${V7_ROOT}/snapshot.json`);
  assert.equal(
    provenance.snapshot.meaning,
    "approved forecast input only; not an expected solver output",
  );
  assert.deepEqual(
    provenance.snapshot.sources.map(({ path }) => path),
    SNAPSHOT_SOURCES,
  );
  for (const source of provenance.snapshot.sources) archivedBytes(source, root);
  const snapshot = JSON.parse(
    pinnedBytes(provenance.snapshot, root).toString(),
  ) as CertifiedSupplySnapshot;
  assert.equal(snapshot.version, "certified-daily-v2");
  assert.equal(snapshot.events.length, 79);
  assert.equal(provenance.physicalEnumeration.path, `${V7_ROOT}/independent-physical-cohorts.json`);
  const physical = JSON.parse(
    pinnedBytes(provenance.physicalEnumeration, root).toString(),
  ) as PhysicalEvidence;
  assert.equal(physical.version, PHYSICAL_VERSION);
  assert.deepEqual(physical.sources, provenance.generation.sources);
  assert.equal(physical.sourceHash, provenance.generation.sourceHash);
  assert.deepEqual(normalizeExact(physical.cohorts), normalizeExact(historical.physical.cohorts));
  assert.deepEqual(normalizeExact(physical.rate), normalizeExact(historical.physical.rate));
  assert.ok(Number.isFinite(physical.computeMs) && physical.computeMs > 0);
  assert.ok(Number.isFinite(Date.parse(physical.generatedAt)));
  assert.equal(provenance.panel.path, `${V7_ROOT}/panel.json`);
  const panel = JSON.parse(pinnedBytes(provenance.panel, root).toString()) as unknown[];
  assert.equal(panel.length, 24);
  return { snapshot, physical, panel, provenance };
}
