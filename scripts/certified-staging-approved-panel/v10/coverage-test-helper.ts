import assert from "node:assert/strict";
import { readV10Evidence } from "./evidence.ts";

/** Test-only: authentication uses a separately trusted anchor, never the tuple's own hash. */
export function assertCoverageMatchesV10Publication(
  tuple: { cadenceVersion: string; engineBuildHash: string; panelAnchorSha256: string },
  root: string,
  trustedAnchor: string,
  expectedEngineHash: string,
) {
  const { provenance } = readV10Evidence(root, trustedAnchor, expectedEngineHash);
  assert.deepEqual(tuple, {
    cadenceVersion: provenance.cadenceVersion,
    engineBuildHash: provenance.engineBuildHash,
    panelAnchorSha256: trustedAnchor,
  });
}
