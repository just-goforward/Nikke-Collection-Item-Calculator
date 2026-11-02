import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { applyForecastD1Migrations, parseMigrationArguments } from "./apply-forecast-d1-migrations.ts";

const sourceRoot = resolve(import.meta.dirname, "..");
const initial = [1, 2, 3, 7, 8, 9, 10].map((version) => ({
  version, applied_at: "2020-02-03T04:05:06Z",
}));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixture(t, migration = 5, before = initial) {
  const root = mkdtempSync(join(tmpdir(), "forecast-checkpoint-"));
  t.after(() => rmSync(root, { recursive: true }));
  const paths = [
    "scripts/apply-forecast-d1-migrations.ts", "package-lock.json",
    "forecast-collector/wrangler.toml", "forecast-collector/schema.sql",
    "forecast-collector/preflight-0011.sql",
    ...readdirSync(join(sourceRoot, "forecast-collector/migrations"))
      .filter((name) => name.endsWith(".sql")).sort()
      .map((name) => `forecast-collector/migrations/${name}`),
  ];
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(sourceRoot, path), join(root, path));
  }
  const plan = {
    version: 1, local: true, migration, expectedLedger: structuredClone(before),
    files: paths.map((path) => ({ path, sha256: digest(readFileSync(join(root, path))) })),
    receiptPath: join(root, "receipt.jsonl"),
  };
  const planPath = join(root, "plan.json");
  const save = () => writeFileSync(planPath, JSON.stringify(plan));
  save();
  const calls = [];
  const files = [];
  let ledger = structuredClone(before);
  let afterFile = () => {};
  const prerequisite = () => {
    const sql = readFileSync(join(root, "forecast-collector/migrations/0005_discord_staging_adoptions.sql"), "utf8");
    return ["discord_staging_adoptions", "discord_staging_adoptions_state_expires_idx"]
      .map((name) => ({
        name, type: name.endsWith("_idx") ? "index" : "table",
        sql: sql.match(new RegExp(`CREATE\\s+(?:UNIQUE\\s+)?(?:TABLE|INDEX)\\s+(?:IF NOT EXISTS\\s+)?${name}\\b[^;]*;`, "i"))[0],
      }));
  };
  const spawn = (_command, args) => {
    calls.push(args);
    let results;
    const fileIndex = args.indexOf("--file");
    if (fileIndex >= 0) {
      const path = args[fileIndex + 1];
      files.push({ path, bytes: readFileSync(path) });
      const version = Number(basename(path).slice(0, 4));
      ledger = [...ledger, { version, applied_at: "2020-02-04T04:05:06Z" }]
        .sort((a, b) => a.version - b.version);
      const result = afterFile(ledger);
      if (result) return result;
      results = [];
    } else {
      const sql = args.find((arg) => arg.startsWith("--command=")).slice(10);
      if (sql.includes("SELECT name, type FROM sqlite_master")) {
        results = [{ name: "schema_migrations", type: "table" }];
      } else if (sql.includes("SELECT version, applied_at")) {
        results = ledger;
      } else if (sql.includes("SELECT type,name,sql")) {
        results = prerequisite();
      } else if (sql.includes("GROUP_CONCAT")) {
        results = [];
      } else {
        throw new Error("Unexpected synthetic query");
      }
    }
    const stdout = JSON.stringify([{
      success: true, results,
      meta: { finalBookmark: "synthetic-bookmark", rows_read: 2, rows_written: files.length },
    }]);
    return { status: 0, signal: null, stdout, stderr: "synthetic-receipt", output: [null, stdout, "synthetic-receipt"] };
  };
  return {
    root, plan, planPath, save, calls, files,
    setAfterFile(callback) { afterFile = callback; },
    clearCatalog() {
      return (_command, args) => {
        calls.push(args);
        const stdout = JSON.stringify([{ success: true, results: [] }]);
        return { status: 0, signal: null, stdout, stderr: "" };
      };
    },
    run(transport = spawn) {
      return applyForecastD1Migrations({
        environment: "production", local: true, allowForecastV2: true, checkpointPlan: planPath,
      }, { root, spawn: transport, log() {} });
    },
    receipts() {
      return readFileSync(plan.receiptPath, "utf8").trim().split("\n").map((row) => JSON.parse(row));
    },
  };
}

