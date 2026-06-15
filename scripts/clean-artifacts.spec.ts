import { describe, expect, it } from "vitest";
import {
  ARTIFACT_TARGETS,
  plannedArtifactRemovals,
  shouldApplyCleanArtifacts,
} from "./clean-artifacts.ts";

describe("clean artifacts", () => {
  it("keeps generated artifact targets explicit", () => {
    expect(ARTIFACT_TARGETS).toContain("dist");
    expect(ARTIFACT_TARGETS).toContain("test-results");
    expect(ARTIFACT_TARGETS).toContain("benchmarks/results");
    expect(ARTIFACT_TARGETS).toContain("public/solver_rs.wasm");
  });

  it("does not plan removal of tracked files", () => {
    const planned = plannedArtifactRemovals(["dist", "CHANGELOG.md", "public/solver_rs.wasm"], {
      exists: () => true,
      tracked: new Set(["CHANGELOG.md", "dist/keep.txt"]),
    });

    expect(planned).toEqual(["public/solver_rs.wasm"]);
  });

  it("lets dry-run override apply for safer manual checks", () => {
    expect(shouldApplyCleanArtifacts(["node", "scripts/clean-artifacts.ts", "--apply"])).toBe(true);
    expect(shouldApplyCleanArtifacts(["node", "scripts/clean-artifacts.ts", "--dry-run"])).toBe(
      false,
    );
    expect(
      shouldApplyCleanArtifacts(["node", "scripts/clean-artifacts.ts", "--apply", "--dry-run"]),
    ).toBe(false);
  });
});
