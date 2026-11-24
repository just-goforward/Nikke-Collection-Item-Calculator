import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { productionTarget } from "./production-operating-catalog.mjs";
const { childEnvironment } = createRequire(import.meta.url)("./ci/run-checked-command.mjs") as {
  childEnvironment(env: NodeJS.ProcessEnv, sha: string): NodeJS.ProcessEnv;
};

export function siteArtifactValidationArgs(directory: string, target: string, sha: string,
  productionCandidate: boolean, productionOff = false) {
  const validation = productionOff
    ? "const {assertProductionOffSiteProfile}=await import('./scripts/site-deployment-artifact.mjs'); await buildSiteProduction(process.argv[1],true,undefined,process.argv[2]); await assertProductionOffSiteProfile(process.argv[1],process.argv[3]);"
    : productionCandidate
    ? "const {assertProductionSiteCandidateProfile}=await import('./scripts/site-deployment-artifact.mjs'); const approved=await assertProductionSiteCandidateProfile(process.argv[1],process.argv[3]); await buildSiteProduction(process.argv[1],true,approved,process.argv[2]);"
    : "const {assertSiteDeploymentArtifact}=await import('./scripts/site-deployment-artifact.mjs'); await buildSiteProduction(process.argv[1],true,undefined,process.argv[2]); assertSiteDeploymentArtifact(process.argv[1],process.argv[3]);";
  return [
    "--input-type=module", "-e",
    `const {buildSiteProduction}=await import('./scripts/build-site-production.ts'); ${validation}`,
    directory, target, sha,
  ];
}

export function assertProductionOffSiteConfiguration(text: string) {
  const normalized = text.replace(/\r\n/g, "\n");
  const services = normalized.split(/^\[\[services\]\]\n/m).slice(1)
    .map(block => block.split(/^\[/m)[0]!.trim()).sort();
  const expected = [
    'binding = "STATS_INGEST"\nservice = "collection-kit-stats"\nentrypoint = "Ingest"',
    'binding = "STATS_PUBLIC"\nservice = "collection-kit-stats"\nentrypoint = "PublicStats"',
  ].sort();
  if (!normalized.split("\n").includes('name = "collection-kit-site-production"') ||
      !normalized.includes('SITE_ENV = "production"') ||
      !normalized.includes('FORECAST_RUNTIME_MODE = "off"') ||
      JSON.stringify(services) !== JSON.stringify(expected) ||
      (normalized.match(/^entrypoint\s*=/gm) ?? []).length !== 2 ||
      /^\[services\]|\[\[d1_databases\]\]/m.test(normalized))
    throw new Error("Production OFF existing-worker capability configuration mismatch");
}

const NONDEPLOYABLE = "NONDEPLOYABLE_SERVICE_CANDIDATE";
function uploadReceipt(directory: string, file: string, optional: boolean): Record<string, unknown> | null {
  let value: unknown;
  try { value = JSON.parse(readFileSync(resolve(directory, file), "utf8")); }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`site_upload_receipt_unreadable:${file}`);
  }
  if (!value || typeof value !== "object") throw new Error(`site_upload_receipt_unreadable:${file}`);
  return value as Record<string, unknown>;
}

/** Upload authority is separate from artifact validity. Local packaging and the
 * bundled/OFF validators accept the NONDEPLOYABLE FUSED candidate; no Site mode
 * may hand it to Wrangler. Fails closed on a missing or malformed profile. */
export function assertSiteUploadApproved(directory: string) {
  const profile = uploadReceipt(directory, ".vite/local-operational-profile.json", false)!;
  const service = uploadReceipt(directory, ".vite/service-h14.json", true);
  if (profile["deploymentApproved"] !== true || profile["solverApproval"] === NONDEPLOYABLE ||
      (service && (service["publicationApproved"] !== true || service["status"] === NONDEPLOYABLE)))
    throw new Error("site_upload_nondeployable_artifact");
}

