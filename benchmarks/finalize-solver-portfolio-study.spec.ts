import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { requireResearchEvidence } from "./finalize-solver-portfolio-study";
import { collectResearchProvenance } from "./research-provenance";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

function evidence() {
  return {
    kind: "portfolio-evidence-fixture",
    version: 3,
    provenance: collectResearchProvenance({
      repoRoot: REPO_ROOT,
      studyId: "portfolio-evidence-fixture-v1",
      protocolVersion: 1,
      contract: { scenario: "small" },
      sourceFiles: ["benchmarks/research-provenance.ts"],
    }),
  };
}

describe("solver portfolio evidence finalization", () => {
  it("accepts the expected report identity and complete source list", () => {
    expect(() =>
      requireResearchEvidence(
        evidence(),
        "portfolio-evidence-fixture",
        3,
        "portfolio-evidence-fixture-v1",
        ["benchmarks/research-provenance.ts"],
      ),
    ).not.toThrow();
  });

  it("rejects omitted decisive sources and tampered source metadata", () => {
    expect(() =>
      requireResearchEvidence(
        evidence(),
        "portfolio-evidence-fixture",
        3,
        "portfolio-evidence-fixture-v1",
        ["benchmarks/missing-decisive-source.ts"],
      ),
    ).toThrow(/Required research source is missing/u);

    const tampered = evidence();
    const source = tampered.provenance.sourceFiles[0];
    if (!source) throw new Error("Expected one source fingerprint.");
    source.bytes += 1;
    expect(() =>
      requireResearchEvidence(
        tampered,
        "portfolio-evidence-fixture",
        3,
        "portfolio-evidence-fixture-v1",
        ["benchmarks/research-provenance.ts"],
      ),
    ).toThrow(/Source fingerprint metadata mismatch/u);
  });
});
