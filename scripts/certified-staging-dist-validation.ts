import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { relative, resolve, sep } from "node:path";
import { build, version as esbuildVersion } from "esbuild";
import type { CertifiedInput, CertifiedOutput } from "../src/certified/types.ts";
import { fileSha256 } from "./certified-staging-approved-panel.ts";

export const sha256Bytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export type DistAsset = { path: string; urlPath: string; bytes: number; sha256: string };
type ManifestEntry = { file: string; assets?: string[] };
export function inspectCertifiedDist(distDirectory = "dist") {
  const root = resolve(distDirectory);
  const manifestPath = resolve(root, ".vite/manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, ManifestEntry>;
  const certified = manifest["src/certifiedUi/CertifiedCalculator.tsx"];
  assert.ok(certified, "production manifest lacks certified client chunk");
  const workerPaths =
    certified.assets?.filter((path) => /^assets\/browserWorker-[^/]+\.js$/.test(path)) ?? [];
  assert.equal(
    workerPaths.length,
    1,
    "production manifest must identify exactly one certified Worker",
  );
  const workerPath = workerPaths[0];
  assert.ok(workerPath);
  const assets: DistAsset[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        assert.ok(entry.isFile(), "dist validation does not follow symbolic links");
        const bytes = readFileSync(path);
        assets.push({
          path,
          urlPath: `/${relative(root, path).split(sep).join("/")}`,
          bytes: bytes.length,
          sha256: sha256Bytes(bytes),
        });
      }
    }
  };
  walk(root);
  assets.sort((first, second) => first.urlPath.localeCompare(second.urlPath));
  const asset = (path: string) => {
    assert.match(path, /^assets\/[a-zA-Z0-9_.-]+$/);
    const result = assets.find((entry) => entry.urlPath === `/${path}`);
    assert.ok(result, `manifest asset missing: ${path}`);
    return result;
  };
  return {
    root,
    assets,
    worker: asset(workerPath),
    shippedClient: asset(certified.file),
    manifest: { path: manifestPath, sha256: fileSha256(manifestPath) },
    inventorySha256: sha256Bytes(
      Buffer.from(JSON.stringify(assets.map(({ path: _path, ...entry }) => entry))),
    ),
  };
}
function compiledSources(inputs: Record<string, unknown>, synthetic: string) {
  return Object.keys(inputs)
    .filter((path) => path !== synthetic)
    .sort()
    .map((path) => ({ path, sha256: fileSha256(path) }));
}
/** Compile a separately identified client adapter. Numerical Worker bytes are
 * served from dist unchanged; Worker/kernel modules cannot enter this build. */