test("remote production requires an explicit checkpoint plan before any transport call", () => {
  let calls = 0;
  assert.throws(() => applyForecastD1Migrations({
    environment: "production", local: false, allowForecastV2: true,
  }, { spawn() { calls++; throw new Error("unexpected_transport"); } }), /checkpoint_plan_required/);
  assert.equal(calls, 0);
});

test("checkpoint applies only separately selected 0005, preserves receipts, and cannot replay", (t) => {
  const f = fixture(t);
  assert.equal(parseMigrationArguments([
    "--env", "production", "--local", "--allow-forecast-v2", "--checkpoint-plan", f.planPath,
  ]).checkpointPlan, f.planPath);
  const expected = readFileSync(join(f.root, "forecast-collector/migrations/0005_discord_staging_adoptions.sql"));
  assert.deepEqual(f.run().applied, [5]);
  assert.equal(f.files.length, 1);
  assert.deepEqual(f.files[0].bytes, expected);
  const receipts = f.receipts();
  assert.equal(receipts.at(-1).outcome, "verified");
  const submitted = receipts.find((row) => row.type === "result" && row.input === "--file");
  assert.equal(JSON.parse(submitted.stdout)[0].meta.finalBookmark, "synthetic-bookmark");
  assert.equal(submitted.stderr, "synthetic-receipt");
  const calls = f.calls.length;
  assert.throws(() => f.run(), /EEXIST|checkpoint_already_attempted/);
  assert.equal(f.calls.length, calls);
});

test("an incremental checkpoint stops after 0011 instead of submitting 0012", (t) => {
  const f = fixture(t, 11, [...initial, { version: 5, applied_at: "2020-02-03T04:05:06Z" }]
    .sort((a, b) => a.version - b.version));
  assert.deepEqual(f.run().applied, [11]);
  assert.equal(f.files.length, 1);
  assert.match(basename(f.files[0].path), /^0011_/);
});

test("changed approved SQL is rejected before transport and no receipt authorizes it", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "forecast-collector/migrations/0005_discord_staging_adoptions.sql"), "-- changed");
  assert.throws(() => f.run(), /checkpoint_input_changed/);
  assert.equal(f.calls.length, 0);
});

test("checkpoint refuses bootstrap, stale ledger timestamps, and a skipped file", (t) => {
  const empty = fixture(t);
  assert.throws(() => empty.run(empty.clearCatalog()), /checkpoint_bootstrap_forbidden/);
  assert.equal(empty.files.length, 0);
  const stale = fixture(t);
  stale.plan.expectedLedger[0].applied_at = "stale";
  stale.save();
  assert.throws(() => stale.run(), /checkpoint_ledger_changed/);
  assert.equal(stale.files.length, 0);
  const skip = fixture(t, 12);
  assert.throws(() => skip.run(), /checkpoint_next_migration/);
  assert.equal(skip.files.length, 0);
});

test("lost response after submission remains unknown and blocks a second submission", (t) => {
  const f = fixture(t);
  f.setAfterFile(() => ({
    status: null, signal: "SIGTERM", error: new Error("synthetic_timeout"),
    stdout: "partial receipt", stderr: "synthetic timeout",
  }));
  assert.throws(() => f.run(), /checkpoint_unknown/);
  assert.equal(f.files.length, 1);
  assert.equal(f.receipts().at(-1).outcome, "unknown");
  const calls = f.calls.length;
  assert.throws(() => f.run(), /EEXIST|checkpoint_already_attempted/);
  assert.equal(f.calls.length, calls);
  assert.equal(f.files.length, 1);
});

test("0005 refuses missing required predecessors before submitting any file", (t) => {
  const f = fixture(t, 5, [initial[0]]);
  assert.throws(() => f.run(), /Gap in schema_migrations ledger/);
  assert.equal(f.files.length, 0);
  assert.equal(f.receipts().at(-1).outcome, "blocked");
});

test("surrounding whitespace in ledger timestamps is retained and treated as drift", (t) => {
  const before = fixture(t);
  before.plan.expectedLedger[0].applied_at += " ";
  before.save();
  assert.throws(() => before.run(), /checkpoint_ledger_changed/);
  assert.equal(before.files.length, 0);
  const after = fixture(t);
  after.setAfterFile((ledger) => { ledger[0].applied_at = ` ${ledger[0].applied_at}`; });
  assert.throws(() => after.run(), /checkpoint_unknown/);
  assert.equal(after.files.length, 1);
  assert.equal(after.receipts().at(-1).outcome, "unknown");
});
