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

export function deploy(kind: "site" | "stats", args: string[], parent = process.env,
  execute: typeof execFileSync = execFileSync) {
const [selection, sha, ...extra] = args;
const productionOff = kind === "site" && selection === "production-off";
const productionOnline = kind === "site" && selection === "production-online";
const replacement = selection?.startsWith("rebuild-") ?? false;
const target = productionOff || productionOnline ? "production" : replacement ? selection!.slice(8) : selection;
if (extra.length || !["production", "staging"].includes(target ?? "") ||
    (kind === "stats" && !replacement) ||
    !/^[a-f0-9]{40}$/.test(sha ?? ""))
  throw new Error("Expected production|production-off|production-online|staging|rebuild-production|rebuild-staging and approved full SHA; stats requires rebuild");
const root = resolve(import.meta.dirname, "..");
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
  siteArtifactValidationArgs(resolve(root, "dist"), target!, sha!, candidate !== null || productionOnline, productionOff),
  { cwd: root, env, stdio: "inherit" });
snapshot();
execute(process.execPath, [
  resolve(root, "node_modules/wrangler/bin/wrangler.js"),
  "deploy", "--config",
  config,
  "--env", "", "--tag", sha!, "--message", `${kind === "site" ? "Site" : "Stats"} ${target} ${sha}`,
  ...(kind === "stats" ? ["--var", `DEPLOYMENT_SHA:${sha}`] : []),
], {
  cwd: root,
  env: { ...env, CLOUDFLARE_ACCOUNT_ID: account!, CLOUDFLARE_API_TOKEN: token },
  stdio: "inherit",
});
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  deploy("site", process.argv.slice(2));
