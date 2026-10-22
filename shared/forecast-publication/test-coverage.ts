import type { CertifiedEvidenceCoverage } from "../certifiedEvidenceCoverage.ts";
import { CERTIFIED_ENGINE_CODE_HASH } from "../generated/certifiedEngineBuild.ts";

/** Synthetic dependency for business-logic tests only. This is neither a seal nor
 * a registry update; deployed entry points always use CERTIFIED_EVIDENCE_COVERAGE. */
export const TEST_PUBLICATION_COVERAGE: readonly CertifiedEvidenceCoverage[] = [
  {
    cadenceVersion: "observed-median-v2",
    engineBuildHash: CERTIFIED_ENGINE_CODE_HASH,
    panelAnchorSha256: "a".repeat(64),
  },
];
