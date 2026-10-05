import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { childEnvironment, validateCheckout } from "./run-checked-command.mjs";

const expected = process.env.EXPECTED_CANDIDATE_SHA;
if (!expected || !/^[a-f0-9]{40}$/.test(expected))
  throw new Error("A full candidate SHA is required");
if (process.version !== "v24.21.0") throw new Error("Unexpected Node version");
const root = process.cwd();
const env = childEnvironment(process.env, expected);
const git = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" });
const actual = git("rev-parse", "HEAD").trim();
validateCheckout(expected, actual, process.env.GITHUB_EVENT_NAME, process.env.GITHUB_SHA);
const files = git("ls-files", "-z")
  .split("\0")
  .filter(Boolean)
  .sort()
  .map((relativePath) => {
    const filename = path.resolve(root, relativePath);
    if (!filename.startsWith(root + path.sep)) throw new Error("Tracked path outside checkout");
    if (!lstatSync(filename).isFile())
      throw new Error("Expected regular tracked source file: " + relativePath);
    const bytes = readFileSync(filename);
    return {
      path: relativePath,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
const event = process.env.GITHUB_EVENT_PATH
  ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"))
  : {};
const identity = {
  schemaVersion: 1,
  actualCommit: actual,
  expectedCommit: expected,
  eventName: process.env.GITHUB_EVENT_NAME ?? null,
  eventSha: process.env.GITHUB_SHA ?? null,
  headSha: event.pull_request?.head?.sha ?? null,
  baseSha: event.pull_request?.base?.sha ?? null,
  workflowRef: process.env.GITHUB_WORKFLOW_REF ?? null,
  runId: process.env.GITHUB_RUN_ID ?? null,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  sourceSha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
  files,
  observedAt: new Date().toISOString(),
};
mkdirSync("ci-evidence", { recursive: true });
writeFileSync("ci-evidence/checkout-source.json", JSON.stringify(identity, null, 2) + "\n", {
  flag: "wx",
});
if (!process.env.GITHUB_ENV) throw new Error("Missing Actions environment output");
appendFileSync(
  process.env.GITHUB_ENV,
  "R65_EXPECTED_SHA=" +
    actual +
    "\nCERTIFIED_EXPECTED_MANIFEST=" +
    path.join(root, "ci-evidence", "approved24-expected.json") +
    "\n",
);
console.log(
  JSON.stringify({
    actualCommit: actual,
    sourceSha256: identity.sourceSha256,
    trackedFiles: files.length,
  }),
);
