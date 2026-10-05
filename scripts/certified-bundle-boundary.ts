import { relative } from "node:path";
import { transform } from "esbuild";
import type { Plugin } from "vite";

/** Retain syntax, names and legal comments; compact only the new Worker. */
export function certifiedWorkerWhitespacePlugin(): Plugin {
  return {
    name: "certified-worker-whitespace",
    apply: "build",
    enforce: "post",
    async generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (
          output.type !== "chunk" ||
          !output.isEntry ||
          !output.facadeModuleId
            ?.replaceAll("\\", "/")
            .endsWith("/src/certifiedRuntime/browserWorker.ts")
        )
          continue;
        output.code = (
          await transform(output.code, {
            minifyWhitespace: true,
            minifyIdentifiers: false,
            minifySyntax: false,
            legalComments: "inline",
            target: "es2022",
          })
        ).code;
      }
    },
  };
}

export type CertifiedBundleBoundary = {
  version: "certified-initial-boundary-v1";
  initialFiles: string[];
  initialModules: string[];
  certifiedFiles: string[];
  perWorker: WorkerChunkGraph[];
};
export const WORKER_SOURCE_KINDS = {
  "src/worker.ts": "worker",
  "src/certifiedRuntime/browserWorker.ts": "certified-worker",
} as const;
export type WorkerChunkGraph = {
  version: "worker-chunk-graph-v1";
  source: keyof typeof WORKER_SOURCE_KINDS;
  entryFile: string;
  chunks: { file: string; imports: string[]; dynamicImports: string[] }[];
};
const WORKER_GRAPH_PREFIX = ".vite/worker-boundary/";

/** Runs inside each Vite worker build, before its chunks become main-build assets. */
export function workerChunkGraphPlugin(): Plugin {
  let root = "";
  return {
    name: "worker-chunk-ownership",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      root = config.root;
    },
    generateBundle(_options, bundle) {
      const chunks = new Map(
        Object.values(bundle)
          .filter((output) => output.type === "chunk")
          .map((chunk) => [chunk.fileName, chunk]),
      );
      const entries = [...chunks.values()].filter((chunk) => chunk.isEntry);
      const entry = entries[0];
      if (entries.length !== 1 || !entry?.facadeModuleId)
        throw new Error("worker_entry_graph_missing");
      const source = relative(root, entry.facadeModuleId).replaceAll("\\", "/");
      if (!Object.hasOwn(WORKER_SOURCE_KINDS, source))
        throw new Error(`worker_source_not_registered:${source}`);
      const reachable = new Set<string>();
      const visit = (file: string) => {
        if (reachable.has(file)) return;
        const chunk = chunks.get(file);
        if (!chunk) throw new Error(`worker_chunk_graph_missing:${file}`);
        reachable.add(file);
        for (const dependency of [...chunk.imports, ...chunk.dynamicImports]) visit(dependency);
      };
      visit(entry.fileName);
      const graph: WorkerChunkGraph = {
        version: "worker-chunk-graph-v1",
        source: source as WorkerChunkGraph["source"],
        entryFile: entry.fileName,
        chunks: [...reachable].sort().map((file) => {
          const chunk = chunks.get(file);
          if (!chunk) throw new Error(`worker_chunk_graph_missing:${file}`);
          return {
            file,
            imports: [...chunk.imports].sort(),
            dynamicImports: [...chunk.dynamicImports].sort(),
          };
        }),
      };
      this.emitFile({
        type: "asset",
        fileName: `${WORKER_GRAPH_PREFIX}${source.replaceAll("/", "_")}.json`,
        source: JSON.stringify(graph),
      });
    },
  };
}

type Chunk = {
  fileName: string;
  isEntry: boolean;
  imports: string[];
  modules: Record<string, unknown>;
  facadeModuleId: string | null;
};

function certifiedModule(id: string): boolean {
  return /(?:^|\/)(?:src\/(?:certified|certifiedRuntime|certifiedUi)\/|src\/lib\/certifiedForecast[^/]*\.[^/]+|shared\/certified[^/]*\.[^/]+|shared\/generated\/certified[^/]*\.[^/]+)/.test(
    id.replaceAll("\\", "/"),
  );
}

