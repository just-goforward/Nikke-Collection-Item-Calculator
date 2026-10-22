import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { expect, it } from "vitest";
import { CERTIFIED_ENGINE_CODE_HASH } from "../../../shared/generated/certifiedEngineBuild.ts";
import { PUBLICATION_FILES } from "./evidence.ts";

it("creates an authenticated draft outside the repository and checks both engines", () => {
  const result = JSON.parse(
    execFileSync(process.execPath, ["scripts/certified-staging-approved-panel/v11/dry-run.ts"], {
      encoding: "utf8",
      timeout: 180_000,
    }),
  );
  expect(result).toMatchObject({
    engineBuildHash: CERTIFIED_ENGINE_CODE_HASH,
    cases: 24,
    verified: true,
    enginesCompared: ["typescript", "wasm"],
    sealed: false,
    waitingProof: "UNVERIFIED_NOT_REGENERATED",
  });
  expect(readdirSync(result.root).sort()).toEqual([...PUBLICATION_FILES].sort());
}, 180_000);
