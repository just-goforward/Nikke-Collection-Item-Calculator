import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CertifiedSupplySnapshot } from "../../../shared/certifiedSupply.ts";
import {
  EVIDENCE_FILES as HISTORICAL_EVIDENCE_FILES,
  GENERATION_SOURCES as HISTORICAL_GENERATION_SOURCES,
  normalizeExact,
  type PhysicalEvidence,
  validateGenerationEnvironment,
} from "../v6/evidence.ts";
import { pinnedBytes, type SourceIdentity, sourceIdentity } from "../v6/history.ts";
import { readHistoricalPublication, V6_PINS_SHA } from "./history.ts";

export const V7_ROOT = "scripts/certified-staging-approved-panel/v7";
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
export const EVIDENCE_FILES = [
  ...new Set([...HISTORICAL_EVIDENCE_FILES, ...GENERATION_SOURCES, ...PUBLICATION_FILES]),
];
export type EvidenceProvenance = {
  version: string;
  generationEnvironment: {
    nodeVersion: string;
    packageLockSha256: string;
    biomeSha256: string;
  };
  generation: ReturnType<typeof sourceIdentity> & {
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

export function readV7Evidence(root = process.cwd()) {
  const pins = JSON.parse(readFileSync(resolve(root, V7_ROOT, "pins.json"), "utf8")) as {
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
  assert.deepEqual(provenance.generation, {
    ...sourceIdentity(GENERATION_SOURCES, root),
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
  assert.ok(provenance.snapshot.sources.length > 0);
  for (const source of provenance.snapshot.sources) pinnedBytes(source, root);
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
