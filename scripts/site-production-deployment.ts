import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CONFIG = "site-worker/production.wrangler.toml";
const WORKER = "collection-kit-site-production";
const SHA = /^[0-9a-f]{40}$/;
const { childEnvironment } = createRequire(import.meta.url)("./ci/run-checked-command.mjs") as {
  childEnvironment(parent: NodeJS.ProcessEnv, commit: string): NodeJS.ProcessEnv;
};

type Execute = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; encoding: "utf8" },
) => string;
type Dependencies = {
  env?: NodeJS.ProcessEnv;
  execute?: Execute;
  read?: (path: string) => Buffer;
  append?: (path: string, text: string) => void;
};

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
  return { sha: input.sha, mode: input.mode };
}

function acceptAssignment(
  values: Map<string, string>,
  keys: readonly string[],
  section: string,
  line: string,
) {
  const assignment = line.match(/^([a-zA-Z_]+)\s*=\s*(.+)$/);
  const key = assignment?.[1] ?? "";
  const value = assignment?.[2] ?? "";
  const fullKey = section ? `${section}.${key}` : key;
  if (!keys.includes(key) || values.has(fullKey) || /[{}]/.test(value)) {
    throw new Error("Production config allowlist rejected an unknown or duplicate assignment.");
  }
  values.set(fullKey, value);
}

// Deliberately restricted TOML: this deployment config uses only single-line scalar/array
// assignments. Unknown syntax, duplicate keys, extra sections and inline tables fail closed.
function configAssignments(config: string) {
  const allowed: Record<string, readonly string[]> = {
    "": ["name", "main", "compatibility_date", "workers_dev", "preview_urls", "upload_source_maps"],
    vars: ["SITE_ENV"],
    assets: ["directory", "binding", "not_found_handling", "run_worker_first"],
    observability: ["enabled"],
    "observability.logs": ["enabled", "invocation_logs"],
    services: ["binding", "service"],
  };
  const values = new Map<string, string>();
  const sections = new Set<string>();
  let section = "";
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const heading =
      line === "[[services]]" ? "services" : line.match(/^\[((?!services\])[a-z.]+)\]$/)?.[1];
    if (heading && allowed[heading] && !sections.has(heading)) {
      section = heading;
      sections.add(heading);
      continue;
    }
    acceptAssignment(values, allowed[section] ?? [], section, line);
  }
  return values;
}

export function siteDeploymentArguments(sha: string, config: string) {
  if (!SHA.test(sha)) throw new Error("Invalid site deployment SHA.");
  const values = configAssignments(config);
  const required: Record<string, string> = {
    name: `"${WORKER}"`,
    main: '"src/worker.ts"',
    workers_dev: "false",
    preview_urls: "false",
    upload_source_maps: "false",
    "vars.SITE_ENV": '"production"',
    "assets.directory": '"../dist"',
    "assets.binding": '"ASSETS"',
    "assets.not_found_handling": '"404-page"',
    "observability.enabled": "false",
    "observability.logs.enabled": "false",
    "observability.logs.invocation_logs": "false",
    "services.binding": '"STATS"',
    "services.service": '"collection-kit-stats"',
  };
  for (const [key, value] of Object.entries(required)) {
    if (values.get(key) !== value) throw new Error(`Unexpected production config ${key}.`);
  }
  if (!/^"\d{4}-\d{2}-\d{2}"$/.test(values.get("compatibility_date") ?? "")) {
    throw new Error("Production compatibility_date is required.");
  }
  const routes = JSON.parse(values.get("assets.run_worker_first") ?? "null") as unknown;
  const expectedRoutes = [
    "/api",
    "/api/*",
    "/auth",
    "/auth/*",
    "/v1",
    "/v1/*",
    "/account",
    "/account/*",
    "/admin",
    "/admin/*",
    "/robots.txt",
  ];
  if (JSON.stringify(routes) !== JSON.stringify(expectedRoutes)) {
    throw new Error("Unexpected production asset routing.");
  }
  return ["deploy", "--config", CONFIG, "--env", "", "--tag", sha, "--message", sha];
}

