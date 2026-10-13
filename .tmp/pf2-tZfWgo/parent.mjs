// Async supervisor. Candidate release flags do not authorize execution now.
// Stdout is a PROVISIONAL frame: protocol.acceptPublication(frame, exitCode)
// is the only verdict. Exit two discards even a fully written late candidate.
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  WINDOW_MS, FIXTURE, PINS, HEAP_CAP_MIB, admission,
  approvedNodeVersion, fixtureShape,
} from "./contract.mjs";
import {
  REQUEST_BYTES, RESPONSE_BYTES, PUBLICATION_BYTES,
  boundedFrameReader, encodeRequest, classifyChildClose, appendStderrPrefix, encodePublication, encodeNotice,
  cleanNodeEnvironment,
} from "./protocol.mjs";
import { observeProcessClose } from "./cleanup.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const here = fileURLToPath(new URL("./", import.meta.url));
// Filled from actual source hashes after writing, before the syntax-only check.
// Parent is independently pinned by Lead; these pins do not authenticate parent.
const HARNESS_PINS = Object.freeze([
  [".tmp/pf2-tZfWgo/contract.mjs", 11117, "47e1a81110545b26ff01fcd48eddff24aae54fb66764c253c1408a04da5d9fea"],
  [".tmp/pf2-tZfWgo/child.mjs", 16478, "cccc533d62986602e380e025d54a1cd24e7385c36bf10222fcdcc5ad2893f700"],
  [".tmp/pf2-tZfWgo/protocol.mjs", 17286, "b8c4f047d21563bba7556308d190212f9cf819c947aad5ad8beb8a80c8886c97"],
  [".tmp/pf2-tZfWgo/cleanup.mjs", 2301, "30e105cd9eafcbdf10d4f669f38d4d6166e0c90c53d41bab9211f70301f6ad2f"],
]);
const NO_CHILD = Object.freeze({ childStarted: false, closeObserved: false, stopRequested: false });
let runnerToken = "0".repeat(64);
let outerAbort = null;
let stopActiveTrial = null;
process.stdin.on("readable", () => {
  const byte = process.stdin.read(1);
  if (byte === null) return;
  outerAbort = byte[0] === 33 ? "pf2_outer_abort" : "pf2_outer_abort_protocol";
  stopActiveTrial?.();
});
process.stderr.on("error", () => {
  outerAbort ??= "pf2_cleanup_notice_io";
  stopActiveTrial?.();
});
class Expired extends Error {}
function checkTime(deadline) {
  if (deadline !== null && performance.now() >= deadline) throw new Expired();
}
function snapshot(deadline = null) {
  let fixtureBytes = null;
  const entries = [...PINS, ...HARNESS_PINS].map(([path, expectedBytes, expectedSha256]) => {
    checkTime(deadline);
    const absolute = resolve(root, path);
    if (statSync(absolute).size !== expectedBytes) throw new Error("pf2_identity_size");
    const bytes = readFileSync(absolute);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== expectedBytes || sha256 !== expectedSha256)
      throw new Error("pf2_identity_sha");
    if (path === FIXTURE) fixtureBytes = bytes;
    return { path, bytes: bytes.length, sha256 };
  });
  // Actual parent before/after hashes detect drift, not initial authenticity.
  const parentBytes = readFileSync(fileURLToPath(import.meta.url));
  entries.push({ path: ".tmp/pf2-tZfWgo/parent.mjs", bytes: parentBytes.length,
    sha256: createHash("sha256").update(parentBytes).digest("hex") });
  checkTime(deadline);
  return { entries, fixtureBytes,
    digest: createHash("sha256").update(JSON.stringify(entries)).digest("hex") };
}

const failure = (reason, calls = null) => ({ status: "FAIL", reason, evaluatorCalls: calls });
const refusal = (reason, calls = null) => ({ status: "NOTRUN", reason, evaluatorCalls: calls });

