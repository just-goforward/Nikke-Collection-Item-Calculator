import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Manifest } from "vite";
import { CERTIFIED_STAGING_ENGINE_PROFILE } from "../shared/certifiedEngineProfile.ts";
import { CERTIFIED_WASM_ASSET, LEGACY_WASM_ASSET } from "../shared/generated/wasmRuntimeAssets.ts";
import retention from "../rollback/production/retained.json" with { type: "json" };
import type { CertifiedBundleBoundary } from "./certified-bundle-boundary.ts";
import { assertWasmRuntimeAssets } from "./wasm-runtime-assets.ts";

import { readServiceH14Native } from "./service-h14-native-integrity.ts";
import { assertServiceH14Build } from "./service-h14-integrity.ts";
const ROOT = resolve(import.meta.dirname, "..");
const ALIASES = ["/solver_rs.wasm", "/certified_solver.wasm"] as const;
const SERVICE_H14_WORKER = "src/serviceH14/browserWorker.ts";
type Pin = { url: string; sha256: string; bytes: number };
type Generation = {
  id: string; role: string; artifactId: number; siteVersion: string; archiveSha256: string;
  entry: string; engineProfile: object;
  workers: { source: string; entry: string; chunks: string[] }[];
  files: Pin[];
};
const generations: Generation[] = retention.generations;
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
function safeUrl(url: string) {
  return /^\/[A-Za-z0-9_./-]+$/.test(url) &&
    url.slice(1).split("/").every((part) => part && part !== "." && part !== "..");
}

/** Old expectations are independent inputs. Equivalent representations agree;
 * one URL with different content/length is never resolved by choosing "latest".
 */
export function retainedAssetPins(values: readonly Generation[]) {
  const result = new Map<string, Pin & { generations: string[] }>();
  for (const generation of values) {
    for (const pin of generation.files) {
      if (!safeUrl(pin.url) || !/^[a-f0-9]{64}$/.test(pin.sha256) ||
          !Number.isSafeInteger(pin.bytes) || pin.bytes < 1)
        throw new Error("production_retained_pin_invalid");
      const previous = result.get(pin.url);
      if (previous && (previous.sha256 !== pin.sha256 || previous.bytes !== pin.bytes))
        throw new Error(`production_asset_url_conflict:${pin.url}`);
      if (previous) previous.generations.push(generation.id);
      else result.set(pin.url, { ...pin, generations: [generation.id] });
    }
  }
  for (const generation of values) {
    const own = new Set(generation.files.map((pin) => pin.url));
    for (const url of [generation.entry, ...generation.workers.flatMap((worker) => [worker.entry, ...worker.chunks])])
      if (!own.has(url)) throw new Error(`production_retained_closure_missing:${url}`);
  }
  return result;
}

