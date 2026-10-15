import assert from "node:assert/strict";
import { build } from "esbuild";
import type { CertifiedSupplySnapshot } from "../../../shared/certifiedSupply.ts";
import { sourceIdentity } from "../v6/history.ts";
import { assertV3Snapshot } from "./evidence.ts";

/** Wednesday 17:00 KST, after that day's 05:00 weekly grant: the first Wednesday on
 * which the v3 rule is in force. The v7 asOf (2026-09-30) predates the v3 rule. */
export const V8_AS_OF = "2026-10-14T08:00:00.000Z";

/** Product reconstruction supplies only the approved INPUT. Deliberately outside the
 * independent calculator's runtime closure. */
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
  const snapshot = await module.prepareCertifiedForecast(V8_AS_OF);
  assertV3Snapshot(snapshot);
  return { snapshot, sources: sourceIdentity(Object.keys(result.metafile.inputs).sort()).sources };
}
