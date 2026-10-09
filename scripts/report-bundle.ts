import { readdir, readFile, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import {
  assertCertifiedHtmlBoundary,
  type CertifiedBundleBoundary,
  WORKER_SOURCE_KINDS,
  type WorkerChunkGraph,
} from "./certified-bundle-boundary.ts";

const gzipAsync = promisify(gzip);
const root = new URL("../", import.meta.url);
const distDir = new URL("../dist/", import.meta.url);
const manifestFile = new URL("../dist/.vite/manifest.json", import.meta.url);
const wasmFile = new URL("../public/solver_rs.wasm", import.meta.url);
const rootPath = fileURLToPath(root);

const REQUIRED_LAZY_ROOTS = {
  "src/certifiedUi/CertifiedCalculator.tsx": "lazy-certified",
  "src/components/StatsPanelBody.tsx": "lazy-stats",
  "src/schemas.ts": "lazy-stats",
  "src/components/SuccessAttemptModal.tsx": "lazy-interaction",
  "src/components/RecommendationContent.tsx": "lazy-interaction",
} as const;
const OPTIONAL_LAZY_ROOTS = {
  "src/components/DetailPanel.tsx": "lazy-detail",
  "src/lib/statsErrorResponse.ts": "lazy-stats",
  "src/lib/statsDeliveryHealth.ts": "lazy-stats",
  "src/lib/turnstileScriptLoader.ts": "lazy-stats",
  "src/solver/solve.ts": "lazy-solver",
  "shared/generated/supplyForecastRuntime.ts": "lazy-forecast",
  "src/lib/demoStats.ts": "lazy-stats",
  "src/lib/statsView.ts": "lazy-stats",
  "src/lib/legacyInputRecovery.ts": "lazy-interaction",
} as const;

type BundleKind =
  | "initial-js"
  | "lazy-certified"
  | "lazy-detail"
  | "lazy-forecast"
  | "lazy-solver"
  | "lazy-stats"
  | "lazy-interaction"
  | "worker"
  | "certified-worker"
  | "css"
  | "wasm"
  | "certified-wasm"
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

function assertWorkerChunkAsset(file: string, available: Set<string>) {
  if (
    extname(file) !== ".js" ||
    file.includes("\\") ||
    file.includes(":") ||
    file.split("/").some((segment) => !segment || segment === "." || segment === "..")
  )
    throw new Error(`worker_chunk_path_invalid:${file}`);
  if (!available.has(file)) throw new Error(`Worker chunk asset is missing: ${file}`);
}

function workerGraphFiles(graph: WorkerChunkGraph, available: Set<string>): Set<string> {
  if (graph.version !== "worker-chunk-graph-v1")
    throw new Error(`worker_chunk_ownership_version:${graph.source}`);
  const chunks = new Map(graph.chunks.map((chunk) => [chunk.file, chunk]));
  if (chunks.size !== graph.chunks.length)
    throw new Error(`worker_chunk_ownership_duplicate:${graph.source}`);
  for (const file of chunks.keys()) assertWorkerChunkAsset(file, available);
  const reachable = new Set<string>();
  const visit = (file: string) => {
    if (reachable.has(file)) return;
    const chunk = chunks.get(file);
    if (!chunk) throw new Error(`worker_chunk_graph_missing:${file}`);
    reachable.add(file);
    for (const dependency of [...chunk.imports, ...chunk.dynamicImports]) visit(dependency);
  };
  visit(graph.entryFile);
  if (reachable.size !== chunks.size)
    throw new Error(`worker_chunk_ownership_unreachable:${graph.source}`);
  return reachable;
}

export function classifyUnmappedJavaScript(
  files: readonly string[],
  classifications: Map<string, BundleKind>,
  perWorker: readonly WorkerChunkGraph[],
) {
  if (!Array.isArray(perWorker as unknown)) throw new Error("worker_chunk_ownership_missing");
  const sources = perWorker.map((graph) => graph.source);
  if (
    sources.length !== Object.keys(WORKER_SOURCE_KINDS).length ||
    new Set(sources).size !== sources.length ||
    sources.some((source) => !Object.hasOwn(WORKER_SOURCE_KINDS, source))
  )
    throw new Error(`worker_source_ownership_invalid:${sources.join(",")}`);
  const available = new Set(files);
  const owned = new Map<string, "worker" | "certified-worker">();
  for (const graph of perWorker) {
    const kind = WORKER_SOURCE_KINDS[graph.source];
    for (const file of workerGraphFiles(graph, available)) {
      // A chunk shared by both workers receives the stricter display category.
      // Totals below still charge the complete graph to each owning worker.
      if (!owned.has(file) || kind === "certified-worker") owned.set(file, kind);
    }
  }
  for (const path of files) {
    if (extname(path) !== ".js" || classifications.has(path)) continue;
    const kind = owned.get(path);
    if (!kind) throw new Error(`JavaScript asset is not classified: ${path}`);
    classifications.set(path, kind);
  }
}

function kindFor(path: string, classifications: Map<string, BundleKind>): BundleKind {
  const classified = classifications.get(path);
  if (classified) return classified;
  if (extname(path) === ".css") return "css";
  if (path === "certified_solver.wasm") return "certified-wasm";
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

export function bundleTotals(entries: BundleEntry[], perWorker: readonly WorkerChunkGraph[]) {
  const byKind = new Map<string, { rawBytes: number; gzipBytes: number }>();
  for (const entry of entries) {
    const bucket = byKind.get(entry.kind) || { rawBytes: 0, gzipBytes: 0 };
    bucket.rawBytes += entry.rawBytes;
    bucket.gzipBytes += entry.gzipBytes;
    byKind.set(entry.kind, bucket);
  }
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const [source, kind] of Object.entries(WORKER_SOURCE_KINDS)) {
    const graph = perWorker.find((worker) => worker.source === source);
    if (!graph) throw new Error(`worker_chunk_ownership_missing:${source}`);
    const bucket = { rawBytes: 0, gzipBytes: 0 };
    for (const file of new Set(graph.chunks.map((chunk) => chunk.file))) {
      const entry = byPath.get(`dist/${file}`);
      if (!entry) throw new Error(`Worker chunk asset is missing: ${file}`);
      bucket.rawBytes += entry.rawBytes;
      bucket.gzipBytes += entry.gzipBytes;
    }
    byKind.set(kind, bucket);
  }
  return Object.fromEntries(byKind);
}

async function main() {
  if (!(await fileExists(distDir)) || !(await fileExists(manifestFile))) {
    throw new Error(
      "dist manifest does not exist. Run npm run build before npm run report:bundle.",
    );
  }

  const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as Manifest;
  const distFiles = await collectFiles(distDir);
  const boundary = JSON.parse(
    await readFile(new URL(".vite/certified-boundary.json", distDir), "utf8"),
  ) as CertifiedBundleBoundary;
  if (boundary.version !== "certified-initial-boundary-v1")
    throw new Error("certified_initial_boundary_missing");
  await Promise.all(
    distFiles
      .filter((file) => file.pathname.endsWith(".html"))
      .map(async (file) => {
        assertCertifiedHtmlBoundary(
          await readFile(file, "utf8"),
          relative(fileURLToPath(distDir), fileURLToPath(file)).replaceAll("\\", "/"),
          boundary.certifiedFiles,
        );
      }),
  );
  const classifications = manifestClassifications(manifest);
  classifyUnmappedJavaScript(
    distFiles.map((file) =>
      relative(fileURLToPath(distDir), fileURLToPath(file)).replaceAll("\\", "/"),
    ),
    classifications,
    boundary.perWorker,
  );
  const entries = await Promise.all(distFiles.map((file) => entryFor(file, classifications)));
  if (!entries.some((entry) => entry.kind === "wasm") && (await fileExists(wasmFile))) {
    entries.push(await entryFor(wasmFile, classifications));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    certifiedBoundary: boundary,
    entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
    totals: bundleTotals(entries, boundary.perWorker),
  };

  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
