import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type RustCrateLicense = { name: string; version: string; license: string };
/** A license or copyright file shipped in the crate source, captured verbatim (LF newlines). */
export type RustLicenseText = { file: string; text: string };
export type RustShippedCrate = RustCrateLicense & { texts: RustLicenseText[] };
export type RustWasmLicenseManifest = {
  /** Crates compiled into the shipped WASM (normal edges, proc-macros excluded). */
  crates: RustShippedCrate[];
  /** Locked crates that only run at compile time (proc-macros, build scripts and their deps). */
  buildOnly: RustCrateLicense[];
};

const ROOT = resolve(import.meta.dirname, "..");
export const RUST_WASM_CRATE_DIRS = ["rust/certified", "rust/solver-rs"] as const;
export const RUST_WASM_LICENSE_MANIFEST = resolve(ROOT, "shared/legal/rust-wasm-licenses.json");

const TREE_LINE = /^(\S+) v(\S+)(?: \(proc-macro\))?\|(.*?)(?: \(\*\))?$/;

function cargoTree(crateDir: string, edges: string): RustCrateLicense[] {
  const result = spawnSync(
    "cargo",
    ["tree", "-e", edges, "--locked", "--offline", "--prefix", "none", "--format", "{p}|{l}"],
    { cwd: resolve(ROOT, crateDir), encoding: "utf8" },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`cargo tree failed in ${crateDir}: ${result.error?.message ?? result.stderr}`);
  }
  // The first line is the workspace crate itself.
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(1)
    .map((line) => {
      const match = TREE_LINE.exec(line.trim());
      if (!match?.[1] || !match[2] || !match[3]) {
        throw new Error(`Unlicensed or unparseable cargo tree line in ${crateDir}: ${line}`);
      }
      return { name: match[1], version: match[2], license: match[3] };
    });
}

function uniqueSorted<T extends RustCrateLicense>(crates: readonly T[]) {
  const byId = new Map(crates.map((crate) => [`${crate.name}@${crate.version}`, crate]));
  return [...byId.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, crate]) => crate);
}

export const LICENSE_TEXT_FILE = /^(?:LICENSE|COPYING|UNLICENSE|NOTICE)/i;

/** Source directory of every locked package, keyed by `name@version`, from `cargo metadata`. */
function crateSourceDirs(crateDir: string) {
  const result = spawnSync(
    "cargo",
    ["metadata", "--format-version", "1", "--locked", "--offline"],
    { cwd: resolve(ROOT, crateDir), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `cargo metadata failed in ${crateDir}: ${result.error?.message ?? result.stderr}`,
    );
  }
  const metadata = JSON.parse(result.stdout) as {
    packages: { name: string; version: string; manifest_path: string }[];
  };
  return new Map(
    metadata.packages.map((pkg) => [`${pkg.name}@${pkg.version}`, dirname(pkg.manifest_path)]),
  );
}

function licenseTexts(crate: RustCrateLicense, sourceDir: string | undefined): RustLicenseText[] {
  if (!sourceDir) throw new Error(`No source directory for ${crate.name}@${crate.version}`);
  const texts = readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_TEXT_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((file) => ({
      file,
      text: readFileSync(resolve(sourceDir, file), "utf8").replace(/\r\n?/g, "\n").trimEnd(),
    }));
  if (texts.length === 0) {
    throw new Error(`${crate.name}@${crate.version} ships no LICENSE/COPYING/NOTICE text`);
  }
  return texts;
}

export function collectRustWasmLicenses(): RustWasmLicenseManifest {
  const sourceDirs = new Map(
    RUST_WASM_CRATE_DIRS.flatMap((dir) => [...crateSourceDirs(dir).entries()]),
  );
  const compiled = uniqueSorted(
    RUST_WASM_CRATE_DIRS.flatMap((dir) => cargoTree(dir, "normal,no-proc-macro")),
  ).map((crate) => ({
    ...crate,
    texts: licenseTexts(crate, sourceDirs.get(`${crate.name}@${crate.version}`)),
  }));
  const compiledIds = new Set(compiled.map((crate) => `${crate.name}@${crate.version}`));
  const buildOnly = uniqueSorted(
    RUST_WASM_CRATE_DIRS.flatMap((dir) => cargoTree(dir, "normal,build")).filter(
      (crate) => !compiledIds.has(`${crate.name}@${crate.version}`),
    ),
  );
  return { crates: compiled, buildOnly };
}

export function serializeRustWasmLicenses(manifest: RustWasmLicenseManifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export async function readRustWasmLicenses(): Promise<RustWasmLicenseManifest> {
  const manifest = JSON.parse(
    await readFile(RUST_WASM_LICENSE_MANIFEST, "utf8"),
  ) as RustWasmLicenseManifest;
  if (!Array.isArray(manifest.crates) || manifest.crates.length === 0) {
    throw new Error("Rust WASM license manifest is empty; run npm run generate:rust-wasm-licenses");
  }
  for (const crate of manifest.crates) {
    if (!crate.texts?.length || crate.texts.some((entry) => !entry.text.trim())) {
      throw new Error(`Rust WASM license manifest lacks license text for ${crate.name}`);
    }
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (mode !== "--check" && mode !== "--write") {
    throw new Error("Usage: node scripts/rust-wasm-licenses.ts --check|--write");
  }
  const expected = serializeRustWasmLicenses(collectRustWasmLicenses());
  if (mode === "--write") {
    await writeFile(RUST_WASM_LICENSE_MANIFEST, expected);
  } else if ((await readFile(RUST_WASM_LICENSE_MANIFEST, "utf8")) !== expected) {
    throw new Error(
      "shared/legal/rust-wasm-licenses.json is stale; run npm run generate:rust-wasm-licenses",
    );
  }
}
