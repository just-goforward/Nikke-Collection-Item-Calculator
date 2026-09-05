import { readdir, readFile, stat } from "node:fs/promises";
import { extname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

const gzipAsync = promisify(gzip);
const root = new URL("../", import.meta.url);
const distDir = new URL("../dist/", import.meta.url);
const manifestFile = new URL("../dist/.vite/manifest.json", import.meta.url);
const wasmFile = new URL("../public/solver_rs.wasm", import.meta.url);
const rootPath = fileURLToPath(root);

const REQUIRED_LAZY_ROOTS = {
  "src/components/StatsPanelBody.tsx": "lazy-stats",
  "src/schemas.ts": "lazy-stats",
} as const;
const OPTIONAL_LAZY_ROOTS = {
  "src/components/DetailPanel.tsx": "lazy-detail",
  "src/lib/statsErrorResponse.ts": "lazy-stats",
  "src/lib/statsDeliveryHealth.ts": "lazy-stats",
  "src/lib/turnstileScriptLoader.ts": "lazy-stats",
  "src/solver/solve.ts": "lazy-solver",
  "shared/generated/supplyForecastRuntime.ts": "lazy-forecast",
} as const;

type BundleKind =
  | "initial-js"
  | "lazy-detail"
  | "lazy-forecast"
  | "lazy-solver"
  | "lazy-stats"
  | "worker"
  | "css"
  | "wasm"
  | "asset";

type BundleEntry = {
  path: string;
  kind: BundleKind;
  rawBytes: number;
  gzipBytes: number;
};

type ManifestChunk = {
  css?: string[];
  dynamicImports?: string[];
  file: string;
  imports?: string[];
  isDynamicEntry?: boolean;
  isEntry?: boolean;
  src?: string;
};

type Manifest = Record<string, ManifestChunk>;

async function fileExists(url: URL) {
  try {
    await stat(url);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(dir: URL): Promise<URL[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: URL[] = [];
  for (const entry of entries) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
    if (entry.isDirectory()) files.push(...(await collectFiles(child)));
    else files.push(child);
  }
  return files;
}

function collectStaticImports(manifest: Manifest, rootKey: string, output = new Set<string>()) {
  if (output.has(rootKey)) return output;
  const chunk = manifest[rootKey];
  if (!chunk) throw new Error(`Bundle manifest import is missing: ${rootKey}`);
  output.add(rootKey);
  for (const imported of chunk.imports ?? []) collectStaticImports(manifest, imported, output);
  return output;
}

function addChunkFiles(
  manifest: Manifest,
  keys: Iterable<string>,
  kind: BundleKind,
  classifications: Map<string, BundleKind>,
  initialFiles: Set<string>,
) {
  for (const key of keys) {
    const chunk = manifest[key];
    if (!chunk) throw new Error(`Bundle manifest chunk is missing: ${key}`);
    if (initialFiles.has(chunk.file) && kind !== "initial-js") continue;
    if (!classifications.has(chunk.file)) classifications.set(chunk.file, kind);
  }
}

function manifestClassifications(manifest: Manifest) {
  const entryKeys = Object.entries(manifest)
    .filter(([, chunk]) => chunk.isEntry)
    .map(([key]) => key);
  if (entryKeys.length !== 1) {
    throw new Error(
      `Expected exactly one app entry in the Vite manifest, found ${entryKeys.length}.`,
    );
  }
  const entryKey = entryKeys[0];
  if (!entryKey) throw new Error("Vite manifest app entry is missing.");

  const classifications = new Map<string, BundleKind>();
  const initialKeys = collectStaticImports(manifest, entryKey);
  const initialFiles = new Set(
    [...initialKeys].map((key) => {
      const chunk = manifest[key];
      if (!chunk) throw new Error(`Initial bundle chunk is missing: ${key}`);
      return chunk.file;
    }),
  );
  addChunkFiles(manifest, initialKeys, "initial-js", classifications, initialFiles);

  for (const [rootKey, kind] of Object.entries(REQUIRED_LAZY_ROOTS)) {
    const chunk = manifest[rootKey];
    if (!chunk?.isDynamicEntry) {
      throw new Error(`Required lazy boundary is missing from the Vite manifest: ${rootKey}`);
    }
    if (initialFiles.has(chunk.file)) {
      throw new Error(`Required lazy boundary collapsed into the initial graph: ${rootKey}`);
    }
    addChunkFiles(
      manifest,
      collectStaticImports(manifest, rootKey),
      kind,
      classifications,
      initialFiles,
    );
  }

  for (const [rootKey, kind] of Object.entries(OPTIONAL_LAZY_ROOTS)) {
    const chunk = manifest[rootKey];
    if (!chunk) continue;
    if (initialFiles.has(chunk.file)) continue;
    addChunkFiles(
      manifest,
      collectStaticImports(manifest, rootKey),
      kind,
      classifications,
      initialFiles,
    );
  }

  for (const css of manifest[entryKey]?.css ?? []) classifications.set(css, "css");
  return classifications;
}

function classifyUnmappedJavaScript(files: URL[], classifications: Map<string, BundleKind>) {
  const unmapped = files
    .map((file) => relative(fileURLToPath(distDir), fileURLToPath(file)).replace(/\\/g, "/"))
    .filter((path) => extname(path) === ".js" && !classifications.has(path));
  const workerEntries = unmapped.filter((path) => /(^|\/)worker-[^/]+\.js$/.test(path));
  if (unmapped.length === 0 || workerEntries.length !== 1) {
    throw new Error(
      `Expected one Worker entry outside the app manifest, found ${workerEntries.length} among: ${unmapped.join(", ")}`,
    );
  }
  for (const workerFile of unmapped) classifications.set(workerFile, "worker");
}

function kindFor(path: string, classifications: Map<string, BundleKind>): BundleKind {
  const classified = classifications.get(path);
  if (classified) return classified;
  if (extname(path) === ".css") return "css";
  if (extname(path) === ".wasm") return "wasm";
  if (extname(path) === ".js") throw new Error(`JavaScript asset is not classified: ${path}`);
  return "asset";
}

async function entryFor(file: URL, classifications: Map<string, BundleKind>): Promise<BundleEntry> {
  const bytes = await readFile(file);
  const gzipped = await gzipAsync(bytes);
  const path = relative(rootPath, fileURLToPath(file)).replace(/\\/g, "/");
  const distPath = relative(fileURLToPath(distDir), fileURLToPath(file)).replace(/\\/g, "/");
  return {
    path,
    kind: kindFor(distPath, classifications),
    rawBytes: bytes.byteLength,
    gzipBytes: gzipped.byteLength,
  };
}

function totals(entries: BundleEntry[]) {
  const byKind = new Map<string, { rawBytes: number; gzipBytes: number }>();
  for (const entry of entries) {
    const bucket = byKind.get(entry.kind) || { rawBytes: 0, gzipBytes: 0 };
    bucket.rawBytes += entry.rawBytes;
    bucket.gzipBytes += entry.gzipBytes;
    byKind.set(entry.kind, bucket);
  }
  return Object.fromEntries(byKind);
}

if (!(await fileExists(distDir)) || !(await fileExists(manifestFile))) {
  throw new Error("dist manifest does not exist. Run npm run build before npm run report:bundle.");
}

const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as Manifest;
const distFiles = await collectFiles(distDir);
const classifications = manifestClassifications(manifest);
classifyUnmappedJavaScript(distFiles, classifications);
const entries = await Promise.all(distFiles.map((file) => entryFor(file, classifications)));
if (!entries.some((entry) => entry.kind === "wasm") && (await fileExists(wasmFile))) {
  entries.push(await entryFor(wasmFile, classifications));
}

const report = {
  generatedAt: new Date().toISOString(),
  entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
  totals: totals(entries),
};

console.log(JSON.stringify(report, null, 2));
