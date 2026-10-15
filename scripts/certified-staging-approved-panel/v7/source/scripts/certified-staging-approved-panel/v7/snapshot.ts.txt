import assert from "node:assert/strict";
import { build } from "esbuild";
import type { CertifiedSupplySnapshot } from "../../../shared/certifiedSupply.ts";
import { frozenApprovedSnapshot } from "../../certified-staging-approved-panel.ts";
import { sourceIdentity } from "../v6/history.ts";

/** Product reconstruction supplies only the approved INPUT. This module is
 * deliberately outside the independent expectation calculator's runtime closure. */
export async function prepareSnapshot() {
  const result = await build({
    entryPoints: ["src/lib/certifiedForecast.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  assert.equal(result.outputFiles.length, 1);
  const output = result.outputFiles[0];
  assert.ok(output);
  const module = (await import(
    `data:text/javascript;base64,${Buffer.from(output.contents).toString("base64")}`
  )) as { prepareCertifiedForecast: (asOf: string) => Promise<CertifiedSupplySnapshot> };
  const snapshot = await module.prepareCertifiedForecast(frozenApprovedSnapshot().asOf);
  assert.equal(snapshot.version, "certified-daily-v2");
  return { snapshot, sources: sourceIdentity(Object.keys(result.metafile.inputs).sort()).sources };
}
