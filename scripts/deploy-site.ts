import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const { childEnvironment } = createRequire(import.meta.url)("./ci/run-checked-command.mjs") as {
  childEnvironment(env: NodeJS.ProcessEnv, sha: string): NodeJS.ProcessEnv;
};

export function deploy(kind: "site" | "stats", args: string[], parent = process.env,
  execute: typeof execFileSync = execFileSync) {
const [selection, sha, ...extra] = args;
const replacement = selection?.startsWith("rebuild-") ?? false;
const target = replacement ? selection!.slice(8) : selection;
if (extra.length || !["production", "staging"].includes(target ?? "") ||
    (kind === "stats" && !replacement) ||
    !/^[a-f0-9]{40}$/.test(sha ?? ""))
  throw new Error("Expected production|staging|rebuild-production|rebuild-staging and approved full SHA; stats requires rebuild");
const root = resolve(import.meta.dirname, "..");
const worker = `collection-kit-${kind}-${replacement ? "v2-" : ""}${target}`;
const config = replacement ? `${kind === "site" ? "site-worker" : "cloudflare"}/rebuild.${target}.wrangler.toml`
  : target === "production" ? "site-worker/production.wrangler.toml" : "site-worker/wrangler.toml";
const text = readFileSync(resolve(root, config), "utf8");
if (!text.startsWith(`name = "${worker}"\n`) ||
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
if (kind === "site") execute(process.execPath, [
  "--input-type=module", "-e",
  "const {buildSiteProduction}=await import('./scripts/build-site-production.ts'); const {assertSiteDeploymentArtifact}=await import('./scripts/site-deployment-artifact.mjs'); await buildSiteProduction(process.argv[1],true,undefined,process.argv[2]); assertSiteDeploymentArtifact(process.argv[1],process.argv[3]);",
  resolve(root, "dist"), target!, sha!,
], { cwd: root, env, stdio: "inherit" });
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
