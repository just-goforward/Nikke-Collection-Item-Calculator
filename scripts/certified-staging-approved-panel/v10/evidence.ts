import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CertifiedSupplySnapshot } from "../../../shared/certifiedSupply.ts";
import { fromWire, wire } from "../../certified-staging-oracle.ts";
import { sha256 } from "../v6/history.ts";
import { type FourCohorts, independentFourCohorts } from "../v8/physical.ts";
import { V10_PINS_SHA } from "./anchor.ts";
import { calculateBoundaries, calculatePanel } from "./calculate.ts";
import { assertCadence } from "./pricing.ts";

export const PUBLICATION_FILES = [
  "snapshot.json",
  "independent-physical-cohorts.json",
  "panel.json",
  "provenance.json",
  "pins.json",
] as const;
export const VERSION = "approved24-independent-evidence-v10";
export type Provenance = {
  version: string;
  cadenceVersion: string;
  engineBuildHash: string;
  files: Record<string, string>;
  sources: { path: string; sha256: string; base64: string }[];
};
export function readV10Evidence(root: string, anchor = V10_PINS_SHA, engineBuildHash?: string) {
  assert.ok(anchor && /^[a-f0-9]{64}$/.test(anchor), "Unsealed or invalid v10 anchor");
  const bytes = (name: string) => readFileSync(resolve(root, name));
  const pinsBytes = bytes("pins.json");
  assert.equal(sha256(pinsBytes), anchor, "Anchor mismatch");
  const pins = JSON.parse(pinsBytes.toString());
  assert.equal(pins.version, VERSION);
  const provenanceBytes = bytes("provenance.json");
  assert.equal(sha256(provenanceBytes), pins.provenanceSha256);
  const provenance = JSON.parse(provenanceBytes.toString()) as Provenance;
  assert.equal(provenance.version, VERSION);
  assert.equal(provenance.cadenceVersion, "observed-median-v2");
  assert.match(provenance.engineBuildHash, /^[a-f0-9]{64}$/);
  if (engineBuildHash) assert.equal(provenance.engineBuildHash, engineBuildHash, "Engine mismatch");
  assert.ok(provenance.sources.length > 0);
  for (const source of provenance.sources)
    assert.equal(sha256(Buffer.from(source.base64, "base64")), source.sha256, "Source mismatch");
  const authenticated = (name: string) => {
    const value = bytes(name);
    assert.equal(sha256(value), provenance.files[name], `File mismatch: ${name}`);
    return JSON.parse(value.toString());
  };
  const snapshot = authenticated("snapshot.json") as CertifiedSupplySnapshot;
  assertCadence(snapshot);
  const physical = authenticated("independent-physical-cohorts.json");
  const cohorts = physical.map((row: Parameters<typeof fromWire>[0][]) => row.map(fromWire)) as FourCohorts;
  assert.deepEqual(physical, independentFourCohorts().map((row) => row.map(wire)));
  const panel = authenticated("panel.json");
  assert.deepEqual(panel, {
    cases: calculatePanel(snapshot, cohorts),
    boundaries: calculateBoundaries(snapshot, cohorts),
  });
  return { snapshot, panel, provenance, panelAnchorSha256: anchor };
}
