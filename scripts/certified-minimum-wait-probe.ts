import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { CertifiedInput } from "../src/certified/types.ts";

const PROBE_SOURCE = fileURLToPath(
  new URL("../src/certified/minimumWaitProbe.ts", import.meta.url),
);
/** Test-only historical mode: the product probe source, byte for byte, except that
 * its runtime-contract gate (current v3 only) is replaced by an explicit
 * certified-daily-v2 gate over the same structural snapshot validation. Every
 * kernel call is the product's. Each rewrite must match exactly once. */
const HISTORICAL_V2_REWRITES = [
  [
    "import { assertCertifiedRuntimeSupplySnapshot } from",
    "import { assertCertifiedSupplySnapshot } from",
  ],
  [
    "assertCertifiedRuntimeSupplySnapshot(input.snapshot);",
    'if (assertCertifiedSupplySnapshot(input.snapshot).version !== "certified-daily-v2") throw new Error("historical_probe_requires_certified_daily_v2");',
  ],
] as const;
export function historicalV2ProbeSource(source: string): string {
  return HISTORICAL_V2_REWRITES.reduce((text, [from, to]) => {
    if (text.split(from).length !== 2) throw new Error(`historical_probe_rewrite_drift:${from}`);
    return text.replace(from, to);
  }, source);
}
export type MinimumWaitProbeMode = "current" | "historical-v2";

/** stdin: {id:string,input:CertifiedInput}, or an array of those records.
 * stdout: the same cardinality of comparison records. The current mode accepts
 * only the runtime contract; `--historical-v2` accepts only certified-daily-v2.
 * batchLimit defaults to the product's 10. No expected values are read.
 */
export async function runMinimumWaitProbe(
  payload: unknown,
  mode: MinimumWaitProbeMode = "current",
) {
  // App sources contain TypeScript parameter properties, unsupported by Node's
  // strip-only loader. Reuse the project's esbuild API, without writing a bundle.
  const bundled = await build({
    entryPoints: [PROBE_SOURCE],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    packages: "external",
    logLevel: "silent",
    plugins:
      mode === "historical-v2"
        ? [
            {
              name: "historical-v2-probe-gate",
              setup(pluginBuild) {
                pluginBuild.onLoad({ filter: /[\\/]minimumWaitProbe\.ts$/ }, (args) => {
                  if (resolve(args.path) !== resolve(PROBE_SOURCE))
                    throw new Error("historical_probe_unexpected_source");
                  return {
                    contents: historicalV2ProbeSource(readFileSync(args.path, "utf8")),
                    loader: "ts",
                  };
                });
              },
            },
          ]
        : [],
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
  const flags = process.argv.slice(2);
  if (flags.some((flag) => flag !== "--historical-v2"))
    throw new Error("usage: certified-minimum-wait-probe.ts [--historical-v2] < records.json");
  const mode = flags.includes("--historical-v2") ? "historical-v2" : "current";
  process.stdout.write(
    `${JSON.stringify(await runMinimumWaitProbe(JSON.parse(readFileSync(0, "utf8")), mode))}\n`,
  );
}
