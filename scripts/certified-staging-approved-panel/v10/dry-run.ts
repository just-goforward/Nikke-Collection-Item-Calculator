import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CERTIFIED_ENGINE_CODE_HASH } from "../../../shared/generated/certifiedEngineBuild.ts";
import { readV10Evidence } from "./evidence.ts";
import { generatePublication } from "./generate.ts";

export async function dryRun() {
  const root = mkdtempSync(resolve(tmpdir(), "v10-dry-run-"));
  const generated = await generatePublication(root);
  const evidence = readV10Evidence(root, generated.anchor, CERTIFIED_ENGINE_CODE_HASH);
  return {
    ...generated,
    cases: evidence.panel.cases.length,
    verified: true,
    sealed: false,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 2, "Dry-run takes no destination or seal arguments");
  console.log(JSON.stringify(await dryRun()));
}
