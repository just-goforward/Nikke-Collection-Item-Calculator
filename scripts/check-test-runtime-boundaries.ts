import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, parse, resolve } from "node:path";

const ROOT_VITEST_VERSION = "5.0.0";
const WORKER_VITEST_VERSION = "4.1.11";
const CLOUDFLARE_PLUGIN_VERSION = "1.1.4";
const WORKER_WORKSPACES = [
  "cloudflare",
  "forecast-collector",
  "forecast-dispatcher",
  "forecast-interactions",
  "stats-observer",
  "usage-guard",
] as const;

type PackageLock = {
  packages?: Record<string, { version?: string }>;
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function requireLockedVersion(
  packages: NonNullable<PackageLock["packages"]>,
  path: string,
  expected: string,
): void {
  const actual = packages[path]?.version;
  if (actual !== expected) {
    throw new Error(`Expected ${path} at ${expected}, received ${actual ?? "missing"}.`);
  }
}

function requireResolvedVersion(importer: string, packageName: string, expected: string): void {
  let directory: string;
  try {
    directory = dirname(createRequire(importer).resolve(packageName));
  } catch {
    directory = dirname(importer);
    const packageSegments = packageName.split("/");
    const root = parse(directory).root;
    while (
      !existsSync(resolve(directory, "node_modules", ...packageSegments, "package.json")) &&
      directory !== root
    ) {
      directory = dirname(directory);
    }
    directory = resolve(directory, "node_modules", ...packageSegments);
  }
  const root = parse(directory).root;
  let packagePath = resolve(directory, "package.json");
  while (!existsSync(packagePath) && directory !== root) {
    directory = dirname(directory);
    packagePath = resolve(directory, "package.json");
  }
  if (!existsSync(packagePath)) {
    throw new Error(`Could not locate package.json for ${packageName} imported from ${importer}.`);
  }
  const actual = readJson<{ version?: string }>(packagePath).version;
  if (actual !== expected) {
    throw new Error(
      `Expected ${packageName} imported from ${importer} at ${expected}, received ${actual ?? "missing"}.`,
    );
  }
}

const repositoryRoot = process.cwd();
const lock = readJson<PackageLock>(resolve(repositoryRoot, "package-lock.json"));
if (!lock.packages) {
  throw new Error("package-lock.json does not contain a packages map.");
}

requireLockedVersion(lock.packages, "node_modules/vitest", ROOT_VITEST_VERSION);
requireLockedVersion(lock.packages, "node_modules/@vitest/coverage-v8", ROOT_VITEST_VERSION);
requireResolvedVersion(resolve(repositoryRoot, "vitest.config.ts"), "vitest", ROOT_VITEST_VERSION);
requireResolvedVersion(
  resolve(repositoryRoot, "vitest.config.ts"),
  "@vitest/coverage-v8",
  ROOT_VITEST_VERSION,
);

for (const workspace of WORKER_WORKSPACES) {
  requireLockedVersion(lock.packages, `${workspace}/node_modules/vitest`, WORKER_VITEST_VERSION);
  requireLockedVersion(
    lock.packages,
    `${workspace}/node_modules/@vitest/coverage-v8`,
    WORKER_VITEST_VERSION,
  );
  requireLockedVersion(
    lock.packages,
    `${workspace}/node_modules/@cloudflare/vitest-plugin`,
    CLOUDFLARE_PLUGIN_VERSION,
  );
  const configPath = resolve(repositoryRoot, workspace, "vitest.config.ts");
  requireResolvedVersion(configPath, "vitest", WORKER_VITEST_VERSION);
  requireResolvedVersion(configPath, "@vitest/coverage-v8", WORKER_VITEST_VERSION);
  requireResolvedVersion(configPath, "@cloudflare/vitest-plugin", CLOUDFLARE_PLUGIN_VERSION);

  const manifest = readJson<{
    devDependencies?: Record<string, string>;
  }>(resolve(repositoryRoot, workspace, "package.json"));
  const expectedDependencies = {
    vitest: WORKER_VITEST_VERSION,
    "@vitest/coverage-v8": WORKER_VITEST_VERSION,
    "@cloudflare/vitest-plugin": CLOUDFLARE_PLUGIN_VERSION,
  } as const;
  for (const [name, expected] of Object.entries(expectedDependencies)) {
    const actual = manifest.devDependencies?.[name];
    if (actual !== expected) {
      throw new Error(
        `${workspace}/package.json must pin ${name} to ${expected}; received ${actual ?? "missing"}.`,
      );
    }
  }
}

const legacyPoolEntries = Object.keys(lock.packages).filter((path) =>
  path.includes("@cloudflare/vitest-pool-workers"),
);
if (legacyPoolEntries.length > 0) {
  throw new Error(
    `Legacy Cloudflare Vitest pool remains in the lockfile: ${legacyPoolEntries.join(", ")}`,
  );
}

console.log(
  `Test runtimes verified: root Vitest ${ROOT_VITEST_VERSION}; ${WORKER_WORKSPACES.length} Worker workspaces on Vitest ${WORKER_VITEST_VERSION} with @cloudflare/vitest-plugin ${CLOUDFLARE_PLUGIN_VERSION}.`,
);
