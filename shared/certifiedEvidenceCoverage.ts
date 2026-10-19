export type CertifiedEvidenceCoverage = {
  cadenceVersion: string;
  engineBuildHash: string;
  panelAnchorSha256: string;
};

// Add anchors only after the corresponding evidence panel has been sealed.
export const CERTIFIED_EVIDENCE_COVERAGE: readonly CertifiedEvidenceCoverage[] = [
  {
    cadenceVersion: "observed-median-v2",
    engineBuildHash: "1912bc830684bb443c7eab45ba0f9940b6d0f6e2ba4757ff910230baad69f4b1",
    panelAnchorSha256: "b5791ff31314aff45f4391b91e8f7aff3a11ea5f1ad711d3d649a6a5bcf1a35a",
  },
];

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