export function deploy(kind: "site" | "stats", args: string[], parent = process.env,
  execute: typeof execFileSync = execFileSync) {
const [selection, sha, ...extra] = args;
const sealed = kind === "site" && selection === "production-online-sealed";
const productionOff = kind === "site" && selection === "production-off";
const productionOnline = kind === "site" && (selection === "production-online" || sealed);
const replacement = selection?.startsWith("rebuild-") ?? false;
const target = productionOff || productionOnline ? "production" : replacement ? selection!.slice(8) : selection;
if (extra.length || !["production", "staging"].includes(target ?? "") ||
    (kind === "stats" && !replacement) ||
    !/^[a-f0-9]{40}$/.test(sha ?? ""))
  throw new Error("Expected production|production-off|production-online|production-online-sealed|staging|rebuild-production|rebuild-staging and approved full SHA; stats requires rebuild");
const root = resolve(import.meta.dirname, "..");
// One Site artifact: validated, authorized, sealed-compared (site-release verify)
// and uploaded via an explicit `--assets`, not the config's relative directory.
const artifact = resolve(root, "dist");
const candidate = (replacement || productionOff) && target === "production" ? productionTarget(kind) : null;
const worker = candidate?.worker ?? `collection-kit-${kind}-${replacement ? "v2-" : ""}${target}`;
const config = candidate?.config ?? (replacement ? `${kind === "site" ? "site-worker" : "cloudflare"}/rebuild.${target}.wrangler.toml`
  : target === "production" ? "site-worker/production.wrangler.toml" : "site-worker/wrangler.toml");
const text = readFileSync(resolve(root, config), "utf8");
if (!text.split(/\r?\n/).includes(`name = "${worker}"`) ||
    (kind === "site" && !text.includes(`SITE_ENV = "${target}"`)))
  throw new Error("Deployment configuration target mismatch");
const prefix = kind === "site" ? "SITE" : "STATS";
const hostname = target === "production" ? "nikkecollection.com" : "staging.nikkecollection.com";
if (parent[`${prefix}_DEPLOY_WORKER`] !== worker || parent[`${prefix}_DEPLOY_HOSTNAME`] !== hostname)
  throw new Error(`Confirm ${prefix}_DEPLOY_WORKER=${worker} and ${prefix}_DEPLOY_HOSTNAME=${hostname}`);
const account = parent["CLOUDFLARE_ACCOUNT_ID"];
const token = parent["CLOUDFLARE_API_TOKEN"];
if (!/^[a-f0-9]{32}$/.test(account ?? "") || !token ||
    parent[`${prefix}_DEPLOY_ACCOUNT_ID`] !== account)
  throw new Error("Explicit matching deployment account ID and Cloudflare credentials required");
if (productionOff) {
  if (account !== "15be33fd20ea78eb3d60b719be831148")
    throw new Error("Production OFF account mismatch");
  assertProductionOffSiteConfiguration(text);
}
if (productionOnline) {
  if (account !== "15be33fd20ea78eb3d60b719be831148")
    throw new Error("Production online account mismatch");
  if (!text.split(/\r?\n/).includes('FORECAST_RUNTIME_MODE = "enabled"'))
    throw new Error("Production online runtime configuration mismatch");
}
const env = childEnvironment(parent, sha!);
function git(args: string[]) {
  return String(execute("git", args, { cwd: root, env, encoding: "utf8" })).trim();
}
function snapshot() {
  if (git(["rev-parse", "HEAD"]) !== sha ||
      git(["status", "--porcelain", "--untracked-files=all"]))
    throw new Error("Deployment requires the approved SHA and a clean working tree");
}
snapshot();
// Check the completed local artifact without rebuilding or granting credentials to verification.
if (kind === "site") execute(process.execPath,
  siteArtifactValidationArgs(artifact, target!, sha!, candidate !== null || productionOnline, productionOff),
  { cwd: root, env, stdio: "inherit" });
snapshot();
let sealedEntry: string | undefined;
if (sealed) {
  const directory = parent["SITE_RELEASE_DIR"];
  if (!directory || !parent["SITE_RELEASE_MANIFEST_SHA256"] ||
      !/^[0-9]+$/.test(parent["GITHUB_RUN_ID"] ?? "") || !/^[0-9]+$/.test(parent["GITHUB_RUN_ATTEMPT"] ?? ""))
    throw new Error("Sealed Site release identity required");
  execute(process.execPath, [
    resolve(root, "scripts/site-release.mjs"), "verify", directory, sha!,
    parent["SITE_RELEASE_MANIFEST_SHA256"], parent["GITHUB_RUN_ID"]!, parent["GITHUB_RUN_ATTEMPT"]!,
  ], { cwd: root, env, stdio: "inherit" });
  sealedEntry = resolve(directory, "worker/worker.js");
  snapshot();
}
if (kind === "site" && target === "production" && git(["ls-tree", "HEAD", "--", "site-worker/production-root-release-v1.json"]))
  throw new Error("Enrolled production Site requires the protected two-seal transition; no legacy/off/rebuild publication");
// Last step before credentials reach Wrangler; Stats has no Site artifact.
if (kind === "site") assertSiteUploadApproved(artifact);
execute(process.execPath, [
  resolve(root, "node_modules/wrangler/bin/wrangler.js"),
  "deploy", "--config",
  config,
  "--env", "", "--tag", sha!, "--message", `${kind === "site" ? "Site" : "Stats"} ${target} ${sha}`,
  ...(kind === "site" ? ["--assets", artifact] : []),
  ...(sealedEntry ? [sealedEntry, "--no-bundle", "--no-experimental-auto-create"] : []),
  ...(kind === "stats" ? ["--var", `DEPLOYMENT_SHA:${sha}`] : []),
], {
  cwd: root,
  env: { ...env, CLOUDFLARE_ACCOUNT_ID: account!, CLOUDFLARE_API_TOKEN: token },
  stdio: "inherit",
});
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === "production-root-sealed") {
    // The root has a separate, two-seal admission path. Never fall back to the legacy profile.
    import("./ci/promote-root-pair.mjs").then(({ promoteRoot }) => promoteRoot(process.argv.slice(2), process.env))
      .catch(error => { console.error(error); process.exitCode = 1; });
  } else deploy("site", process.argv.slice(2));
}