function supervise(fixtureBytes, deadline) {
  return new Promise(resolveResult => {
    let child;
    let done = false;
    let observer;
    let pendingNotice = false;
    let stderrPrefix = "";
    let timer;
    const nonce = randomBytes(32).toString("hex");
    const finish = result => {
      if (done) return;
      clearTimeout(timer);
      if (observer && !observer.closeObserved) {
        observer.stop(result);
        return; // no publication, resolve or unref until actual close
      }
      done = true;
      stopActiveTrial = null;
      if (result.status === "FAIL") observer?.stop(result);
      resolveResult({ result: observer?.pending ?? result, cleanup: observer?.state() ?? NO_CHILD });
    };
    const deadlineTick = () => {
      const remaining = deadline - performance.now();
      if (remaining > 0) timer = setTimeout(deadlineTick, Math.ceil(remaining));
      else finish(refusal("pf2_parent_deadline"));
    };
    timer = setTimeout(deadlineTick, Math.max(1, Math.ceil(deadline - performance.now())));
    try {
      checkTime(deadline);
      if (outerAbort) return finish(failure(outerAbort, 0));
      child = spawn(process.execPath, [
        "--experimental-transform-types", "--disable-warning=ExperimentalWarning",
        `--max-old-space-size=${HEAP_CAP_MIB}`,
        resolve(here, "child.mjs"), "--pf2-child", "--nonce", nonce,
      ], {
        cwd: root, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        env: cleanNodeEnvironment(process.env),
      });
      observer = observeProcessClose(child, notice => {
        pendingNotice = true;
        process.stderr.write(encodeNotice(notice));
      });
      stopActiveTrial = () => finish(failure(outerAbort ?? "pf2_outer_abort"));
      child.once("spawn", () => {
        if (!pendingNotice)
          process.stderr.write(encodeNotice({ kind: "PF2_CHILD_STARTED", pid: child.pid }));
      });
      const response = boundedFrameReader(child.stdout, RESPONSE_BYTES,
        () => finish(failure("pf2_child_stdout_overflow")));
      // Drain stderr, retaining at most 8192 prefix bytes for fatal-OOM recognition.
      // Classify only after close; unrelated crashes and stderr remain FAIL.
      child.stderr.on("data", chunk => {
        const next = appendStderrPrefix(stderrPrefix, chunk);
        stderrPrefix = next.prefix;
        if (next.failure) finish(next.failure);
      });
      child.once("error", () => finish(failure("pf2_child_spawn")));
      child.stdin.once("error", () => finish(failure("pf2_child_input")));
      child.stdout.once("error", () => finish(failure("pf2_child_output")));
      child.stderr.once("error", () => finish(failure("pf2_child_stderr_stream")));
      child.once("close", (code, signal) => {
        if (done) return;
        try {
          finish(classifyChildClose({ code, signal, stderrPrefix,
            expired: performance.now() >= deadline, frame: response(), nonce, pending: observer.pending }));
        } catch {
          finish(failure("pf2_child_protocol"));
        }
      });
      // Separate process origins: this is an ADVISORY remaining duration,
      // never a transferable parent performance.now() timestamp.
      const remainingMs = Math.floor(deadline - performance.now());
      if (remainingMs <= 0) return finish(refusal("pf2_parent_deadline"));
      const frame = encodeRequest({
        version: 1, nonce, remainingMs,
        fixtureBase64: fixtureBytes.toString("base64"),
      });
      if (frame.length > REQUEST_BYTES) return finish(failure("pf2_request_size"));
      child.stdin.end(frame);
    } catch (error) {
      finish(error instanceof Expired ? refusal("pf2_parent_deadline") : failure("pf2_supervisor_exception"));
    }
  });
}

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== "--runner-token" ||
      !/^[0-9a-f]{64}$/.test(process.argv[3]) || process.execArgv.length !== 0 ||
      Object.keys(process.env).some(name => /^(NODE_|UV_)/i.test(name)))
    throw new Error("pf2_parent_startup_options");
  runnerToken = process.argv[3];
  if (!approvedNodeVersion(process.version))
    return { result: failure("pf2_runtime_identity", 0), preservation: null, deadline: null, cleanup: NO_CHILD };
  // Only prelaunch hashing is outside the evaluation/publication window.
  // The post-call preservation recheck is INSIDE it.
  const before = snapshot();
  const record = JSON.parse(before.fixtureBytes.toString("utf8"));
  if (!fixtureShape(record)) throw new Error("pf2_fixture_domain");
  const gate = admission();
  if (gate.status !== "ADMITTED") {
    const after = snapshot();
    if (before.digest !== after.digest) throw new Error("pf2_preservation_drift");
    return { result: { ...gate, evaluatorCalls: 0 }, deadline: null, cleanup: NO_CHILD,
      preservation: { before: before.digest, after: after.digest, selectedFiles: before.entries.length } };
  }
  // No module loads, spawn or handshake receive an extra five-second window.
  const deadline = performance.now() + WINDOW_MS;
  let { result, cleanup } = await supervise(before.fixtureBytes, deadline);
  let preservation = null;
  try {
    // Always complete integrity checking, including after a refused deadline.
    // Cleanup may finish late, but no successful publication may commit late.
    const after = snapshot();
    if (before.digest !== after.digest) result = failure("pf2_preservation_drift");
    else preservation = { before: before.digest, after: after.digest, selectedFiles: before.entries.length };
  } catch {
    result = failure("pf2_preservation_drift");
  }
  if (performance.now() >= deadline && result.status !== "FAIL")
    result = refusal("pf2_parent_deadline");
  return { result, preservation, deadline, cleanup };
}

