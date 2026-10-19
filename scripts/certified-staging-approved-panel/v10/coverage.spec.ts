import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { assertCoverageMatchesV10Publication } from "./coverage-test-helper.ts";
import { generatePublication } from "./generate.ts";

it("binds each coverage field to independently authenticated evidence", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "v10-coverage-"));
  const { anchor, engineBuildHash } = await generatePublication(root);
  const tuple = {
    cadenceVersion: "observed-median-v2",
    engineBuildHash,
    panelAnchorSha256: anchor,
  };
  expect(() => assertCoverageMatchesV10Publication(tuple, root, anchor, engineBuildHash)).not.toThrow();
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
