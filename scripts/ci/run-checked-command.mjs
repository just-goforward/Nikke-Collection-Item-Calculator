import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const inheritedKeys = [
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "SystemDrive",
  "RUSTUP_HOME",
  "CARGO_HOME",
  "LD_LIBRARY_PATH",
  "DYLD_LIBRARY_PATH",
  "DISPLAY",
  "XAUTHORITY",
  "LANG",
  "LC_ALL",
  "TZ",
  "PLAYWRIGHT_BROWSERS_PATH",
  "CERTIFIED_EXPECTED_MANIFEST",
  "CERTIFIED_PLATFORM_RUN_LABEL",
  "CERTIFIED_VISIBILITY_ADAPTER",
  "FULL_ALIGNMENT_MATRIX",
];

export function childEnvironment(parent, commit) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Expected full candidate commit");
  const env = Object.fromEntries(
    inheritedKeys.filter((key) => parent[key] !== undefined).map((key) => [key, parent[key]]),
  );
  return {
    ...env,
    CI: "true",
    GITHUB_SHA: commit,
    DO_NOT_TRACK: "1",
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_SEND_ERROR_REPORTS: "false",
    CLOUDFLARE_CF_FETCH_ENABLED: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
}

export function validateCheckout(expected, actual, eventName, eventSha) {
  if (!/^[a-f0-9]{40}$/.test(expected ?? "")) throw new Error("A full candidate SHA is required");
  if (actual !== expected) throw new Error("Checkout does not match expected candidate");
  if (eventName === "workflow_dispatch" && eventSha !== expected)
    throw new Error("Dispatched workflow ref does not match the candidate commit");
}

export function commandFor(kind, args, { node, npmCli, root, platform }) {
  if (kind === "npm") {
    if (!npmCli || !path.isAbsolute(npmCli)) throw new Error("Missing pinned R65_NPM_CLI");
    return [node, [npmCli, ...args]];
  }
  if (kind === "node") return [node, args];
  const playwright = path.join(root, "node_modules/playwright/cli.js");
  if (kind === "playwright") return [node, [playwright, ...args]];
  if (kind === "xvfb-playwright" && platform === "linux")
    return ["xvfb-run", ["-a", node, playwright, ...args]];
  throw new Error("Unsupported CI command kind");
}

export async function runChecked(stage, kind, args) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(stage)) throw new Error("Invalid stage");
  const root = process.cwd();
  const expected = process.env.R65_EXPECTED_SHA;
  if (!expected || !/^[a-f0-9]{40}$/.test(expected))
    throw new Error("Missing exact approved candidate SHA");
  const env = childEnvironment(process.env, expected);
  const actual = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    env,
    encoding: "utf8",
  }).trim();
  if (actual !== expected) throw new Error("Checkout does not match expected candidate");
  const output = path.join(root, "ci-evidence", stage);
  if (existsSync(output)) throw new Error("Refusing to overwrite existing stage evidence");
  mkdirSync(output, { recursive: true });
  const command = commandFor(kind, args, {
    node: process.execPath,
    npmCli: process.env.R65_NPM_CLI,
    root,
    platform: process.platform,
  });
  if (kind === "npm" && !existsSync(command[1][0])) throw new Error("Pinned npm CLI missing");
  const identity = {
    schemaVersion: 1,
    stage,
    kind,
    command,
    commit: actual,
    event: process.env.GITHUB_EVENT_NAME ?? null,
    eventSha: process.env.GITHUB_SHA ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    nodeSha256: createHash("sha256").update(readFileSync(process.execPath)).digest("hex"),
    lockSha256: createHash("sha256")
      .update(readFileSync(path.join(root, "package-lock.json")))
      .digest("hex"),
    childEnvironmentKeys: Object.keys(env).sort(),
    startedAt: new Date().toISOString(),
    note: "Command provenance and credential allowlist; not native network or filesystem containment",
  };
  writeFileSync(path.join(output, "before.json"), JSON.stringify(identity, null, 2) + "\n", {
    flag: "wx",
  });
  const stdout = createWriteStream(path.join(output, "stdout.log"), { flags: "wx" });
  const stderr = createWriteStream(path.join(output, "stderr.log"), { flags: "wx" });
  const streamsDone = Promise.all(
    [stdout, stderr].map(
      (stream) =>
        new Promise((resolve, reject) => {
          stream.once("finish", resolve);
          stream.once("error", reject);
        }),
    ),
  );
  let spawnError = null;
  const child = spawn(command[0], command[1], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(stdout);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(stderr);
  child.stderr.pipe(process.stderr);
  child.once("error", (error) => {
    spawnError = { name: error.name, message: error.message };
  });
  const termination = await new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  await streamsDone;
  const result = { ...identity, finishedAt: new Date().toISOString(), ...termination, spawnError };
  writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2) + "\n", {
    flag: "wx",
  });
  return termination.code === 0 && !termination.signal && !spawnError ? 0 : termination.code || 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [stage, kind, ...args] = process.argv.slice(2);
  runChecked(stage, kind, args)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
