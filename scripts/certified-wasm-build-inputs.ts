import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

/** One source manifest for the builder and freshness guard. Artifact bytes
 * alone cannot prove that the pinned binary was rebuilt after a Rust edit. */
export function certifiedWasmBuildInputs(root: URL) {
  const paths = ["scripts/build-certified-wasm.ts", "scripts/certified-wasm-build-inputs.ts"];
  const visit = (directory: string) => {
    for (const entry of readdirSync(new URL(directory, root), { withFileTypes: true })) {
      if (entry.name === "target") continue;
      const path = `${directory}${entry.name}`;
      if (entry.isDirectory()) visit(`${path}/`);
      else paths.push(path);
    }
  };
  visit("rust/certified/");
  const sources = paths.sort().map((path) => ({
    path,
    sha256: createHash("sha256")
      .update(readFileSync(new URL(path, root)))
      .digest("hex"),
  }));
  return { sources, hash: createHash("sha256").update(JSON.stringify(sources)).digest("hex") };
}

/** Product builds consume pinned bytes, never invoke Cargo or rewrite identity. */
export function assertCertifiedWasmBuild(root: URL) {
  const bytes = readFileSync(new URL("public/certified_solver.wasm", root));
  const hash = createHash("sha256").update(bytes).digest("hex");
  const generated = readFileSync(new URL("shared/generated/certifiedWasmBuild.ts", root), "utf8");
  if (!generated.includes(`CERTIFIED_WASM_HASH = "${hash}"`))
    throw new Error("certified_wasm_hash_stale");
  const inputs = certifiedWasmBuildInputs(root);
  if (!generated.includes(`CERTIFIED_WASM_SOURCE_HASH = "${inputs.hash}"`))
    throw new Error("certified_wasm_source_stale: run npm run rebuild:certified-wasm");
  return { bytes: bytes.length, hash, inputs };
}
