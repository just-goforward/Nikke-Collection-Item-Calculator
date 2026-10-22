import { expect, it } from "vitest";
import { CERTIFIED_EVIDENCE_COVERAGE } from "../../../shared/certifiedEvidenceCoverage.ts";
import { V11_PINS_SHA } from "./anchor.ts";
import { assertCoverageMatchesV11Publication } from "./coverage-test-helper.ts";
import { readV11Evidence } from "./evidence.ts";

it("binds each registered coverage field to the authenticated v11 publication", async () => {
  const root = "scripts/certified-staging-approved-panel/v11";
  const anchor = V11_PINS_SHA;
  const engineBuildHash = readV11Evidence(root).provenance.engineBuildHash;
  const tuple = {
    cadenceVersion: "observed-median-v2",
    engineBuildHash,
    panelAnchorSha256: anchor,
  };
  expect(CERTIFIED_EVIDENCE_COVERAGE).toContainEqual(tuple);
  expect(() =>
    assertCoverageMatchesV11Publication(tuple, root, anchor, engineBuildHash),
  ).not.toThrow();
  for (const field of Object.keys(tuple))
    expect(() =>
      assertCoverageMatchesV11Publication(
        { ...tuple, [field]: "0".repeat(64) },
        root,
        anchor,
        engineBuildHash,
      ),
    ).toThrow();
}, 180_000);