export async function buildDistClientAdapter(workerUrl: string) {
  assert.match(workerUrl, /^\/assets\/browserWorker-[a-zA-Z0-9_-]+\.js$/);
  const sourcefile = "certified-dist-client-adapter.ts";
  const result = await build({
    stdin: {
      contents:
        "export {createBrowserCertifiedClient} from './src/certifiedRuntime/browserClient.ts';\nexport {CERTIFIED_STAGING_ENGINE_PROFILE} from './shared/certifiedEngineProfile.ts';\n",
      sourcefile,
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
    plugins: [
      {
        name: "bind-actual-dist-worker-url",
        setup(plugin) {
          plugin.onLoad(
            { filter: /[/\\]src[/\\]certifiedRuntime[/\\]browserClient\.ts$/ },
            (args) => {
              const source = readFileSync(args.path, "utf8");
              const original = 'new URL("./browserWorker.ts", import.meta.url)';
              assert.equal(
                source.split(original).length,
                2,
                "client Worker constructor changed; review adapter binding",
              );
              return {
                contents: source.replace(
                  original,
                  `new URL(${JSON.stringify(workerUrl)}, import.meta.url)`,
                ),
                loader: "ts",
              };
            },
          );
        },
      },
    ],
  });
  assert.ok(result.metafile);
  assert.equal(result.outputFiles.length, 1);
  assert.ok(
    !Object.keys(result.metafile.inputs).some((path) =>
      /(?:^|\/)src\/certified\/|browserWorker\.ts$/.test(path),
    ),
    "adapter must not compile candidate numerical Worker/kernel",
  );
  const output = result.outputFiles[0];
  assert.ok(output);
  const bytes = Buffer.from(output.contents);
  assert.ok(bytes.toString("utf8").includes(workerUrl));
  return {
    bytes,
    urlPath: "/__certified_dist_client.js",
    sha256: sha256Bytes(bytes),
    sources: compiledSources(result.metafile.inputs, sourcefile),
    esbuildVersion,
    meaning:
      "Separately built source-pinned client adapter with exact dist Worker URL; not the shipped React client chunk.",
  };
}
/** Same candidate API is used only as the waiting parity reference. */
export async function buildCandidateWaitingReference(inputs: readonly CertifiedInput[]) {
  const sourcefile = "certified-waiting-parity-reference.ts";
  const result = await build({
    stdin: {
      contents: "export {solveCertified} from './src/certified/solver.ts';",
      sourcefile,
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  assert.ok(result.metafile);
  assert.equal(result.outputFiles.length, 1);
  const output = result.outputFiles[0];
  assert.ok(output);
  const module = (await import(
    `data:text/javascript;base64,${Buffer.from(output.contents).toString("base64")}`
  )) as {
    solveCertified: (
      input: CertifiedInput,
      options: { maxManagedPayloadBytes: number },
    ) => CertifiedOutput;
  };
  return {
    rows: inputs.map((input) => {
      const output = module.solveCertified(input, { maxManagedPayloadBytes: 160 * 1024 * 1024 });
      assert.ok(output.current, "waiting parity reference current unavailable");
      return { status: output.status, waiting: output.waiting, refusal: output.refusal };
    }),
    sources: compiledSources(result.metafile.inputs, sourcefile),
    meaning:
      "Candidate-source API waiting/status/refusal parity only; independent waiting/gap proof NOTRUN.",
  };
}
const contentType = (path: string) => {
  if (path.endsWith(".js")) return "text/javascript";
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
};
export async function startCertifiedDistServer(
  dist: ReturnType<typeof inspectCertifiedDist>,
  adapter: { urlPath: string; bytes: Buffer; sha256: string },
) {
  const served: {
    urlPath: string;
    sha256: string;
    bytes: number;
    userAgent: string | undefined;
  }[] = [];
  const contents = new Map<string, { bytes: Buffer; sha256: string }>(
    dist.assets.map((asset) => [
      asset.urlPath,
      { bytes: readFileSync(asset.path), sha256: asset.sha256 },
    ]),
  );
  contents.set(adapter.urlPath, { bytes: adapter.bytes, sha256: adapter.sha256 });
  for (const [path, asset] of contents)
    assert.equal(
      sha256Bytes(asset.bytes),
      asset.sha256,
      `asset changed before server start: ${path}`,
    );
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    response.setHeader("Cache-Control", "no-store");
    if (url.pathname === "/__certified_dist_validation") {
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><title>Independent certified dist Worker validation</title>");
      return;
    }
    const asset = contents.get(url.pathname);
    if (!asset) {
      response.statusCode = 404;
      response.end("Missing dist asset");
      return;
    }
    served.push({
      urlPath: url.pathname,
      sha256: sha256Bytes(asset.bytes),
      bytes: asset.bytes.length,
      userAgent: request.headers["user-agent"],
    });
    response.setHeader("Content-Type", contentType(url.pathname));
    response.setHeader("X-Content-SHA256", asset.sha256);
    response.end(asset.bytes);
  });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      accept();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    served,
    close: () =>
      new Promise<void>((accept, reject) => {
        server.close((error) => (error ? reject(error) : accept()));
        server.closeAllConnections();
      }),
  };
}
export function assertDistStable(dist: ReturnType<typeof inspectCertifiedDist>) {
  assert.deepEqual(
    inspectCertifiedDist(dist.root),
    dist,
    "production dist bytes changed during the three-browser campaign",
  );
}
