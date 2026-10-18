export type CertifiedEvidenceCoverage = {
  cadenceVersion: string;
  engineBuildHash: string;
  panelAnchorSha256: string;
};

// Add anchors only after the corresponding evidence panel has been sealed.
export const CERTIFIED_EVIDENCE_COVERAGE: readonly CertifiedEvidenceCoverage[] = [];

export function hasCertifiedEvidenceCoverage(
  cadenceVersion: string,
  engineBuildHash: string,
  coverage: readonly CertifiedEvidenceCoverage[] = CERTIFIED_EVIDENCE_COVERAGE,
) {
  return coverage.some(
    (anchor) =>
      anchor.cadenceVersion === cadenceVersion &&
      anchor.engineBuildHash === engineBuildHash &&
      /^[a-f0-9]{64}$/.test(anchor.panelAnchorSha256),
  );
}
