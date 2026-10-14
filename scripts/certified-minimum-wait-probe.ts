import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { CertifiedInput } from "../src/certified/types.ts";

/** stdin: {id:string,input:CertifiedInput}, or an array of those records.
 * stdout: the same cardinality of comparison records. The input must be a v2
 * snapshot; batchLimit defaults to the product's 10. No expected values are read.
 */
export async function runMinimumWaitProbe(payload: unknown) {
  // App sources contain TypeScript parameter properties, unsupported by Node's
  // strip-only loader. Reuse the project's esbuild API, without writing a bundle.
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL("../src/certified/minimumWaitProbe.ts", import.meta.url))],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    packages: "external",
    logLevel: "silent",
  });
  const output = bundled.outputFiles[0];
  if (!output) throw new Error("minimum_wait_probe_bundle_missing");
  const { probeCertifiedMinimumWait }: typeof import("../src/certified/minimumWaitProbe.ts") =
    await import(`data:text/javascript;base64,${Buffer.from(output.contents).toString("base64")}`);
  const module = await WebAssembly.compile(
    readFileSync(new URL("../public/certified_solver.wasm", import.meta.url)),
  );
  const records = Array.isArray(payload) ? payload : [payload];
  const results = records.map((record: unknown) => {
    if (!record || typeof record !== "object" || Array.isArray(record))
      throw new TypeError("minimum_wait_probe_record_required");
    const id: unknown = Reflect.get(record, "id");
    const input: unknown = Reflect.get(record, "input");
    if (typeof id !== "string" || !id || !input || typeof input !== "object")
      throw new TypeError("minimum_wait_probe_record_required");
    return { id, ...probeCertifiedMinimumWait(module, input as CertifiedInput) };
  });
  return Array.isArray(payload) ? results : results[0];
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.stdout.write(
    `${JSON.stringify(await runMinimumWaitProbe(JSON.parse(readFileSync(0, "utf8"))))}\n`,
  );
}
