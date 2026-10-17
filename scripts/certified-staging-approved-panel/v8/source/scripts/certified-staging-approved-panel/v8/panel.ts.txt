import assert from "node:assert/strict";
import { fileSha256 } from "../../certified-staging-approved-panel.ts";
import { normalizeExact } from "../v6/evidence.ts";
import { calculatePanel } from "./calculate.ts";
import { cohortsFromWire, EVIDENCE_FILES, readV8Evidence } from "./evidence.ts";

export function approvedFixtureProvenance() {
  const { provenance } = readV8Evidence();
  return [
    ...EVIDENCE_FILES.map((path) => ({ path, sha256: fileSha256(path) })),
    ...provenance.snapshot.sources,
  ].filter((row, index, rows) => rows.findIndex((other) => other.path === row.path) === index);
}

export function frozenApprovedSnapshot() {
  return readV8Evidence().snapshot;
}

export function loadIndependentApprovedPanel() {
  const { snapshot, physical, panel } = readV8Evidence();
  const generated = calculatePanel(snapshot, cohortsFromWire(physical.cohorts));
  assert.deepEqual(
    normalizeExact(panel),
    normalizeExact(generated),
    "tracked v3 approved24 expectations differ from independent oracle; version new evidence explicitly",
  );
  return generated.map((row) => ({ ...row, input: { ...row.input, snapshot } }));
}