async function regularBytes(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`production_asset_not_regular:${path}`);
  return readFile(path);
}
async function optionalBytes(path: string) {
  try { return await regularBytes(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function matches(bytes: Uint8Array, pin: { sha256: string; bytes: number }) {
  return bytes.byteLength === pin.bytes && hash(bytes) === pin.sha256;
}

/** Called by the formal packager, never by a request. Validate the entire copy
 * plan before any staging write. Raw Vite output is not a publishable release.
 */
export async function stageProductionAssetCoexistence(directory: string, check = false) {
  assertWasmRuntimeAssets();
  if (retention.version !== 1 || generations.length !== 2)
    throw new Error("production_retention_manifest_invalid");
  const retained = retainedAssetPins(generations);
  const current = [
    { role: "legacy", canonical: "solver_rs.wasm", asset: LEGACY_WASM_ASSET },
    { role: "certified", canonical: "certified_solver.wasm", asset: CERTIFIED_WASM_ASSET },
  ];
  // The emitted worker graph, not the optional receipt file, decides whether the
  // FUSED lane is packaged: a FUSED worker without its verified receipt is rejected.
  const workers: unknown = (JSON.parse((await regularBytes(join(directory, ".vite/certified-boundary.json")))
    .toString("utf8")) as Partial<CertifiedBundleBoundary> | null)?.perWorker;
  if (!Array.isArray(workers)) throw new Error("production_certified_boundary_invalid");
  const serviceWorker = workers.some((item: { source?: unknown } | null) => item?.source === SERVICE_H14_WORKER);
  const serviceReceiptBytes = await optionalBytes(join(directory, ".vite/service-h14.json"));
  if (serviceWorker && !serviceReceiptBytes) throw new Error("service_h14_packaged_receipt_missing");
  let serviceCandidate: {
    profileId: string; codeHash: string; asset: { sha256: string; byteLength: number; assetPath: string };
    publicationApproved: false; analyticsProviderApproved: false;
  } | null = null;
  if (serviceReceiptBytes) {
    const receipt = JSON.parse(serviceReceiptBytes.toString("utf8"));
    const identity = await assertServiceH14Build(ROOT);
    const { wasm } = readServiceH14Native(ROOT);
    if (receipt.status !== "NONDEPLOYABLE_SERVICE_CANDIDATE" ||
        receipt.publicationApproved !== false || receipt.analyticsProviderApproved !== false ||
        receipt.identity?.codeHash !== identity.codeHash ||
        receipt.identity?.exactWasmHash !== identity.exactWasmHash ||
        JSON.stringify(receipt.asset) !== JSON.stringify(wasm))
      throw new Error("service_h14_packaged_identity_mismatch");
    const bytes = await regularBytes(join(directory, wasm.assetPath.slice(1)));
    if (!matches(bytes, { sha256: wasm.sha256, bytes: wasm.byteLength }))
      throw new Error("service_h14_packaged_native_mismatch");
    serviceCandidate = {
      profileId: identity.profileId, codeHash: identity.codeHash, asset: wasm,
      publicationApproved: false, analyticsProviderApproved: false,
    };
  }
  const writes: { path: string; bytes: Uint8Array }[] = [];
  for (const { asset } of current) {
    const url = "/" + asset.file;
    if (retained.has(url) && !matches(await regularBytes(join(ROOT, "public", asset.file)), retained.get(url)!))
      throw new Error(`production_asset_url_conflict:${url}`);
    const bytes = await optionalBytes(join(directory, asset.file));
    if (!bytes) throw new Error(`production_required_asset_missing:${asset.file}`);
    if (!matches(bytes, asset)) throw new Error(`production_required_asset_mismatch:${asset.file}`);
  }
  for (const alias of ALIASES)
    if (!retained.has(alias)) throw new Error(`production_retained_alias_missing:${alias}`);
  for (const pin of retained.values()) {
    const source = join(ROOT, "rollback/production/files", pin.url.slice(1));
    const bytes = await regularBytes(source);
    if (!matches(bytes, pin)) throw new Error(`production_retained_source_mismatch:${pin.url}`);
    const target = join(directory, pin.url.slice(1));
    const previous = await optionalBytes(target);
    const alias = current.find((item) => "/" + item.canonical === pin.url);
    if (!previous && alias) throw new Error(`production_required_asset_missing:${alias.canonical}`);
    if (previous && matches(previous, pin)) continue;
    if (check) throw new Error(`production_retained_asset_mismatch:${pin.url}`);
    if (previous && alias && !matches(previous, alias.asset))
      throw new Error(`production_required_asset_mismatch:${alias.canonical}`);
    if (previous && (!alias || !matches(previous, alias.asset)))
      throw new Error(`production_asset_url_conflict:${pin.url}`);
    writes.push({ path: target, bytes });
  }
  for (const item of writes) {
    await mkdir(dirname(item.path), { recursive: true });
    await writeFile(item.path, item.bytes);
  }
  return {
    version: 1 as const,
    publicationApproved: false as const,
    ...(serviceCandidate ? { serviceCandidate } : {}),
    current: {
      engineProfile: CERTIFIED_STAGING_ENGINE_PROFILE,
      wasm: current.map(({ role, canonical, asset }) => ({
        role, url: "/" + asset.file, file: asset.file,
        source: `public/${canonical}`, sha256: asset.sha256, bytes: asset.bytes,
      })),
    },
    retained: generations,
    retainedFiles: [...retained.values()].map((pin) => ({
      ...pin, file: pin.url.slice(1), source: `rollback/production/files${pin.url}`,
    })),
    unresolvedConflicts: [] as string[],
  };
}

/** Bind the emitted client URL and verification hash to the actual Worker graph,
 * not merely to the presence of a WASM file beside an unrelated build.
 */
export async function assertProductionAssetReferences(
  directory: string, manifest: Manifest, boundary: CertifiedBundleBoundary,
) {
  const files = new Set(Object.values(manifest).map((entry) => entry.file).filter((file) => file.endsWith(".js")));
  for (const worker of boundary.perWorker)
    for (const chunk of worker.chunks) files.add(chunk.file);
  const code = new Map(await Promise.all([...files].map(async (file) =>
    [file, await readFile(join(directory, file), "utf8")] as const)));
  const all = [...code.values()].join("\n");
  const service = boundary.perWorker.find(item => item.source === SERVICE_H14_WORKER);
  const required: [string, { file: string; sha256: string }][] = [
    ["src/worker.ts", LEGACY_WASM_ASSET],
  ];
  if (service) {
    const { wasm } = readServiceH14Native(ROOT);
    const copied = await regularBytes(join(directory, wasm.assetPath.slice(1)));
    if (!matches(copied, { sha256: wasm.sha256, bytes: wasm.byteLength }))
      throw new Error("service_h14_packaged_native_mismatch");
    required.push([SERVICE_H14_WORKER, { file: wasm.assetPath.slice(1), sha256: wasm.sha256 }]);
  }
  if (!service || boundary.perWorker.some(item => item.source === "src/certifiedRuntime/browserWorker.ts"))
    required.push(["src/certifiedRuntime/browserWorker.ts", CERTIFIED_WASM_ASSET]);
  for (const [source, asset] of required) {
    const worker = boundary.perWorker.find((item) => item.source === source);
    if (!worker || !all.includes(asset.file))
      throw new Error(`production_asset_client_reference_missing:${source}`);
    const body = worker.chunks.map((chunk) => code.get(chunk.file) ?? "").join("\n");
    if (!body.includes(asset.sha256))
      throw new Error(`production_asset_worker_pin_missing:${source}`);
  }
  if (CERTIFIED_STAGING_ENGINE_PROFILE.wasmHash !== CERTIFIED_WASM_ASSET.sha256)
    throw new Error("production_asset_profile_mismatch");
}
