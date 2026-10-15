import assert from "node:assert/strict";
import {
  fileSha256,
  approvedFixtureProvenance as historicalProvenance,
} from "../../certified-staging-approved-panel.ts";
import { fromWire, mapTriple } from "../../certified-staging-oracle.ts";
import { normalizeExact } from "../v6/evidence.ts";
import { calculatePanel } from "./calculate.ts";
import { EVIDENCE_FILES, readV7Evidence } from "./evidence.ts";

export function approvedFixtureProvenance() {
  const { provenance } = readV7Evidence();
  return [
    ...historicalProvenance(),
    ...EVIDENCE_FILES.map((path) => ({ path, sha256: fileSha256(path) })),
    ...provenance.snapshot.sources,
  ].filter((row, index, rows) => rows.findIndex((other) => other.path === row.path) === index);
}

export function frozenApprovedSnapshot() {
  return readV7Evidence().snapshot;
}

export function loadIndependentApprovedPanel() {
  const { snapshot, physical, panel } = readV7Evidence();
  const generated = calculatePanel(
    snapshot,
    mapTriple(physical.cohorts, (row) => mapTriple(row, fromWire)),
  );
  assert.deepEqual(
    normalizeExact(panel),
    normalizeExact(generated),
    "tracked v2 approved24 expectations differ from independent oracle; version new evidence explicitly",
  );
  return generated.map((row) => ({ ...row, input: { ...row.input, snapshot } }));
}
