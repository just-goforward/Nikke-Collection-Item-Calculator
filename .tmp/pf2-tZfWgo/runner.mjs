// Operator entry point. Lead authenticates THIS runner externally; it does not
// authenticate itself. Exact command:
// node .tmp/pf2-tZfWgo/runner.mjs --parent-sha256 LEAD_PIN
// Only this externally authenticated runner command is an operator release.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, statSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const here = fileURLToPath(new URL("./", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const PARENT_BYTES = 11489;
const CODE_PINS = Object.freeze([
  ["contract.mjs", 11117, "47e1a81110545b26ff01fcd48eddff24aae54fb66764c253c1408a04da5d9fea"],
  ["child.mjs", 16478, "cccc533d62986602e380e025d54a1cd24e7385c36bf10222fcdcc5ad2893f700"],
  ["protocol.mjs", 17286, "b8c4f047d21563bba7556308d190212f9cf819c947aad5ad8beb8a80c8886c97"],
  ["cleanup.mjs", 2301, "30e105cd9eafcbdf10d4f669f38d4d6166e0c90c53d41bab9211f70301f6ad2f"],
]);
const failure = reason => ({ status: "FAIL", reason, evaluatorCalls: null });
const emptyCleanup = () => ({
  parentPid: null, parentCloseObserved: false, childPid: null,
  childCleanupConfirmed: true, operatorActionRequired: false,
});

export function parseRunnerArguments(args, execArgv, environment) {
  if (execArgv.length !== 0 ||
      Object.keys(environment).some(name => /^(NODE_|UV_)/i.test(name)))
    throw new Error("pf2_runner_startup_options");
  if (args.length !== 2 || args[0] !== "--parent-sha256" ||
      !/^[0-9a-f]{64}$/.test(args[1]))
    throw new Error("pf2_runner_exact_arguments");
  return { parentSha256: args[1] };
}
export function authenticate(parentSha256) {
  return [...CODE_PINS, ["parent.mjs", PARENT_BYTES, parentSha256]].map(([name, size, hash]) => {
    const path = resolve(here, name);
    if (statSync(path).size !== size) throw new Error("pf2_runner_identity");
    const bytes = readFileSync(path);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== size || actual !== hash) throw new Error("pf2_runner_identity");
    return { name, bytes: bytes.length, sha256: actual };
  });
}

// Injectable CHILD-PROCESS object only for isolated simulated guard checks.
// This function does not spawn anything or import any numerical module.
export function consumeParent(parent, protocol, onNotice, onPending, runnerToken) {
  let requestAbort;
  const completion = new Promise(resolveOutcome => {
    let knownFailure = null;
    let readerRefused = false;
    let childPid = null;
    let abortSent = false;
    const retainFailure = result => {
      if (knownFailure === null) knownFailure = result;
    };
    const discardExitedPipes = () => {
      if (readerRefused && (parent.exitCode !== null || parent.signalCode !== null)) {
        parent.stdin.destroy();
        parent.stdout.destroy();
        parent.stderr.destroy();
      }
    };
    const abort = (reason, refusePipes = false) => {
      retainFailure(failure(reason));
      readerRefused ||= refusePipes;
      // Refused data may arrive AFTER exit. Close those pipes even if a
      // previous abort was already sent; exit is not itself complete close.
      discardExitedPipes();
      if (abortSent) return;
      abortSent = true;
      try {
        onPending({ kind: "PF2_OUTER_CLEANUP_PENDING", parentPid: parent.pid ?? null,
          childPid, reason: knownFailure.reason });
      } catch {
        retainFailure(failure("pf2_outer_notice_io"));
      }
      // Do not kill/unref the parent and risk orphaning its numerical child.
      // Ask its pinned cleanup path to stop, then WAIT for actual parent close.
      if (parent.exitCode === null && parent.signalCode === null) {
        parent.stdin.end("!", error => {
          if (error) retainFailure(failure("pf2_parent_abort_channel"));
        });
      }
    };
    requestAbort = abort;
    const frame = protocol.boundedFrameReader(parent.stdout, protocol.PUBLICATION_BYTES,
      () => abort("pf2_parent_stdout_overflow", true));
    const notices = protocol.boundedNoticeReader(parent.stderr, notice => {
      childPid = notice.pid;
      if (notice.kind === "PF2_CLEANUP_PENDING" && notice.status === "FAIL")
        retainFailure(failure(notice.reason));
      onNotice(notice);
    }, () => abort("pf2_parent_notice_protocol", true));
    parent.once("error", () => abort("pf2_parent_spawn"));
    parent.stdin.once("error", () => abort("pf2_parent_input"));
    parent.stdout.once("error", () => abort("pf2_parent_output", true));
    parent.stderr.once("error", () => abort("pf2_parent_notice_stream", true));
    parent.once("exit", () => {
      if (readerRefused) {
        // The process really exited; discard refused pipe contents so close can
        // be observed. Never do this as a substitute for process termination.
        discardExitedPipes();
      }
    });
    parent.once("close", (code, signal) => {
      let bytes = null;
      let publication = null;
      try {
        notices();
        bytes = frame();
        publication = protocol.inspectPublication(bytes); // diagnostics, not acceptance
        if (publication.runnerToken !== runnerToken) retainFailure(failure("pf2_runner_token"));
        if (publication.result.status === "FAIL") retainFailure(publication.result);
      } catch {
        if (code !== 2 || knownFailure !== null)
          retainFailure(failure("pf2_parent_incomplete_or_invalid_frame"));
      }
      // Only here, after COMPLETE parent close, may the commit decoder run.
      let result = protocol.acceptPublication(bytes ?? Buffer.alloc(0), signal === null ? code : null, runnerToken);
      if (knownFailure !== null) result = knownFailure;
      const childCleanupConfirmed = publication !== null &&
        (publication.cleanup.childStarted ? publication.cleanup.closeObserved : childPid === null);
      if (["PASS", "UNKNOWN"].includes(result.status) && !childCleanupConfirmed)
        result = failure("pf2_child_cleanup_unconfirmed");
      resolveOutcome({ version: 1, result, cleanup: {
        parentPid: parent.pid ?? null, parentCloseObserved: true, childPid,
        childCleanupConfirmed, operatorActionRequired: !childCleanupConfirmed,
      } });
    });
  });
  return { completion, abort: reason => requestAbort(reason) };
}

