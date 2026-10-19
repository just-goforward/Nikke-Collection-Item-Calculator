import { expect, it } from "vitest";
import { CERTIFIED_EVIDENCE_COVERAGE } from "../../../shared/certifiedEvidenceCoverage.ts";
import { CERTIFIED_ENGINE_CODE_HASH } from "../../../shared/generated/certifiedEngineBuild.ts";
import { V10_PINS_SHA } from "./anchor.ts";
import { assertCoverageMatchesV10Publication } from "./coverage-test-helper.ts";

it("binds each coverage field to independently authenticated evidence", async () => {
  const root = "scripts/certified-staging-approved-panel/v10";
  const anchor = V10_PINS_SHA;
  const engineBuildHash = CERTIFIED_ENGINE_CODE_HASH;
  const tuple = {
    cadenceVersion: "observed-median-v2",
    engineBuildHash,
    panelAnchorSha256: anchor,
  };
  expect(CERTIFIED_EVIDENCE_COVERAGE).toEqual([tuple]);
  expect(() =>
    assertCoverageMatchesV10Publication(tuple, root, anchor, engineBuildHash),
  ).not.toThrow();
  for (const field of Object.keys(tuple))
    expect(() =>
      assertCoverageMatchesV10Publication(
        { ...tuple, [field]: "0".repeat(64) },
        root,
        anchor,
        engineBuildHash,
      ),
    ).toThrow();
}, 180_000);
