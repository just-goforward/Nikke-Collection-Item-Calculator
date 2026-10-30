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
  {
    cadenceVersion: "observed-median-v2",
    engineBuildHash: "b233ab5229e6f3c59acc7ed701c065c512b6ed145cf65853b1e449f519927c01",
    panelAnchorSha256: "1fbce4c763218e39bc9fe442198cea30fa7623b91605581b1885f9036b56e5ae",
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
