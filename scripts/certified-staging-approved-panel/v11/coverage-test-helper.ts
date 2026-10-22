import assert from "node:assert/strict";
import { readV11Evidence } from "./evidence.ts";

/** An external trusted anchor is required; a tuple cannot authenticate itself. */
export function assertCoverageMatchesV11Publication(
  tuple: { cadenceVersion: string; engineBuildHash: string; panelAnchorSha256: string },
  root: string,
  trustedAnchor: string,
  expectedEngineHash: string,
) {
  const { provenance } = readV11Evidence(root, trustedAnchor, expectedEngineHash);
  assert.deepEqual(tuple, {
    cadenceVersion: provenance.cadenceVersion,
    engineBuildHash: provenance.engineBuildHash,
    panelAnchorSha256: trustedAnchor,
  });
}
