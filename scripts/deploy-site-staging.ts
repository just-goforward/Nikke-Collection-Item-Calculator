import {
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const PERSONAL_CONFIG = "site-worker/personal-data-staging.wrangler.json";
const FORECAST_CONFIG = "site-worker/forecast-runtime.json";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Dependencies = {
  root?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: (
    command: string,
    args: string[],
    options: SpawnSyncOptionsWithStringEncoding,
  ) => SpawnSyncReturns<string>;
  read?: (path: string) => string;
};

function assertForecastKey(root: string, read: (path: string) => string) {
  const key: unknown = JSON.parse(read(resolve(root, FORECAST_CONFIG))).publicKeyBase64;
  const bytes = typeof key === "string" ? Buffer.from(key, "base64") : null;
  if (!bytes || bytes.byteLength !== 32 || bytes.toString("base64") !== key)
    throw new Error(
      `Replace the placeholder public key in ${FORECAST_CONFIG} with a canonical base64-encoded raw 32-byte Ed25519 public key before deployment.`,
    );
}

function assertProvisioning(
  env: NodeJS.ProcessEnv,
  dryRun: boolean,
  root: string,
  read: (path: string) => string,
) {
  for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
    if (!env[key]?.trim()) throw new Error(`${key} must be supplied through the environment.`);
  }
  assertForecastKey(root, read);
  if (dryRun) return;
  if (env["SITE_STAGING_PROVISIONED"] !== "true") {
    throw new Error(
      "Set SITE_STAGING_PROVISIONED=true only after staging databases, migrations, service bindings, domain and OAuth secrets are provisioned.",
    );
  }
  const config = JSON.parse(read(resolve(root, PERSONAL_CONFIG)));
  const databases = config.env.staging.d1_databases;
  if (
    databases.length !== 3 ||
    databases.some((database: { database_id: string }) => !UUID.test(database.database_id)) ||
    new Set(databases.map((database: { database_id: string }) => database.database_id)).size !== 3
  ) {
    throw new Error("Replace the three staging-only D1 IDs before deployment.");
  }
}

/**
 * Local-only orchestration. No installation, login, migration or provisioning.
 * A dry run uses the same guards and verification gates, but never uploads.
 */
export function deploySiteStaging(args: string[], dependencies: Dependencies = {}): void {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--dry-run")) {
    throw new Error("Usage: npm run deploy:site-staging -- [--dry-run]");
  }
  const dryRun = args[0] === "--dry-run";
  const root = dependencies.root ?? ROOT;
  const env: NodeJS.ProcessEnv = {
    ...(dependencies.env ?? process.env),
    WRANGLER_SEND_METRICS: "false",
  };
  const spawn = dependencies.spawn ?? spawnSync;
  const read = dependencies.read ?? ((path: string) => readFileSync(path, "utf8"));

  function run(command: string, commandArgs: string[], credentials = false, capture = false) {
    const childEnv: NodeJS.ProcessEnv = { ...env };
    if (!credentials) {
      delete childEnv["CLOUDFLARE_API_TOKEN"];
      delete childEnv["CLOUDFLARE_ACCOUNT_ID"];
    }
    const result = spawn(command, commandArgs, {
      cwd: root,
      env: childEnv,
      encoding: "utf8",
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      // npm.cmd is a Windows batch file. Only fixed npm arguments use a shell.
      shell: process.platform === "win32" && command === "npm.cmd",
      windowsHide: true,
    });
    if (result.error || result.signal || result.status !== 0) {
      throw new Error(
        `Staging stopped: ${commandArgs.join(" ")} (${result.error?.message ?? result.signal ?? result.status}).`,
      );
    }
    return result.stdout?.trim() ?? "";
  }

  function snapshot() {
    if (run("git", ["branch", "--show-current"], false, true) !== "next") {
      throw new Error("Staging requires branch next (not a detached HEAD).");
    }
    if (run("git", ["status", "--porcelain", "--untracked-files=all"], false, true)) {
      throw new Error("Staging requires a clean working tree, including untracked files.");
    }
    return run("git", ["rev-parse", "HEAD"], false, true);
  }

  const sha = snapshot();
  assertProvisioning(env, dryRun, root, read);

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  // Same workflow gates; deployment credentials are absent from every verifier.
  for (const script of ["lint", "typecheck", "typecheck:site-staging"]) {
    run(npm, ["run", script]);
  }
  run(process.execPath, [
    resolve(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--configLoader",
    "runner",
    "scripts/deploy-site-staging.spec.ts",
    "scripts/build-site-staging.spec.ts",
    "scripts/site-worker.spec.ts",
  ]);
  for (const script of ["build:site-staging", "check:site-staging", "smoke:site-staging"]) {
    run(npm, ["run", script]);
  }
  // Verification must not change tracked sources, and concurrent commits invalidate it.
  if (snapshot() !== sha) throw new Error("HEAD changed during staging verification.");
  for (const config of [PERSONAL_CONFIG, "site-worker/wrangler.toml"]) {
    // dist is gitignored; reject a concurrent production build before either upload.
    run(npm, ["run", "check:site-staging"]);
    run(
      process.execPath,
      [
        resolve(root, "node_modules/wrangler/bin/wrangler.js"),
        "deploy",
        "--config",
        config,
        "--env",
        "staging",
        "--tag",
        sha,
        "--message",
        `Site staging ${sha}`,
        ...(dryRun ? ["--dry-run"] : []),
      ],
      true,
    );
    if (snapshot() !== sha) throw new Error("HEAD changed during staging deployment; stopped.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  deploySiteStaging(process.argv.slice(2));
}
