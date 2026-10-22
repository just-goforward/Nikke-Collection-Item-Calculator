import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { CERTIFIED_ENGINE_CODE_HASH } from "../../../shared/generated/certifiedEngineBuild.ts";
import type { verifyEngines } from "./engine-check.ts";
import { readV11Evidence } from "./evidence.ts";
import { generatePublication } from "./generate.ts";

export async function dryRun() {
  const root = mkdtempSync(resolve(tmpdir(), "certified-v11-fixed123-"));
  const generated = await generatePublication(root);
  const evidence = readV11Evidence(root, generated.anchor, CERTIFIED_ENGINE_CODE_HASH);
  const compiled = await build({
    entryPoints: ["scripts/certified-staging-approved-panel/v11/engine-check.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  const output = compiled.outputFiles[0];
  assert.ok(output);
  const engine = (await import(
    `data:text/javascript;base64,${Buffer.from(output.contents).toString("base64")}`
  )) as { verifyEngines: typeof verifyEngines };
  const cases = await engine.verifyEngines(evidence.snapshot, evidence.panel.cases);
  return {
    ...generated,
    cases,
    verified: true,
    enginesCompared: ["typescript", "wasm"],
    sealed: false,
    waitingProof: evidence.panel.boundaries.waitingProof,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 2, "Dry-run takes no destination or seal arguments");
  console.log(JSON.stringify(await dryRun()));
}
