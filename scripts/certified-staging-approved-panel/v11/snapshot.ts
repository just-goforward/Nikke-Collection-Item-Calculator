import assert from "node:assert/strict";
import { build } from "esbuild";
import { pinnedBytes, sourceIdentity } from "../v6/history.ts";
import type { productInput } from "./product-input.ts";

export async function prepareSnapshot() {
  pinnedBytes({
    path: "scripts/certified-staging-approved-panel/v10/fixtures/input.ts",
    sha256: "83fa603a978a5026e7c0decfe4c718070b07b903652d56ee088784f195e13831",
  });
  const result = await build({
    entryPoints: ["scripts/certified-staging-approved-panel/v11/product-input.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const before = sourceIdentity(Object.keys(result.metafile.inputs).sort());
  const output = result.outputFiles[0];
  assert.ok(output);
  const module = (await import(
    `data:text/javascript;base64,${Buffer.from(output.contents).toString("base64")}`
  )) as { productInput: typeof productInput };
  const snapshot = await module.productInput();
  assert.deepEqual(sourceIdentity(before.sources.map(({ path }) => path)), before);
  return { snapshot, sources: before.sources };
}