function publish({ result, preservation, deadline, cleanup }) {
  if (outerAbort) result = failure(outerAbort);
  // Child cleanup is already observed (or no child was launched). An outer
  // abort during this final write can safely refuse commit without orphaning it.
  stopActiveTrial = () => { process.stdout.destroy(); process.exit(1); };
  if (deadline !== null && performance.now() >= deadline && result.status !== "FAIL")
    result = refusal("pf2_parent_deadline");
  let frame;
  try {
    frame = encodePublication({ version: 1, runnerToken, kind: "PF2_PROVISIONAL",
      acceptance: "complete-frame-and-parent-exit-zero", result, preservation, cleanup });
  } catch {
    result = failure("pf2_publication_schema");
    frame = encodePublication({ version: 1, runnerToken, kind: "PF2_PROVISIONAL",
      acceptance: "complete-frame-and-parent-exit-zero", result, preservation: null, cleanup });
  }
  // Serialization is inside the window too. Never commit a frame merely because
  // its pre-write deadline check passed: callback completion is checked below.
  const noCommitCode = result.status === "FAIL" ? 1 : 2;
  let timer;
  const expire = () => {
    if (deadline !== null && performance.now() < deadline) {
      timer = setTimeout(expire, Math.ceil(deadline - performance.now()));
      return;
    }
    process.stdout.destroy();
    process.exit(noCommitCode); // partial/provisional bytes are NOT a certificate
  };
  if (deadline !== null) timer = setTimeout(expire, Math.max(1, Math.ceil(deadline - performance.now())));
  process.stdout.once("error", () => process.exit(1));
  process.stdout.write(frame, error => {
    clearTimeout(timer);
    if (error) process.exit(1);
    if (deadline !== null && performance.now() >= deadline) process.exit(noCommitCode);
    process.exit(result.status === "FAIL" ? 1 : result.status === "NOTRUN" ? 2 : 0);
  });
}

let publication;
try { publication = await main(); }
catch {
  publication = { result: failure("pf2_prelaunch_identity_or_unexpected_exception", 0),
    preservation: null, deadline: null, cleanup: NO_CHILD };
}
publish(publication);
