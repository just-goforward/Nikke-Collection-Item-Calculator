import { build, stop } from "esbuild";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const allowed = ["outcome-facts.test.mjs", "stats-public-read-models.test.mjs"];
const selected = process.argv.length > 2 ? process.argv.slice(2) : allowed;
if (selected.some(file => !allowed.includes(file))) throw new Error("unknown_outcome_test");
const workspace = mkdtempSync(path.join(tmpdir(), "outcome-"));
const output = path.join(workspace, "cloudflare", "backend-tests");
const digest = file => createHash("sha256").update(readFileSync(file)).digest("hex");
try {
  // Node strip-only cannot execute existing parameter properties in UsageGuard.
  // Compile with the already installed project compiler, never experimental flags
  // or edits to that passing production module.
  await build({
    entryPoints: selected.map(file => path.join(directory, file)), outdir: output,
    bundle: true, platform: "node", format: "esm", target: "node26",
    outExtension: { ".js": ".mjs" },
  });
  for (const name of ["schema.sql", "decision-analytics/0002_stats_public_read_models.proposed.sql",
    "decision-analytics/0003_outcome_facts.proposed.sql"]) {
    const destination = path.join(workspace, "cloudflare", name);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(directory, "..", name), destination);
  }
  const bundles = selected.map(file => path.join(output, file));
  const hashes = bundles.map(file => ({ file: path.basename(file), sha256: digest(file) }));
  console.log(JSON.stringify({ transformedTestArtifacts: hashes }));
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, "--test", ...bundles], { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (status, signal) => resolve(signal ? 1 : status ?? 1));
  });
  if (bundles.some((file, index) => digest(file) !== hashes[index].sha256))
    throw new Error("outcome_test_artifact_changed");
  console.log(JSON.stringify({ transformedArtifactsStable: true }));
  process.exitCode = code;
} finally {
  stop();
  rmSync(workspace, { recursive: true });
}