function candidateFromEnvironment(env: NodeJS.ProcessEnv, execute: Execute) {
  const sha = env["DEPLOY_SHA"] ?? "";
  if (!SHA.test(sha)) throw new Error("Invalid candidate SHA.");
  const options = { env: childEnvironment(env, sha), timeout: 30_000, encoding: "utf8" as const };
  execute("git", ["merge-base", "--is-ancestor", sha, "refs/remotes/origin/main"], options);
  return productionCandidate({
    sha,
    checkout: execute("git", ["rev-parse", "HEAD"], options).trim(),
    ref: env["GITHUB_REF"] ?? "",
    workflowRef: env["GITHUB_WORKFLOW_REF"] ?? "",
    repository: env["GITHUB_REPOSITORY"] ?? "",
    mode: env["SITE_DEPLOY_MODE"] ?? "",
    inMainHistory: true,
  });
}

export function assertVerificationCredentialsAbsent(env: NodeJS.ProcessEnv) {
  if (env["CLOUDFLARE_API_TOKEN"] || env["CLOUDFLARE_ACCOUNT_ID"]) {
    throw new Error("Deployment credentials must be absent from verification.");
  }
}

export function assertBuiltRevision(sha: string, read: (path: string) => Buffer) {
  if (!SHA.test(sha)) throw new Error("Invalid build candidate.");
  const manifest = JSON.parse(read("dist/.vite/manifest.json").toString()) as Record<
    string,
    { file: string; isEntry?: boolean }
  >;
  const entries = Object.values(manifest).filter((entry) => entry.isEntry);
  if (!entries.length) throw new Error("Built entry manifest is missing.");
  for (const entry of entries) {
    if (!/^assets\/[^/]+\.js$/.test(entry.file)) throw new Error("Invalid built entry path.");
    const js = read(`dist/${entry.file}`).toString();
    if (!new RegExp(`(?<![0-9a-fA-F])${sha}(?![0-9a-fA-F])`).test(js)) {
      throw new Error("Built entry revision does not match candidate.");
    }
  }
}

function artifactDigest(env: NodeJS.ProcessEnv, read: (path: string) => Buffer) {
  const path = env["SITE_ARTIFACT_PATH"];
  if (!path) throw new Error("SITE_ARTIFACT_PATH is required.");
  return createHash("sha256").update(read(path)).digest("hex");
}

function assertArtifactDigest(env: NodeJS.ProcessEnv, read: (path: string) => Buffer) {
  const expected = env["SITE_PAYLOAD_DIGEST"] ?? "";
  if (!/^[0-9a-f]{64}$/.test(expected) || artifactDigest(env, read) !== expected) {
    throw new Error("Downloaded artifact digest mismatch.");
  }
}

function isMissingWorker(error: unknown) {
  if (!(error instanceof Error)) return false;
  const failure = error as Error & { status?: number; signal?: string; stderr?: string };
  return failure.status === 1 && !failure.signal && /\[code: 10007\]/.test(failure.stderr ?? "");
}

async function assertDeploymentMode(mode: string, env: NodeJS.ProcessEnv, execute: Execute) {
  const wrangler = resolve("node_modules/wrangler/bin/wrangler.js");
  const verb = mode === "bootstrap" ? "list" : "status";
  let output: string;
  try {
    output = execute(
      process.execPath,
      [wrangler, "deployments", verb, "--config", CONFIG, "--env", "", "--json"],
      { env, timeout: 60_000, encoding: "utf8" },
    );
  } catch (error) {
    if (mode === "bootstrap" && isMissingWorker(error)) return;
    throw error;
  }
  const state: unknown = JSON.parse(output);
  if (mode === "bootstrap") {
    if (!Array.isArray(state) || state.length !== 0) {
      throw new Error("Bootstrap refuses an existing deployment; use publish.");
    }
  } else {
    const { activeVersionId } = await import("./check-workflow-hardening.ts");
    activeVersionId(state);
  }
}

