import { gzip } from "node:zlib";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);
const root = new URL("../", import.meta.url);
const distDir = new URL("../dist/", import.meta.url);
const wasmFile = new URL("../public/solver_rs.wasm", import.meta.url);
const rootPath = fileURLToPath(root);

type BundleEntry = {
  path: string;
  kind: "initial-js" | "lazy-detail" | "lazy-stats" | "worker" | "css" | "wasm" | "asset";
  rawBytes: number;
  gzipBytes: number;
};

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
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(child)));
    } else {
      files.push(child);
    }
  }
  return files;
}

function kindFor(pathname: string): BundleEntry["kind"] {
  const ext = extname(pathname);
  const name = basename(pathname);
  if (ext === ".js" && /^worker-/.test(name)) return "worker";
  if (ext === ".js" && /^DetailPanel-/.test(name)) return "lazy-detail";
  if (ext === ".js" && /^(StatsPanelBody|schemas)-/.test(name)) return "lazy-stats";
  if (ext === ".js") return "initial-js";
  if (ext === ".css") return "css";
  if (ext === ".wasm") return "wasm";
  return "asset";
}

async function entryFor(file: URL): Promise<BundleEntry> {
  const bytes = await readFile(file);
  const gzipped = await gzipAsync(bytes);
  return {
    path: relative(rootPath, fileURLToPath(file)).replace(/\\/g, "/"),
    kind: kindFor(file.pathname),
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

if (!(await fileExists(distDir))) {
  throw new Error("dist/ does not exist. Run npm run build before npm run report:bundle.");
}

const distFiles = await collectFiles(distDir);
const entries = await Promise.all(distFiles.map(entryFor));
if (!entries.some((entry) => entry.kind === "wasm") && (await fileExists(wasmFile))) {
  entries.push(await entryFor(wasmFile));
}

const report = {
  generatedAt: new Date().toISOString(),
  entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
  totals: totals(entries),
};

console.log(JSON.stringify(report, null, 2));
