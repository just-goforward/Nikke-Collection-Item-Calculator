import {
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync, closeSync, fsyncSync, mkdtempSync, openSync, readdirSync,
  readFileSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
// schema.sql is a bootstrap snapshot, not migration 0001. Never replay it on an upgrade.
const BOOTSTRAP_VERSION = 21;
const PRODUCTION_OPTIONAL_VERSIONS = new Set([4, 5, 6]);
const CATALOG_QUERY = `SELECT name, type FROM sqlite_master
WHERE type IN ('table', 'view') AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'
ORDER BY name;`;
const LEDGER_QUERY = "SELECT version, applied_at FROM schema_migrations ORDER BY version;";
const PREREQUISITES = [{ migration: 12, requires: 5 }] as const;
const PREREQUISITE_SCHEMA_QUERY = `SELECT type,name,sql FROM sqlite_schema
WHERE name IN ('discord_staging_adoptions','discord_staging_adoptions_state_expires_idx',
  'discord_staging_adoptions_message_id_unique_idx') ORDER BY name LIMIT 4;`;

type Migration = { version: number; file: string };
type Options = {
  environment: "staging" | "production";
  local: boolean;
  persistTo?: string;
  allowForecastV2?: boolean;
  checkpointPlan?: string;
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
  .array(z.object({
    version: z.number().int().positive(),
    applied_at: z.string().refine((value) => value.trim().length > 0),
  }))
  .nonempty();

// Wrangler 4.x writes non-interactive spinner lines (prefixed with ├, │ or └) to stdout
// before the JSON result of `d1 execute --file --json`. Accept only that preamble.
export function parseWranglerJson(stdout: string): unknown {
  const start = stdout.search(/^[[{]/m);
  if (start < 0) throw new Error("Wrangler returned invalid D1 JSON.");
  const preamble = stdout.slice(0, start).split(/\r?\n/);
  if (preamble.some((line) => line.trim() !== "" && !/^[├│└]/.test(line))) {
    throw new Error("Wrangler returned invalid D1 JSON.");
  }
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    throw new Error("Wrangler returned invalid D1 JSON.");
  }
}

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
      "allow-forecast-v2": { type: "boolean" },
      "checkpoint-plan": { type: "string" },
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
    ...(values["allow-forecast-v2"] === true ? { allowForecastV2: true } : {}),
    ...(values["checkpoint-plan"] !== undefined ? { checkpointPlan: values["checkpoint-plan"] } : {}),
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

function validateTargetEnvironment(options: Options) {
  if (options.environment !== "staging" && options.environment !== "production") {
    throw new Error("An explicit --env staging or --env production is required.");
  }
}

function validateV2Authorization(options: Options, migrations: Migration[]) {
  const gated = migrations.filter((migration) => migration.version >= 30);
  // No ledger reads are permitted before this gate, so authorize the inventory,
  // including already-applied versions, rather than guessing remote pending state.
  if (gated.length > 0 && options.allowForecastV2 !== true) {
    throw new Error(
      `Forecast v2 migrations require --allow-forecast-v2: ${gated.map((migration) => migration.version).join(", ")}.`,
    );
  }
}

function schemaTokens(sql: string) {
  return (
    sql.match(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"[^"]+"|[A-Za-z_][A-Za-z0-9_]*|\d+|[^\s;]/g) ?? []
  )
    .filter((token) => !token.startsWith("--") && !token.startsWith("/*"))
    .map((token) => (token.startsWith("'") ? token : token.replace(/^"|"$/g, "").toLowerCase()))
    .filter((token, index, tokens) =>
      !(token === "if" && tokens[index + 1] === "not" && tokens[index + 2] === "exists") &&
      !(token === "not" && tokens[index - 1] === "if" && tokens[index + 1] === "exists") &&
      !(token === "exists" && tokens[index - 2] === "if" && tokens[index - 1] === "not"),
    );
}

function createSql(source: string, name: string) {
  const sql = source.match(
    new RegExp(`CREATE\\s+(?:UNIQUE\\s+)?(?:TABLE|INDEX)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${name}\\b[^;]*;`, "i"),
  )?.[0];
  if (!sql) throw new Error(`Missing prerequisite schema contract: ${name}`);
  return schemaTokens(sql).join("\0");
}

function validatePrerequisiteSchema(root: string, versions: number[], rows: unknown[]) {
  const parsed = z.array(z.object({ type: z.string(), name: z.string(), sql: z.string().nullable() })).safeParse(rows);
  if (!parsed.success) throw new Error("Invalid prerequisite schema metadata.");
  const objects = new Map(parsed.data.map((row) => [row.name, row]));
  const table = "discord_staging_adoptions";
  const index = `${table}_state_expires_idx`;
  const identityIndex = `${table}_message_id_unique_idx`;
  const source5 = readFileSync(resolve(root, "forecast-collector/migrations/0005_discord_staging_adoptions.sql"), "utf8");
  const source6 = readFileSync(resolve(root, "forecast-collector/migrations/0006_discord_staging_message_identity.sql"), "utf8");
  const bootstrap = readFileSync(resolve(root, "forecast-collector/schema.sql"), "utf8");
  const matches = (name: string, type: string, expected: string) => {
    const row = objects.get(name);
    return row?.type === type && row.sql !== null && row.sql !== undefined &&
      schemaTokens(row.sql).join("\0") === expected;
  };
  let parentMatches = matches(table, "table", createSql(source5, table));
  if (versions.includes(6)) {
    const additions = [...source6.matchAll(/ADD COLUMN\s+([^;]+);/g)].map((match) => match[1]);
    if (additions.length !== 2) throw new Error("Invalid migration6 schema contract.");
    const withIdentity = source5.replace(/,\s*CHECK\s*\(/, `,${additions.join(",")},CHECK (`);
    const identityMatches = matches(identityIndex, "index", createSql(source6, identityIndex));
    const bootstrapMatches = matches(table, "table", createSql(bootstrap, table));
    parentMatches = (bootstrapMatches && (!objects.has(identityIndex) || identityMatches)) ||
      (matches(table, "table", createSql(withIdentity, table)) && identityMatches);
  } else if (objects.has(identityIndex)) {
    parentMatches = false;
  }
  if (!parentMatches || !matches(index, "index", createSql(source5, index))) {
    throw new Error("migration_prerequisite_schema: version 5 parent/index differs from its applied schema contract; reconcile before any migration write.");
  }
}

const checkpointPlanSchema = z.object({
  version: z.literal(1),
  local: z.boolean(),
  persistTo: z.string().min(1).optional(),
  migration: z.number().int().refine((version) => version === 5 || version >= 11),
  expectedLedger: ledgerRows,
  files: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })),
  receiptPath: z.string().refine(isAbsolute),
}).strict();

function openCheckpoint(options: Options, root: string, migrations: Migration[]) {
  if (options.environment !== "production") {
    throw new Error("checkpoint_environment: checkpoint plans are production-only.");
  }
  const planBytes = readFileSync(resolve(options.checkpointPlan!));
  const plan = checkpointPlanSchema.parse(JSON.parse(planBytes.toString("utf8")));
  if (plan.local !== options.local || plan.persistTo !== options.persistTo) {
    throw new Error("checkpoint_target_changed: local/remote or persist-to differs from the plan.");
  }
  const paths = [
    "scripts/apply-forecast-d1-migrations.ts", "package-lock.json",
    "forecast-collector/wrangler.toml", "forecast-collector/schema.sql",
    "forecast-collector/preflight-0011.sql",
    ...migrations.map(({ file }) => relative(root, file).replaceAll("\\", "/")),
  ];
  const approved = new Map(plan.files.map(({ path, sha256 }) => [path, sha256]));
  if (approved.size !== plan.files.length || approved.size !== paths.length ||
    paths.some((path) => !approved.has(path))) {
    throw new Error("checkpoint_input_inventory: the complete input manifest is required.");
  }
  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const frozen = new Map(paths.map((path) => [path, readFileSync(resolve(root, path))]));
  function assertInputs() {
    for (const path of paths) {
      if (hash(readFileSync(resolve(root, path))) !== approved.get(path)) {
        throw new Error(`checkpoint_input_changed: ${path}`);
      }
    }
  }
  assertInputs();
  for (const [path, bytes] of frozen) {
    if (hash(bytes) !== approved.get(path)) throw new Error(`checkpoint_input_changed: ${path}`);
  }
  validateLedger(plan.expectedLedger, migrations, options.environment);
  if (!migrations.some(({ version }) => version === plan.migration)) {
    throw new Error("checkpoint_next_migration: selected file does not exist.");
  }
  // Exclusive creation is the crash/unknown-outcome interlock. Never truncate or
  // automatically remove this receipt, even when no successful response arrives.
  const fd = openSync(plan.receiptPath, "wx", 0o600);
  const checkpoint = {
    plan,
    submitted: false,
    ledgerChecked: false,
    assertInputs,
    record(event: Record<string, unknown>) {
      appendFileSync(fd, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
      fsyncSync(fd);
    },
    checkLedger(rows: unknown[]) {
      const actual = ledgerRows.parse(rows);
      if (!checkpoint.ledgerChecked) {
        if (JSON.stringify(actual) !== JSON.stringify(plan.expectedLedger)) {
          throw new Error("checkpoint_ledger_changed: reconcile before any file submission.");
        }
        checkpoint.ledgerChecked = true;
      } else if (plan.expectedLedger.some((before) =>
        !actual.some((after) => after.version === before.version && after.applied_at === before.applied_at))) {
        throw new Error("checkpoint_ledger_changed: existing ledger timestamps changed.");
      }
    },
    freezeSql(file: string) {
      const path = relative(root, file).replaceAll("\\", "/");
      const bytes = frozen.get(path);
      if (!bytes) throw new Error("checkpoint_input_inventory: unapproved SQL file.");
      const directory = mkdtempSync(join(dirname(plan.receiptPath), ".forecast-checkpoint-"));
      const copy = join(directory, basename(file));
      writeFileSync(copy, bytes, { flag: "wx", mode: 0o600 });
      return copy;
    },
    close() { closeSync(fd); },
  };
  try {
    checkpoint.record({
      type: "attempt", outcome: "unknown", planSha256: hash(planBytes),
      environment: options.environment, local: options.local, persistTo: options.persistTo,
      migration: plan.migration, files: plan.files, expectedLedger: plan.expectedLedger,
    });
  } catch (error) {
    checkpoint.close();
    throw error;
  }
  return checkpoint;
}

function applyMigrations(
  options: Options, dependencies: Dependencies, migrations: Migration[],
  checkpoint?: ReturnType<typeof openCheckpoint>,
) {
  const root = dependencies.root ?? REPOSITORY_ROOT;
  const spawn = dependencies.spawn ?? spawnSync;
  const log = dependencies.log ?? console.log;
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
    checkpoint?.assertInputs();
    if (checkpoint && input === "--file") {
      value = checkpoint.freezeSql(value);
      checkpoint.record({ type: "submitting", input, value });
      checkpoint.submitted = true;
    }
    const inputArgs = input === "--command" ? [`--command=${value}`] : [input, value];
    const result = spawn(process.execPath, [...args, ...inputArgs], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    checkpoint?.record({
      type: "result", input, value, status: result.status, signal: result.signal,
      error: result.error?.message, stdout: result.stdout, stderr: result.stderr,
    });
    if (result.error || result.signal || result.status !== 0) {
      const detail = (result.stderr || result.stdout || "").trim().slice(-4_000);
      const detailSuffix = detail ? `\n${detail}` : "";
      throw new Error(
        `Wrangler D1 ${input} failed (${result.error?.message ?? result.signal ?? result.status}): ${value}${detailSuffix}`,
      );
    }
    const payload = parseWranglerJson(result.stdout);
    const parsed = commandResults.safeParse(payload);
    const first = parsed.success ? parsed.data[0] : undefined;
    if (!parsed.success || !first || (input === "--command" && parsed.data.length !== 1)) {
      throw new Error("Wrangler returned invalid or unsuccessful D1 results.");
    }
    return first.results;
  }

  function readLedger() {
    const rows = execute("--command", LEDGER_QUERY);
    const versions = validateLedger(rows, migrations, options.environment);
    checkpoint?.checkLedger(rows);
    return versions;
  }

  function validatePrerequisites(versions: number[]) {
    const available = new Set(versions);
    for (const migration of migrations) {
      if (!isRequired(migration.version, options.environment)) continue;
      for (const prerequisite of PREREQUISITES) {
        if (migration.version === prerequisite.migration && !available.has(prerequisite.requires)) {
          throw new Error(`migration_prerequisite_missing: version ${prerequisite.requires} requires separate approval/application before the version ${prerequisite.migration} chain; no migration writes performed.`);
        }
      }
      available.add(migration.version);
    }
    if (versions.includes(5) && migrations.some(({ version }) => version === 12)) {
      validatePrerequisiteSchema(root, versions, execute("--command", PREREQUISITE_SCHEMA_QUERY));
    }
  }

  const catalog = catalogRows.safeParse(execute("--command", CATALOG_QUERY));
  if (!catalog.success) throw new Error("Wrangler returned invalid D1 catalog rows.");
  let versions: number[];
  const ledger = catalog.data.find((row) => row.name === "schema_migrations");
  let bootstrapped = false;
  if (ledger?.type === "table") {
    versions = readLedger();
  } else {
    if (checkpoint) throw new Error("checkpoint_bootstrap_forbidden: an existing ledger is required.");
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

  if (checkpoint) {
    const next = !versions.includes(5) ? 5 :
      migrations.find(({ version }) => isRequired(version, options.environment) && !versions.includes(version))?.version;
    if (checkpoint.plan.migration !== next) {
      throw new Error(`checkpoint_next_migration: expected ${next ?? "none"}, not ${checkpoint.plan.migration}.`);
    }
    validateLedger([
      ...checkpoint.plan.expectedLedger,
      { version: checkpoint.plan.migration, applied_at: "pending-validation" },
    ].sort((left, right) => left.version - right.version), migrations, options.environment);
  }
  if (checkpoint?.plan.migration !== 5) validatePrerequisites(versions);
  const applied: number[] = [];
  for (const migration of migrations) {
    if (checkpoint ? migration.version !== checkpoint.plan.migration :
      !isRequired(migration.version, options.environment) || versions.includes(migration.version))
      continue;
    if (migration.version === 11) {
      const query = readFileSync(resolve(root, "forecast-collector/preflight-0011.sql"), "utf8");
      const duplicates = execute("--command", query);
      if (duplicates.length) {
        throw new Error(
          `duplicate_candidate_revision_preflight: ${JSON.stringify(duplicates)}; preserve rows and reconcile before migration 0011.`,
        );
      }
    }
    log(`Applying Forecast migration ${migration.version} (${options.environment}).`);
    execute("--file", migration.file);
    const verified = readLedger();
    const expected = [...versions, migration.version].sort((left, right) => left - right);
    verifyAppliedVersions(verified, expected, `Forecast migration ${migration.version}`);
    versions = verified;
    if (migration.version === 5 || migration.version === 6) validatePrerequisites(versions);
    applied.push(migration.version);
  }
  log(`Forecast D1 migrations verified (${options.environment}): ${versions.join(", ")}.`);
  return { bootstrapped, applied, versions };
}

export function applyForecastD1Migrations(options: Options, dependencies: Dependencies = {}) {
  validateTargetEnvironment(options);
  if (options.environment === "production" && !options.local && !options.checkpointPlan) {
    throw new Error("checkpoint_plan_required: remote production requires a single-file checkpoint plan.");
  }
  const root = dependencies.root ?? REPOSITORY_ROOT;
  // Validate the complete sequence and V2 gate before any transport or receipt.
  const migrations = discoverForecastMigrations(resolve(root, "forecast-collector/migrations"));
  validateV2Authorization(options, migrations);
  const checkpoint = options.checkpointPlan ? openCheckpoint(options, root, migrations) : undefined;
  try {
    const result = applyMigrations(options, dependencies, migrations, checkpoint);
    checkpoint?.record({ type: "complete", outcome: "verified", ...result });
    return result;
  } catch (error) {
    const outcome = checkpoint?.submitted ? "unknown" : "blocked";
    checkpoint?.record({
      type: "stopped", outcome, error: error instanceof Error ? error.message : String(error),
    });
    if (checkpoint?.submitted) {
      throw new Error("checkpoint_unknown: reconcile the retained receipt; do not replay this approval.", { cause: error });
    }
    throw error;
  } finally {
    checkpoint?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    applyForecastD1Migrations(parseMigrationArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Forecast D1 migrations failed.");
    process.exitCode = 1;
  }
}
