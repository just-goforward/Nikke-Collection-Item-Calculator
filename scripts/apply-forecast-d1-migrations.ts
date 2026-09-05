import {
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
// schema.sql is a bootstrap snapshot, not migration 0001. Never replay it on an upgrade.
const BOOTSTRAP_VERSION = 10;
const PRODUCTION_OPTIONAL_VERSIONS = new Set([4, 5, 6]);
const CATALOG_QUERY = `SELECT name, type FROM sqlite_master
WHERE type IN ('table', 'view') AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'
ORDER BY name;`;
const LEDGER_QUERY = "SELECT version, applied_at FROM schema_migrations ORDER BY version;";

type Migration = { version: number; file: string };
type Options = {
  environment: "staging" | "production";
  local: boolean;
  persistTo?: string;
};
type Dependencies = {
  root?: string;
  spawn?: (
    command: string,
    args: string[],
    options: SpawnSyncOptionsWithStringEncoding,
  ) => SpawnSyncReturns<string>;
  log?: (message: string) => void;
};

const commandResults = z
  .array(z.object({ success: z.literal(true), results: z.array(z.unknown()) }))
  .nonempty();
const catalogRows = z.array(z.object({ name: z.string().min(1), type: z.enum(["table", "view"]) }));
const ledgerRows = z
  .array(z.object({ version: z.number().int().positive(), applied_at: z.string().trim().min(1) }))
  .nonempty();

export function parseMigrationArguments(args: string[]): Options {
  const { values, tokens } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    tokens: true,
    options: {
      env: { type: "string" },
      local: { type: "boolean" },
      remote: { type: "boolean" },
      "persist-to": { type: "string" },
    },
  });
  const names = tokens.filter((token) => token.kind === "option").map((token) => token.name);
  if (new Set(names).size !== names.length) throw new Error("Duplicate migration option.");
  if (values.env !== "staging" && values.env !== "production") {
    throw new Error("An explicit --env staging or --env production is required.");
  }
  if (Boolean(values.local) === Boolean(values.remote)) {
    throw new Error("Specify exactly one of --local or --remote.");
  }
  const persistTo = values["persist-to"];
  if (persistTo !== undefined && (!values.local || !persistTo.trim())) {
    throw new Error("--persist-to requires --local and a nonempty path.");
  }
  return {
    environment: values.env,
    local: values.local === true,
    ...(persistTo !== undefined ? { persistTo } : {}),
  };
}

export function discoverForecastMigrations(directory: string): Migration[] {
  const migrations = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => /\.sql$/i.test(entry.name))
    .map((entry) => {
      const match = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/.exec(entry.name);
      if (!entry.isFile() || !match || Number(match[1]) < 2) {
        throw new Error(`Invalid Forecast migration filename: ${entry.name}`);
      }
      return { version: Number(match[1]), file: resolve(directory, entry.name) };
    })
    .sort((left, right) => left.version - right.version);
  if (migrations.length === 0) throw new Error("No Forecast migrations found.");
  for (const [index, migration] of migrations.entries()) {
    if (migration.version !== index + 2) {
      throw new Error(
        `Forecast migrations must have unique, consecutive versions from 2: ${migration.file}`,
      );
    }
  }
  return migrations;
}

function isRequired(version: number, environment: Options["environment"]) {
  // Existing production databases may omit the Discord-only 0004..0006 branch.
  return environment === "staging" || !PRODUCTION_OPTIONAL_VERSIONS.has(version);
}

function validateLedger(
  rows: unknown[],
  migrations: Migration[],
  environment: Options["environment"],
) {
  const parsed = ledgerRows.safeParse(rows);
  if (!parsed.success) throw new Error("Invalid or empty schema_migrations ledger.");
  const known = [1, ...migrations.map((migration) => migration.version)];
  const versions = parsed.data.map((row) => row.version);
  for (const [index, version] of versions.entries()) {
    if (!known.includes(version)) throw new Error(`Unknown schema_migrations version: ${version}`);
    if (version <= (versions[index - 1] ?? 0)) {
      throw new Error("schema_migrations versions must be unique and ordered.");
    }
    for (const predecessor of known.filter((candidate) => candidate < version)) {
      // 0004 and 0005 are independent table seeds; only 0006 needs the 0005 table.
      if (
        (isRequired(predecessor, environment) || (version === 6 && predecessor === 5)) &&
        !versions.includes(predecessor)
      ) {
        throw new Error(
          `Gap in schema_migrations ledger: missing version ${predecessor} before ${version}.`,
        );
      }
    }
  }
  return versions;
}

