import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CertifiedInput, CertifiedOutput } from "../src/certified/types.ts";

export const RELAXATION_POPULATION = {
  original: {
    path: "benchmarks/results/certified-staging-validation-actual-h56-final-review7-physical2000-original2000-merged.json",
    sha256: "ce882a2d3550cfde39c27093ad971e44e9f4273ade4c4c733b52edb164add94d",
  },
  remaining: {
    path: "benchmarks/results/certified-staging-validation-final-review7-physical2000-expanded-union.json",
    sha256: "337ef2064e9fd7b61d291ec4d1f77b44fa97cd7a039d9cd342c43559404c0e3a",
  },
  profile: "2dac8a06545575872fbd24d2c7904ac3b03aa8d883937e336ec67af87d5adb14",
  snapshot: "08bb2900db7eb75f2705665fcd77757de7a83f3e9cd7a61b84d17c900ebd319f",
  pathVerifier: "ae24b5284da2196e39e304eee1389271612b01a0c2d064b5087bd9d490ddc673",
} as const;
type Source = { path: string; sha256: string };
type SavedRow = {
  id: string;
  input: Omit<CertifiedInput, "snapshot">;
  output: CertifiedOutput;
  waitingCertificate: { status: string; reason: string };
};
type RemainingRow = {
  id: string;
  inputSha256: string;
  witnessSha256: string;
  reason: string;
  phase: string;
  proofFile: Source;
};
type OriginalReport = {
  integrity: { engineProfileCodeHashes: string[]; snapshotHashes: string[] };
  sources: Source[];
  reports: { rows: SavedRow[] }[];
};
type RemainingReport = {
  profileCodeHash: string;
  snapshotSha256: string;
  notRun: RemainingRow[];
};
export type RelaxationCase = SavedRow & {
  inputSha256: string;
  witnessSha256: string;
  priorExpandedProof: Source;
  inheritedPathProof: {
    status: "PASS_INHERITED";
    originalReport: Source;
    verifierSourceSha256: string;
    prerequisite: string;
  };
};
export function evidenceHash(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function checkedBytes(record: Source): string {
  const bytes = readFileSync(record.path);
  if (evidenceHash(bytes) !== record.sha256)
    throw new Error("Frozen evidence drift: " + record.path);
  return bytes.toString("utf8");
}
function checkReportIdentity(original: OriginalReport, remaining: RemainingReport): void {
  const profile = original.integrity.engineProfileCodeHashes;
  const snapshot = original.integrity.snapshotHashes;
  if (profile.length !== 1 || profile[0] !== RELAXATION_POPULATION.profile)
    throw new Error("Original population profile mismatch");
  if (snapshot.length !== 1 || snapshot[0] !== RELAXATION_POPULATION.snapshot)
    throw new Error("Original population snapshot mismatch");
  if (remaining.profileCodeHash !== profile[0] || remaining.snapshotSha256 !== snapshot[0])
    throw new Error("Remaining population identity mismatch");
  const verifier = original.sources.find(
    (source) => source.path === "scripts/certified-staging-oracle-certificates.ts",
  );
  if (verifier?.sha256 !== RELAXATION_POPULATION.pathVerifier)
    throw new Error("Original receipt-path proof source mismatch");
}
function joinCase(original: SavedRow, remaining: RemainingRow): RelaxationCase {
  const witness = original.output.waiting.strictBoundaryWitness;
  if (!witness || original.output.waiting.recommendedDays !== 56)
    throw new Error("Selected case does not contain an issued boundary witness");
  if (
    original.waitingCertificate.status !== "NOTRUN" ||
    original.waitingCertificate.reason !== "independent_endpoint_memo_budget" ||
    remaining.reason !== "independent_endpoint_memo_budget"
  )
    throw new Error("Selected case did not reach the independently reconstructed endpoint phase");
  const inputSha256 = evidenceHash(JSON.stringify(original.input));
  const witnessSha256 = evidenceHash(JSON.stringify(witness));
  if (inputSha256 !== remaining.inputSha256 || witnessSha256 !== remaining.witnessSha256)
    throw new Error("Same-case input or witness hash mismatch: " + original.id);
  return {
    ...original,
    inputSha256,
    witnessSha256,
    priorExpandedProof: remaining.proofFile,
    inheritedPathProof: {
      status: "PASS_INHERITED",
      originalReport: RELAXATION_POPULATION.original,
      verifierSourceSha256: RELAXATION_POPULATION.pathVerifier,
      prerequisite:
        "The immutable original verifier reaches endpoint memo admission only after exact cohort-positive receipt masses, complete future refs, stock reconstruction and the boundary envelope pass. No new PMF evaluation is claimed here.",
    },
  };
}
export function loadRelaxationPopulation(): RelaxationCase[] {
  const original = JSON.parse(checkedBytes(RELAXATION_POPULATION.original)) as OriginalReport;
  const remaining = JSON.parse(checkedBytes(RELAXATION_POPULATION.remaining)) as RemainingReport;
  checkReportIdentity(original, remaining);
  const rows = new Map(
    original.reports.flatMap((report) => report.rows).map((row) => [row.id, row]),
  );
  if (remaining.notRun.length !== 84 || new Set(remaining.notRun.map((row) => row.id)).size !== 84)
    throw new Error("Frozen remaining population is not exactly84 distinct original cases");
  return remaining.notRun.map((record) => {
    const row = rows.get(record.id);
    if (!row) throw new Error("Original case missing: " + record.id);
    return joinCase(row, record);
  });
}
