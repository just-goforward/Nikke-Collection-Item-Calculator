import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  assertResearchReportCanBeWritten,
  canonicalJson,
  collectResearchProvenance,
  sameResearchIdentity,
} from "./research-provenance";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

describe("research provenance", () => {
  it("canonicalizes object keys without changing array order", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: [3, 1] } })).toBe('{"a":{"x":[3,1],"y":2},"z":1}');
  });

  it("changes the contract identity when a consumed option changes", () => {
    const common = {
      repoRoot: REPO_ROOT,
      studyId: "provenance-spec",
      protocolVersion: 1,
      sourceFiles: ["benchmarks/research-provenance.ts"],
    } as const;
    const first = collectResearchProvenance({ ...common, contract: { budget: 1 } });
    const second = collectResearchProvenance({ ...common, contract: { budget: 2 } });

    expect(first.version).toBe(2);
    expect(first.runtime.node).toBe(process.version);
    expect(first.runtime.v8).toBe(process.versions.v8);
    expect(first.runtime.os.release.length).toBeGreaterThan(0);
    expect(first.runtime.cpu.logicalCores).toBeGreaterThan(0);
    expect(first.contractSha256).not.toBe(second.contractSha256);
    expect(sameResearchIdentity(first, second)).toBe(false);
  });

  it("rejects legacy, duplicate, and mismatched reports unless replacement is explicit", () => {
    const provenance = collectResearchProvenance({
      repoRoot: REPO_ROOT,
      studyId: "provenance-spec",
      protocolVersion: 1,
      contract: { fixture: "small" },
      sourceFiles: ["benchmarks/research-provenance.ts"],
    });
    const changed = { ...provenance, contractSha256: "different" };

    expect(() => assertResearchReportCanBeWritten({}, provenance, false)).toThrow(/legacy/u);
    expect(() => assertResearchReportCanBeWritten({ provenance }, provenance, false)).toThrow(
      /identical/u,
    );
    expect(() => assertResearchReportCanBeWritten({ provenance }, changed, false)).toThrow(
      /different research contract/u,
    );
    expect(() => assertResearchReportCanBeWritten({ provenance }, changed, true)).not.toThrow();
  });

  it("fingerprints source bytes rather than file timestamps", () => {
    const directory = mkdtempSync(join(tmpdir(), "research-provenance-"));
    const sourcePath = join(directory, "source.txt");
    const common = {
      repoRoot: REPO_ROOT,
      studyId: "provenance-spec",
      protocolVersion: 1,
      contract: { fixture: "source-bytes" },
      sourceFiles: [sourcePath],
    } as const;
    writeFileSync(sourcePath, "first", "utf8");
    const first = collectResearchProvenance(common);
    writeFileSync(sourcePath, "second", "utf8");
    const second = collectResearchProvenance(common);

    expect(first.sourceFingerprint).not.toBe(second.sourceFingerprint);
    expect(first.sourceFiles[0]?.sha256).not.toBe(second.sourceFiles[0]?.sha256);
  });
});
