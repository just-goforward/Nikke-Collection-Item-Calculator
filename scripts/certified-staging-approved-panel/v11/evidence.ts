import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CertifiedSupplySnapshot } from "../../../shared/certifiedSupply.ts";
import { wire } from "../../certified-staging-oracle.ts";
import { sha256 } from "../v6/history.ts";
import type { Provenance } from "../v10/evidence.ts";
import { V11_PINS_SHA } from "./anchor.ts";
import { calculateBoundaries, calculatePanel } from "./calculate.ts";
import { independentThreeCohorts } from "./physical.ts";

export const VERSION = "approved24-independent-evidence-v11";
export const PUBLICATION_FILES = [
  "snapshot.json",
  "independent-physical-cohorts.json",
  "panel.json",
  "provenance.json",
  "pins.json",
] as const;

/** A supplied hash authenticates a review draft; it does not register publication coverage. */
export function readV11Evidence(root: string, anchor = V11_PINS_SHA, engineBuildHash?: string) {
  assert.match(anchor, /^[a-f0-9]{64}$/, "Unsealed or invalid v11 anchor");
  const bytes = (name: string) => readFileSync(resolve(root, name));
  const pinsBytes = bytes("pins.json");
  assert.equal(sha256(pinsBytes), anchor, "Anchor mismatch");
  const pins = JSON.parse(pinsBytes.toString());
  assert.equal(pins.version, VERSION);
  const provenanceBytes = bytes("provenance.json");
  assert.equal(sha256(provenanceBytes), pins.provenanceSha256, "Provenance mismatch");
  const provenance = JSON.parse(provenanceBytes.toString()) as Provenance;
  assert.equal(provenance.version, VERSION);
  assert.equal(provenance.cadenceVersion, "observed-median-v2");
  assert.match(provenance.engineBuildHash, /^[a-f0-9]{64}$/);
  if (engineBuildHash) assert.equal(provenance.engineBuildHash, engineBuildHash, "Engine mismatch");
  const paths = provenance.sources.map((source) => source.path);
  assert.equal(new Set(paths).size, paths.length, "Duplicate source");
  for (const path of [
    "scripts/certified-staging-approved-panel/v11/generate.ts",
    "scripts/certified-staging-approved-panel/v11/product-input.ts",
    "scripts/certified-staging-approved-panel/v11/pricing.ts",
    "scripts/certified-staging-approved-panel/v11/calculate.ts",
    "scripts/certified-staging-approved-panel/v10/fixtures/input.ts",
    "scripts/certified-staging-oracle-physical-supply.ts",
  ])
    assert.ok(paths.includes(path), `Missing source: ${path}`);
  for (const source of provenance.sources)
    assert.equal(sha256(Buffer.from(source.base64, "base64")), source.sha256, "Source mismatch");
  assert.deepEqual(Object.keys(provenance.files).sort(), [...PUBLICATION_FILES.slice(0, 3)].sort());
  const authenticated = (name: string) => {
    const value = bytes(name);
    assert.equal(sha256(value), provenance.files[name], `File mismatch: ${name}`);
    return JSON.parse(value.toString());
  };
  const snapshot = authenticated("snapshot.json") as CertifiedSupplySnapshot;
  const cohorts = independentThreeCohorts();
  assert.deepEqual(
    authenticated("independent-physical-cohorts.json"),
    cohorts.map((row) => row.map(wire)),
  );
  const panel = {
    cases: calculatePanel(snapshot, cohorts),
    boundaries: calculateBoundaries(snapshot, cohorts),
  };
  assert.deepEqual(authenticated("panel.json"), panel);
  return { snapshot, panel, provenance, panelAnchorSha256: anchor };
}
