import { deepStrictEqual, strictEqual, ok } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { CapturedTransport } from "../scripts/ci/operational-supervisor.mjs";
import { CaptureLedger, publicResult } from "../scripts/ci/operational-results.mjs";

const self = fileURLToPath(import.meta.url);
const source = fileURLToPath(new URL("../", import.meta.url));
const marker = "PRIVATE_R9_CONSOLE_MARKER";
const cap = 2 * 1024 * 1024;

async function capturedExperiment(directory) {
  const settings = JSON.parse(readFileSync(join(directory, "settings.json"), "utf8"));
  const observed = { stdout: 0, stderr: 0, closed: false, terminated: false };
  class ObservedLedger extends CaptureLedger {
    capture(id, stream, bytes) {
      observed[stream] += bytes.length;
      return super.capture(id, stream, bytes);
    }
  }
  const ledger = new ObservedLedger();
  let child;
  const transport = new CapturedTransport({
    ledger, deadlineMs: Date.now() + 60_000, cleanupReserveMs: 0,
    spawnImpl(executable, args, options) {
      child = spawn(executable, args, { ...options, detached: process.platform !== "win32" });
      child.once("close", () => { observed.closed = true; });
      return child;
    },
  });
  try {
    await transport.run("R9", process.execPath,
      [join(source, "node_modules/vitest/vitest.mjs"), "run", "--config", join(directory, "config.ts")], {
        cwd: source, env: { ...process.env, CI: "true", OPERATIONAL_PRIVATE_RESULTS_DIR: directory },
        durationMs: 30_000,
        terminate: async () => {
          observed.terminated = true;
          if (process.platform === "win32") {
            const result = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"],
              { windowsHide: true, stdio: "ignore", timeout: 10_000 });
            if (result.error) throw result.error;
          } else process.kill(-child.pid, "SIGKILL");
        },
      });
  } catch {
    // The ledger, not a later subprocess exit, owns the first failure.
  }
  const firstFailure = ledger.failure;
  if (firstFailure) ledger.reject("TEST_FAILED");
  strictEqual(ledger.failure, firstFailure);
  const workerPid = Number(readFileSync(join(directory, "worker.pid"), "utf8"));
  const pids = [...new Set([child.pid, workerPid])];
  observed.absent = pids.every(pid => {
    try { process.kill(pid, 0); return false; }
    catch (error) { if (error.code !== "ESRCH") throw error; return true; }
  });
  writeFileSync(join(directory, "capture.json"), JSON.stringify({
    ...observed, firstFailure, finalFailure: ledger.failure, pids, settings,
  }));
  const result = publicResult({
    candidateDigest: "1".repeat(64), manifestDigest: "2".repeat(64), inventoryDigest: "3".repeat(64),
    failure: firstFailure,
    stages: [{ id: "R9", durationMs: 0, passed: firstFailure ? 0 : 1,
      status: firstFailure ? "failed" : "passed" }],
  });
  process.stdout.write(result);
  if (firstFailure) process.exitCode = 1;
}

async function experiment(root, id, { interceptedBaseline = false, stream = "stdout", flood = false } = {}) {
  const directory = mkdtempSync(join(root, `${id}-`));
  const settings = { interceptedBaseline, stream, flood };
  writeFileSync(join(directory, "settings.json"), JSON.stringify(settings));
  const spec = join(directory, "flood.spec.ts");
  const proof = join(directory, "tasks.json");
  writeFileSync(spec, `
import { test } from ${JSON.stringify(pathToFileURL(join(source, "node_modules/vitest/dist/index.js")).href)};
import { writeFileSync } from "node:fs";
test("R9", () => {
  writeFileSync(${JSON.stringify(join(directory, "worker.pid"))}, String(process.pid));
  for (let index = 0; index < ${flood ? 128 : 1}; index++)
    console.${stream === "stdout" ? "log" : "error"}(${JSON.stringify(marker)} + "x".repeat(${flood ? 65536 : 32}));
});
`);
  writeFileSync(join(directory, "config.ts"), `
import base from ${JSON.stringify(join(source, "vitest.operational-ci.config.ts").replaceAll("\\", "/"))};
import { writeFileSync } from "node:fs";
export default { ...base, cacheDir: ${JSON.stringify(join(directory, "cache"))},
  test: { ...base.test, include: [${JSON.stringify(spec.replaceAll("\\", "/"))}],
    ${interceptedBaseline ? "disableConsoleIntercept: false," : ""}
    reporters: [{ onTestRunEnd(modules, errors, reason) {
      const logs = modules.flatMap(module => [module.task, ...module.children.allTests()].flatMap(
        item => (item.task ?? item).logs ?? []));
      writeFileSync(${JSON.stringify(proof)}, JSON.stringify({
        reason, errors: errors.length, logs: logs.length,
        retainedBytes: logs.reduce((sum, log) => sum + Buffer.byteLength(log.content), 0)
      }));
    } }]
  }
};
`);
  const child = spawn(process.execPath, [self, "--private-capture", directory], {
    cwd: source, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks = { stdout: [], stderr: [] };
  const sizes = { stdout: 0, stderr: 0 };
  let overflow = false;
  for (const stream of ["stdout", "stderr"]) child[stream].on("data", bytes => {
    sizes[stream] += bytes.length;
    if (sizes[stream] > 256 * 1024) { overflow = true; child.kill("SIGKILL"); }
    else chunks[stream].push(bytes);
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
  const outcome = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  strictEqual(overflow, false);
  strictEqual(sizes.stderr, 0);
  const bytes = Buffer.concat(chunks.stdout);
  strictEqual(bytes.includes(Buffer.from(marker)), false);
  const report = JSON.parse(bytes);
  deepStrictEqual(Object.keys(report).sort(), [
    "candidateDigest", "failure", "inventoryDigest", "manifestDigest", "schemaVersion", "stages", "status",
  ]);
  const capture = JSON.parse(readFileSync(join(directory, "capture.json"), "utf8"));
  strictEqual(capture.closed, true);
  strictEqual(capture.absent, true);
  return { outcome, report, capture, proof };
}

if (process.argv[2] === "--private-capture") {
  await capturedExperiment(process.argv[3]);
} else {
  test("R9", { timeout: 180_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "operational-r9-"));
    const baseline = await experiment(root, "baseline", { interceptedBaseline: true, flood: true });
    strictEqual(baseline.outcome.code, 0);
    strictEqual(baseline.report.status, "passed");
    ok(JSON.parse(readFileSync(baseline.proof, "utf8")).retainedBytes > cap);
    ok(baseline.capture.stdout < cap);

    const direct = await experiment(root, "direct");
    strictEqual(direct.outcome.code, 0);
    ok(direct.capture.stdout > 0);
    deepStrictEqual(JSON.parse(readFileSync(direct.proof, "utf8")),
      { reason: "passed", errors: 0, logs: 0, retainedBytes: 0 });

    for (const stream of ["stdout", "stderr"]) {
      const result = await experiment(root, stream, { stream, flood: true });
      strictEqual(result.outcome.code, 1);
      strictEqual(result.report.status, "failed");
      strictEqual(result.report.failure, "OVERFLOW");
      strictEqual(result.capture.firstFailure, "OVERFLOW");
      strictEqual(result.capture.finalFailure, "OVERFLOW");
      strictEqual(result.capture.terminated, true);
      ok(result.capture[stream] > cap);
    }
  });
}
