import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CONFIG = "site-worker/production.wrangler.toml";
const WORKER = "collection-kit-site-production";
const SHA = /^[0-9a-f]{40}$/;

export function productionCandidate(input: {
  sha: string;
  checkout: string;
  ref: string;
  workflowRef: string;
  repository: string;
  inMainHistory: boolean;
  mode: string;
}) {
  if (!SHA.test(input.sha)) throw new Error("deploy_sha must be a full lowercase 40-hex SHA.");
  if (
    input.ref !== "refs/heads/main" ||
    input.workflowRef !==
      `${input.repository}/.github/workflows/site-worker-promote.yml@refs/heads/main`
  ) {
    throw new Error("Only the trusted main workflow may promote the site.");
  }
  if (!input.inMainHistory) throw new Error("Candidate is not in main history.");
  if (input.checkout !== input.sha) throw new Error("Candidate checkout SHA mismatch.");
  if (input.mode !== "bootstrap" && input.mode !== "publish") throw new Error("Invalid site mode.");
  return { sha: input.sha, mode: input.mode, buildEnvironment: { GITHUB_SHA: input.sha } };
}

export function siteDeploymentArguments(sha: string, config: string) {
  if (!SHA.test(sha)) throw new Error("Invalid site deployment SHA.");
  const source = config.replace(/#.*$/gm, "");
  if (
    !/^name\s*=\s*"collection-kit-site-production"\s*$/m.test(source) ||
    !/^SITE_ENV\s*=\s*"production"\s*$/m.test(source) ||
    /(?:\b(?:routes|route|services|d1_databases|migrations|account_id|zone_id)\s*[=.\]]|\bcustom_domain\b)/.test(
      source,
    ) ||
    !/^workers_dev\s*=\s*false\s*$/m.test(source) ||
    !/^preview_urls\s*=\s*false\s*$/m.test(source)
  ) {
    throw new Error("Only the domain-free, binding-free production site config may be deployed.");
  }
  return ["deploy", "--config", CONFIG, "--env", "", "--tag", sha, "--message", sha];
}

function candidateFromEnvironment() {
  const sha = process.env["DEPLOY_SHA"] ?? "";
  // Validate before passing user-controlled data to Git.
  if (!SHA.test(sha)) throw new Error("Invalid candidate SHA.");
  let inMainHistory = false;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "refs/remotes/origin/main"]);
    inMainHistory = true;
  } catch {
    throw new Error("Candidate is not in fetched main history.");
  }
  return productionCandidate({
    sha,
    checkout: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    ref: process.env["GITHUB_REF"] ?? "",
    workflowRef: process.env["GITHUB_WORKFLOW_REF"] ?? "",
    repository: process.env["GITHUB_REPOSITORY"] ?? "",
    mode: process.env["SITE_DEPLOY_MODE"] ?? "",
    inMainHistory,
  });
}

export function assertVerificationCredentialsAbsent(env: NodeJS.ProcessEnv) {
  if (env["CLOUDFLARE_API_TOKEN"] || env["CLOUDFLARE_ACCOUNT_ID"]) {
    throw new Error("Deployment credentials must be absent from verification.");
  }
}

async function run(command: string) {
  const candidate = candidateFromEnvironment();
  if (command === "verify") {
    assertVerificationCredentialsAbsent(process.env);
    const output = process.env["GITHUB_OUTPUT"];
    if (output) appendFileSync(output, `deploy_sha=${candidate.sha}\n`);
    return;
  }
  if (command !== "deploy") throw new Error("Usage: site-production-deployment.ts verify|deploy");
  const { activeVersionId, deploymentVersionId } = await import("./check-workflow-hardening.ts");
  if (candidate.mode === "publish" && process.env["SITE_URL"] !== "https://nikkecollection.com") {
    throw new Error("Publish requires the explicit production origin.");
  }
  if (process.env["GITHUB_SHA"] !== candidate.sha) throw new Error("Build revision mismatch.");
  for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
    if (!process.env[key]) throw new Error(`Missing ${key}.`);
  }
  const digest = process.env["SITE_ARTIFACT_DIGEST"] ?? "";
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("Missing uploaded artifact digest.");
  const args = siteDeploymentArguments(candidate.sha, readFileSync(CONFIG, "utf8"));
  const wrangler = resolve("node_modules/wrangler/bin/wrangler.js");
  if (candidate.mode === "publish") {
    // Fail closed if the named Worker has not already been bootstrapped.
    const previous = execFileSync(
      process.execPath,
      [wrangler, "deployments", "status", "--config", CONFIG, "--env", "", "--json"],
      { encoding: "utf8", timeout: 60_000 },
    );
    activeVersionId(JSON.parse(previous));
  }
  const outputPath = process.env["WRANGLER_OUTPUT_FILE_PATH"];
  if (!outputPath) throw new Error("WRANGLER_OUTPUT_FILE_PATH is required.");
  execFileSync(process.execPath, [wrangler, ...args], { stdio: "inherit", timeout: 300_000 });
  const versionId = deploymentVersionId(readFileSync(outputPath, "utf8"), WORKER, "");
  const evidence = { sha: candidate.sha, mode: candidate.mode, versionId, artifactDigest: digest };
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (!summary) throw new Error("GITHUB_STEP_SUMMARY is required.");
  appendFileSync(
    summary,
    `### Site production deployment\n\n\`\`\`json\n${JSON.stringify(evidence)}\n\`\`\`\n`,
  );
  console.log(JSON.stringify(evidence));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run(process.argv[2] ?? "");
}