async function main() {
  let protocol;
  let outcome;
  let requestAbort = null;
  let progressFailed = false;
  let parent = null;
  let parentClosed = null;
  let session = null;
  process.stderr.on("error", () => {
    progressFailed = true;
    requestAbort?.("pf2_outer_notice_io");
  });
  try {
    const options = parseRunnerArguments(process.argv.slice(2), process.execArgv, process.env);
    const before = authenticate(options.parentSha256);
    // Only authenticated, non-numerical local modules are imported by the runner.
    const contract = await import("./contract.mjs");
    protocol = await import("./protocol.mjs");
    if (!contract.approvedNodeVersion(process.version)) throw new Error("pf2_runner_runtime");
    const gate = contract.admission();
    if (gate.status !== "ADMITTED") {
      outcome = { version: 1, result: { ...gate, evaluatorCalls: 0 }, cleanup: emptyCleanup() };
    } else {
      const runnerToken = randomBytes(32).toString("hex");
      parent = spawn(process.execPath, [resolve(here, "parent.mjs"), "--runner-token", runnerToken], {
        cwd: root, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        env: protocol.cleanNodeEnvironment(process.env),
      });
      parentClosed = new Promise(resolveClose => parent.once("close", resolveClose));
      session = consumeParent(parent, protocol,
        notice => process.stderr.write(protocol.encodeNotice(notice)),
        notice => process.stderr.write(protocol.encodeOuterPending(notice)), runnerToken);
      requestAbort = session.abort;
      outcome = await session.completion;
      requestAbort = null;
    }
    const after = authenticate(options.parentSha256);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("pf2_runner_identity");
    if (progressFailed) outcome.result = failure("pf2_outer_notice_io");
  } catch {
    if (parent !== null && outcome === undefined) {
      // A reader/setup exception must not pretend that nothing was launched.
      // Ask the parent to clean up and keep its handle referenced until close.
      process.stderr.write(protocol.encodeOuterPending({
        kind: "PF2_OUTER_CLEANUP_PENDING", parentPid: parent.pid ?? null,
        childPid: null, reason: "pf2_runner_exception",
      }));
      if (session) session.abort("pf2_runner_exception");
      else if (parent.exitCode === null && parent.signalCode === null) parent.stdin.end("!");
      await parentClosed;
      outcome = { version: 1, result: failure("pf2_runner_exception"), cleanup: {
        parentPid: parent.pid ?? null, parentCloseObserved: true, childPid: null,
        childCleanupConfirmed: false, operatorActionRequired: true,
      } };
    }
    outcome = { version: 1, result: failure("pf2_runner_identity_arguments_or_exception"),
      cleanup: outcome?.cleanup ?? emptyCleanup() };
  }
  // Identity/argument failures do not import an unauthenticated protocol module.
  const bytes = protocol ? protocol.encodeOuterResult(outcome) :
    Buffer.from(`${JSON.stringify(outcome)}\n`, "ascii");
  process.stdout.once("error", () => process.exit(1));
  process.stdout.write(bytes, error => {
    if (error) process.exit(1);
    process.exit(outcome.result.status === "FAIL" ? 1 : outcome.result.status === "NOTRUN" ? 2 : 0);
  });
}

// Canonical filesystem identity also recognizes junction/substituted paths.
// Importing this module for simulated checks must not execute the runner.
if (process.argv[1] &&
    realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = 1;
  await main();
}