function verifyAppliedVersions(versions: number[], expected: number[], operation: string) {
  if (
    versions.length !== expected.length ||
    versions.some((version, index) => version !== expected[index])
  ) {
    throw new Error(`${operation} did not produce the expected ledger; stopping.`);
  }
}

export function applyForecastD1Migrations(options: Options, dependencies: Dependencies = {}) {
  const root = dependencies.root ?? REPOSITORY_ROOT;
  const spawn = dependencies.spawn ?? spawnSync;
  const log = dependencies.log ?? console.log;
  // Validate the complete file sequence before invoking Wrangler, including on an up-to-date DB.
  const migrations = discoverForecastMigrations(resolve(root, "forecast-collector/migrations"));
  const args = [
    resolve(root, "node_modules/wrangler/bin/wrangler.js"),
    "d1",
    "execute",
    "FORECAST_DB",
    options.local ? "--local" : "--remote",
    options.environment === "staging" ? "--env=staging" : "--env=",
    "--config",
    resolve(root, "forecast-collector/wrangler.toml"),
    "--json",
    "--yes",
  ];
  if (options.persistTo !== undefined) args.push("--persist-to", options.persistTo);

  function execute(input: "--command" | "--file", value: string) {
    const result = spawn(process.execPath, [...args, input, value], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error || result.signal || result.status !== 0) {
      const detail = (result.stderr || result.stdout || "").trim().slice(-4_000);
      throw new Error(
        `Wrangler D1 ${input} failed (${result.error?.message ?? result.signal ?? result.status}): ${value}${detail ? `\n${detail}` : ""}`,
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      throw new Error("Wrangler returned invalid D1 JSON.");
    }
    const parsed = commandResults.safeParse(payload);
    const first = parsed.success ? parsed.data[0] : undefined;
    if (!parsed.success || !first || (input === "--command" && parsed.data.length !== 1)) {
      throw new Error("Wrangler returned invalid or unsuccessful D1 results.");
    }
    return first.results;
  }

  function readLedger() {
    return validateLedger(execute("--command", LEDGER_QUERY), migrations, options.environment);
  }

  const catalog = catalogRows.safeParse(execute("--command", CATALOG_QUERY));
  if (!catalog.success) throw new Error("Wrangler returned invalid D1 catalog rows.");
  let versions: number[];
  const ledger = catalog.data.find((row) => row.name === "schema_migrations");
  let bootstrapped = false;
  if (ledger?.type === "table") {
    versions = readLedger();
  } else {
    if (catalog.data.length !== 0) {
      throw new Error(
        "Missing schema_migrations ledger on a nonempty database; refusing bootstrap.",
      );
    }
    log(`Bootstrapping Forecast D1 (${options.environment}).`);
    execute("--file", resolve(root, "forecast-collector/schema.sql"));
    versions = readLedger();
    verifyAppliedVersions(
      versions,
      Array.from({ length: BOOTSTRAP_VERSION }, (_, index) => index + 1),
      "Forecast bootstrap",
    );
    bootstrapped = true;
  }

  const applied: number[] = [];
  for (const migration of migrations) {
    if (!isRequired(migration.version, options.environment) || versions.includes(migration.version))
      continue;
    log(`Applying Forecast migration ${migration.version} (${options.environment}).`);
    execute("--file", migration.file);
    const verified = readLedger();
    const expected = [...versions, migration.version].sort((left, right) => left - right);
    verifyAppliedVersions(verified, expected, `Forecast migration ${migration.version}`);
    versions = verified;
    applied.push(migration.version);
  }
  log(`Forecast D1 migrations verified (${options.environment}): ${versions.join(", ")}.`);
  return { bootstrapped, applied, versions };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    applyForecastD1Migrations(parseMigrationArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Forecast D1 migrations failed.");
    process.exitCode = 1;
  }
}