function staticGraph(chunks: Map<string, Chunk>): Set<string> {
  const reachable = new Set<string>();
  const visit = (name: string) => {
    if (reachable.has(name)) return;
    const chunk = chunks.get(name);
    if (!chunk) throw new Error(`certified_initial_graph_missing:${name}`);
    reachable.add(name);
    for (const dependency of chunk.imports) if (chunks.has(dependency)) visit(dependency);
  };
  for (const chunk of chunks.values()) if (chunk.isEntry) visit(chunk.fileName);
  return reachable;
}

function moduleGraph(
  roots: readonly string[],
  info: (id: string) => { importedIds: readonly string[] } | null,
): string[] {
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    for (const imported of info(id)?.importedIds ?? []) visit(imported);
  };
  for (const root of roots) visit(root);
  return [...visited].sort();
}

function chunkRoots(chunk: Chunk): string[] {
  return [...Object.keys(chunk.modules), ...(chunk.facadeModuleId ? [chunk.facadeModuleId] : [])];
}

/** Scan every localized HTML file as well as the actual bundler module graph. */
export function assertCertifiedHtmlBoundary(
  html: string,
  htmlPath: string,
  certifiedFiles: readonly string[],
): void {
  const forbidden = new Set(certifiedFiles);
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\brel\s*=\s*["']modulepreload["']/i.test(tag[0])) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag[0])?.[1];
    if (!href) continue;
    const path = new URL(href, `https://certified-boundary.invalid/${htmlPath}`).pathname.slice(1);
    if (forbidden.has(path)) throw new Error(`certified_eager_modulepreload:${htmlPath}:${path}`);
  }
}

export function certifiedBundleBoundaryPlugin(): Plugin {
  return {
    name: "certified-initial-bundle-boundary",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const chunks = new Map<string, Chunk>();
      for (const output of Object.values(bundle))
        if (output.type === "chunk") chunks.set(output.fileName, output);
      const initialFiles = [...staticGraph(chunks)].sort();
      const initialRoots = initialFiles.flatMap((name) => {
        const chunk = chunks.get(name);
        return chunk ? chunkRoots(chunk) : [];
      });
      // Inlined constants can disappear from output.modules. Follow the actual
      // resolved static graph as well, preserving that dependency evidence.
      const initialModules = moduleGraph(initialRoots, (id) => this.getModuleInfo(id));
      const leaked = initialModules.filter(certifiedModule);
      if (leaked.length) throw new Error(`certified_eager_initial_modules:${leaked.join(",")}`);
      const certifiedFiles = [...chunks.values()]
        .filter((chunk) =>
          moduleGraph(chunkRoots(chunk), (id) => this.getModuleInfo(id)).some(certifiedModule),
        )
        .map((chunk) => chunk.fileName)
        .sort();
      for (const output of Object.values(bundle)) {
        if (output.type === "asset" && output.fileName.endsWith(".html")) {
          const html =
            typeof output.source === "string"
              ? output.source
              : new TextDecoder().decode(output.source);
          assertCertifiedHtmlBoundary(html, output.fileName, certifiedFiles);
        }
      }
      const boundary: CertifiedBundleBoundary = {
        version: "certified-initial-boundary-v1",
        initialFiles,
        initialModules,
        certifiedFiles,
        perWorker: Object.values(bundle)
          .filter(
            (output) => output.type === "asset" && output.fileName.startsWith(WORKER_GRAPH_PREFIX),
          )
          .map((output) => {
            if (output.type !== "asset") throw new Error("worker_chunk_graph_asset_missing");
            const source =
              typeof output.source === "string"
                ? output.source
                : new TextDecoder().decode(output.source);
            return JSON.parse(source) as WorkerChunkGraph;
          })
          .sort((a, b) => a.source.localeCompare(b.source)),
      };
      this.emitFile({
        type: "asset",
        fileName: ".vite/certified-boundary.json",
        source: JSON.stringify(boundary),
      });
    },
  };
}
