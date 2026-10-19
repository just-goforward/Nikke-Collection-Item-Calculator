import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { expect, it } from "vitest";
import { CERTIFIED_ENGINE_CODE_HASH } from "../../../shared/generated/certifiedEngineBuild.ts";
import { PUBLICATION_FILES } from "./evidence.ts";

it("runs the dry-run CLI against the current engine in a uniquely allocated directory", () => {
  const output = execFileSync(
    process.execPath,
    ["scripts/certified-staging-approved-panel/v10/dry-run.ts"],
    { encoding: "utf8", timeout: 180_000 },
  );
  const result = JSON.parse(output);
  expect(result).toMatchObject({
    engineBuildHash: CERTIFIED_ENGINE_CODE_HASH,
    cases: 24,
    verified: true,
    sealed: false,
  });
  expect(readdirSync(result.root).sort()).toEqual([...PUBLICATION_FILES].sort());
}, 180_000);