async function deploy(
  candidate: ReturnType<typeof productionCandidate>,
  env: NodeJS.ProcessEnv,
  execute: Execute,
  read: (path: string) => Buffer,
) {
  const { deploymentVersionId } = await import("./check-workflow-hardening.ts");
  if (candidate.mode === "publish" && env["SITE_URL"] !== "https://nikkecollection.com") {
    throw new Error("Publish requires the explicit production origin.");
  }
  for (const key of [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "WRANGLER_OUTPUT_FILE_PATH",
  ]) {
    if (!env[key]) throw new Error(`Missing ${key}.`);
  }
  const digest = env["SITE_ARTIFACT_DIGEST"] ?? "";
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("Missing uploaded artifact digest.");
  assertArtifactDigest(env, read);
  assertBuiltRevision(candidate.sha, read);
  const args = siteDeploymentArguments(candidate.sha, read(CONFIG).toString());
  await assertDeploymentMode(candidate.mode, env, execute);
  execute(process.execPath, [resolve("node_modules/wrangler/bin/wrangler.js"), ...args], {
    env,
    timeout: 300_000,
    encoding: "utf8",
  });
  const output = read(env["WRANGLER_OUTPUT_FILE_PATH"] ?? "").toString();
  const versionId = deploymentVersionId(output, WORKER, "");
  return {
    ...candidate,
    versionId,
    artifactDigest: digest,
    payloadDigest: env["SITE_PAYLOAD_DIGEST"],
  };
}

function runVerification(
  command: string,
  candidate: ReturnType<typeof productionCandidate>,
  env: NodeJS.ProcessEnv,
  execute: Execute,
  read: (path: string) => Buffer,
  append: (path: string, text: string) => void,
) {
  assertVerificationCredentialsAbsent(env);
  if (command === "verify") {
    if (env["GITHUB_OUTPUT"]) append(env["GITHUB_OUTPUT"], `deploy_sha=${candidate.sha}\n`);
  } else if (command === "build") {
    const npmCli = env["R65_NPM_CLI"] ?? "";
    if (!isAbsolute(npmCli)) throw new Error("Pinned R65_NPM_CLI is required.");
    execute(process.execPath, [npmCli, "run", "build:site-production"], {
      env: childEnvironment(env, candidate.sha),
      timeout: 2_700_000,
      encoding: "utf8",
    });
    assertBuiltRevision(candidate.sha, read);
  } else if (command === "seal") {
    assertBuiltRevision(candidate.sha, read);
    const output = env["GITHUB_OUTPUT"];
    if (!output) throw new Error("GITHUB_OUTPUT is required.");
    append(output, `payload_digest=${artifactDigest(env, read)}\n`);
  } else if (command === "verify-artifact") {
    assertArtifactDigest(env, read);
  } else {
    throw new Error(
      "Usage: site-production-deployment.ts verify|build|seal|verify-artifact|deploy",
    );
  }
}

export async function run(command: string, dependencies: Dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const execute: Execute =
    dependencies.execute ?? ((cmd, args, options) => execFileSync(cmd, args, options));
  const read = dependencies.read ?? readFileSync;
  const append = dependencies.append ?? appendFileSync;
  const candidate = candidateFromEnvironment(env, execute);
  if (command !== "deploy") {
    runVerification(command, candidate, env, execute, read, append);
    return;
  }
  const summary = env["GITHUB_STEP_SUMMARY"];
  if (!summary) throw new Error("GITHUB_STEP_SUMMARY is required.");
  const evidence = await deploy(candidate, env, execute, read);
  append(
    summary,
    `### Site production deployment\n\n\`\`\`json\n${JSON.stringify(evidence)}\n\`\`\`\n`,
  );
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run(process.argv[2] ?? "");
}
