// Isolated SIMULATED guard checks. No parent/child executable, evaluator,
// estimator, public game module or numerical oracle is imported or invoked.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import * as protocol from "./protocol.mjs";
import { CONTROLS, PINS, RELEASE_GATES, HEAP_CAP_MIB, admission } from "./contract.mjs";
import { observeProcessClose } from "./cleanup.mjs";
import { parseRunnerArguments, consumeParent, authenticate } from "./runner.mjs";

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = 4100;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.killResult = true;
    this.killCalls = [];
    this.input = [];
    this.stdin = new Writable({ write: (chunk, _encoding, callback) => {
      this.input.push(chunk.toString()); callback();
    } });
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }
  kill(signal) { this.killCalls.push(signal); this.killed = true; return this.killResult; }
  exit(code = 0, signal = null) {
    this.exitCode = code; this.signalCode = signal;
    this.emit("exit", code, signal);
  }
  close(code = this.exitCode, signal = this.signalCode) { this.emit("close", code, signal); }
}
const refused = { status: "NOTRUN", reason: "pf2_parent_deadline", evaluatorCalls: null };
const tests = [];
await check("child close classification table", () => {
  const nonce = "a".repeat(64);
  for (const [stderrPrefix, code, frame, expired, status] of [
    ["FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n", 134, Buffer.alloc(0), false, "NOTRUN"],
    ["unexpected", 134, Buffer.alloc(0), false, "FAIL"],
    ["unexpected", 0, Buffer.alloc(0), false, "FAIL"],
    ["unexpected", 0, Buffer.alloc(0), true, "FAIL"],
    ["", 134, Buffer.alloc(0), false, "FAIL"],
    ["", 134, Buffer.from('{"version":'), false, "FAIL"],
    ["", 0, Buffer.alloc(0), true, "NOTRUN"],
  ]) {
    const child = new FakeProcess();
    child.once("close", (exitCode, signal) => {
      assert.equal(protocol.classifyChildClose({
        code: exitCode, signal, frame, stderrPrefix, expired, nonce,
      }).status, status);
      if (stderrPrefix.startsWith("FATAL ERROR:"))
        assert.equal(protocol.classifyChildClose({
          code: exitCode, signal, frame, stderrPrefix, expired, nonce,
        }).reason, "pf2_heap_cap");
    });
    child.exit(code); child.close(code);
  }
});
const failed = { status: "FAIL", reason: "pf2_fixture_failure", evaluatorCalls: null };
async function check(name, body) {
  await body();
  tests.push({ name, status: "PASS" });
}
function syntheticUnknown(cleanup = { childStarted: true, closeObserved: true, stopRequested: false }) {
  const rows = [2, 2, 300, 602, 6, 4], peaks = [2, 2, 300, 602, 4, 4];
  const nodes = [4, 3, 7, 3472, 8, 7];
  return protocol.encodePublication({
    version: 1, runnerToken: "b".repeat(64), kind: "PF2_PROVISIONAL", acceptance: "complete-frame-and-parent-exit-zero",
    result: { status: "UNKNOWN", scope: "B09-first-normal-only",
      controls: CONTROLS.map((item, i) => ({
        id: item.id, status: "PASS", helperStatus: item.expectedStatus,
        rows: rows[i], peakRows: peaks[i], oracleNodes: nodes[i], staticallyReservedWork: item.work,
      })), evaluatorCalls: 13, staticallyReservedWork: 73135,
      memoryObservation: { maxRSSKiB: null, certifying: false },
      target: { status: "UNKNOWN", finiteEndpoint: null, rows: 45000, peakRows: 900 } },
    cleanup, preservation: { before: "a".repeat(64), after: "a".repeat(64), selectedFiles: PINS.length + 5 },
  });
}
function session(parent, api = protocol) {
  const notices = [], pending = [];
  const consumer = consumeParent(parent, api, value => notices.push(value), value => pending.push(value), "b".repeat(64));
  return { ...consumer, notices, pending };
}
async function closeFake(parent, code) {
  parent.stdout.end();
  parent.stderr.end();
  await tick();
  parent.exit(code);
  await tick();
  parent.close(code);
}

await check("candidate released admission; either closed gate refuses", () => {
  assert.equal(HEAP_CAP_MIB, 256);
  assert.deepEqual(admission(), { status: "ADMITTED" });
  assert.deepEqual(admission({ ...RELEASE_GATES, executionReleasedByLead: false }),
    { status: "NOTRUN", reason: "pf2_lead_release_required" });
  assert.equal(protocol.acceptPublication(syntheticUnknown(), 0).status, "UNKNOWN");
  assert.deepEqual(admission({ ...RELEASE_GATES, supervisorAndAtomicPublicationReviewed: false }),
    { status: "NOTRUN", reason: "pf2_supervisor_publication_not_reviewed" });
});
await check("exact outer arguments and clean Node startup", () => {
  const args = ["--parent-sha256", "a".repeat(64)];
  assert.deepEqual(parseRunnerArguments(args, [], {}), { parentSha256: "a".repeat(64) });
  for (const invalid of [[], args.slice(0, 1), ["--memory", "0", ...args], [...args, "--extra"]])
    assert.throws(() => parseRunnerArguments(invalid, [], {}));
  assert.throws(() => parseRunnerArguments(args, ["--trace-warnings"], {}));
  assert.throws(() => parseRunnerArguments(args, [], { NODE_OPTIONS: "--trace-warnings" }));
  assert.throws(() => parseRunnerArguments(args, [], { NODE_PATH: "unexpected" }));
  for (const name of ["NODE_V8_COVERAGE", "NODE_COMPILE_CACHE", "NODE_REDIRECT_WARNINGS",
    "NODE_NO_WARNINGS", "NODE_DEBUG", "NODE_PRESERVE_SYMLINKS", "UV_THREADPOOL_SIZE",
    "node_options"])
    assert.throws(() => parseRunnerArguments(args, [], { [name]: "" }));
  assert.deepEqual(protocol.cleanNodeEnvironment({
    PATH: "retained", NODE_V8_COVERAGE: "discarded", UV_THREADPOOL_SIZE: "8", node_path: "",
  }), { PATH: "retained" });
});
await check("wrong external parent pin rejects without launching a process", () => {
  assert.throws(() => authenticate("0".repeat(64)), /pf2_runner_identity/);
});
await check("kill request and exit are not close; close is explicitly observed", async () => {
  const child = new FakeProcess(), notices = [];
  const observer = observeProcessClose(child, item => notices.push(item));
  let settled = false;
  observer.closed.then(() => { settled = true; });
  child.killed = true; // this property alone must not skip the real stop request
  observer.stop(refused);
  await tick();
  assert.deepEqual(child.killCalls, ["SIGKILL"]);
  assert.equal(settled, false);
  child.exit(0);
  await tick();
  assert.equal(settled, false);
  child.close(0);
  await observer.closed;
  assert.equal(observer.closeObserved, true);
  assert.equal(observer.pending.status, "NOTRUN");
  assert.equal(notices.length, 1);
});
await check("already exited process skips kill but still awaits close", async () => {
  const child = new FakeProcess();
  child.exitCode = 0;
  const observer = observeProcessClose(child, () => {});
  observer.stop(failed);
  assert.deepEqual(child.killCalls, []);
  assert.equal(observer.closeObserved, false);
  child.close(0);
  await observer.closed;
  assert.equal(observer.pending.reason, failed.reason);
});
await check("failed kill and notice failure never become cleanup success", async () => {
  for (const noticeThrows of [false, true]) {
    const child = new FakeProcess();
    child.killResult = false;
    const observer = observeProcessClose(child, () => { if (noticeThrows) throw new Error("fixture"); });
    observer.stop(refused);
    observer.stop({ status: "NOTRUN", reason: "pf2_later_cleanup", evaluatorCalls: null });
    assert.equal(observer.pending.status, "FAIL");
    assert.equal(child.killCalls.length, 1);
    child.exit(0); child.close(0);
    await observer.closed;
    assert.equal(observer.pending.status, "FAIL");
  }
});
await check("first known FAIL survives later refusal and successful close", async () => {
  const child = new FakeProcess();
  const observer = observeProcessClose(child, () => {});
  observer.stop(failed); observer.stop(refused);
  child.exit(0); child.close(0);
  await observer.closed;
  assert.equal(observer.pending.reason, failed.reason);
});
await check("outer commit decoder is called only after complete parent close", async () => {
  const parent = new FakeProcess();
  let decoderCalls = 0, settled = false;
  const api = { ...protocol, acceptPublication: (...args) => {
    decoderCalls++; return protocol.acceptPublication(...args);
  } };
  const read = session(parent, api);
  read.completion.then(() => { settled = true; });
  parent.stdout.end(syntheticUnknown()); parent.stderr.end();
  await tick();
  parent.exit(0);
  await tick();
  assert.equal(decoderCalls, 0); assert.equal(settled, false);
  parent.close(0);
  const value = await read.completion;
  assert.equal(decoderCalls, 1);
  assert.equal(value.result.status, "UNKNOWN");
  assert.equal(value.cleanup.childCleanupConfirmed, true);
});
await check("late and partial parent frames never yield a certificate", async () => {
  for (const [partial, code, expected] of [[false, 2, "NOTRUN"], [true, 2, "NOTRUN"], [true, 0, "FAIL"]]) {
    const parent = new FakeProcess(), read = session(parent);
    const frame = syntheticUnknown();
    parent.stdout.write(partial ? frame.subarray(0, -2) : frame);
    await closeFake(parent, code);
    const value = await read.completion;
    assert.equal(value.result.status, expected);
    assert.equal(Object.hasOwn(value.result, "target"), false);
  }
});
await check("missing child close or requested stop invalidates success commit", () => {
  for (const cleanup of [
    { childStarted: true, closeObserved: false, stopRequested: false },
    { childStarted: true, closeObserved: true, stopRequested: true },
  ]) assert.equal(protocol.acceptPublication(syntheticUnknown(cleanup), 0).status, "FAIL");
});
await check("known cleanup FAIL is not hidden by parent exit two", async () => {
  const parent = new FakeProcess(), read = session(parent);
  parent.stderr.write(protocol.encodeNotice({ kind: "PF2_CLEANUP_PENDING",
    pid: 5100, status: "FAIL", reason: "pf2_known_failure" }));
  await tick();
  await closeFake(parent, 2);
  const value = await read.completion;
  assert.equal(value.result.status, "FAIL");
  assert.equal(value.result.reason, "pf2_known_failure");
  assert.equal(value.cleanup.operatorActionRequired, true);
});
await check("outer overflow requests cooperative parent cleanup and waits; no parent kill", async () => {
  const parent = new FakeProcess(), read = session(parent);
  let settled = false;
  read.completion.then(() => { settled = true; });
  parent.stdout.end(Buffer.alloc(protocol.PUBLICATION_BYTES + 1, 32));
  await tick();
  assert.equal(parent.input.join(""), "!");
  assert.deepEqual(parent.killCalls, []);
  assert.equal(settled, false);
  assert.equal(read.pending.length, 1);
  await closeFake(parent, 1);
  assert.equal((await read.completion).result.status, "FAIL");
});
await check("cleanup notices are immediate, bounded and limited to two", async () => {
  const parent = new FakeProcess(), read = session(parent);
  parent.stderr.write(protocol.encodeNotice({ kind: "PF2_CHILD_STARTED", pid: 5100 }));
  parent.stderr.write(protocol.encodeNotice({ kind: "PF2_CLEANUP_PENDING",
    pid: 5100, status: "NOTRUN", reason: "pf2_parent_deadline" }));
  await tick();
  assert.equal(read.notices.length, 2);
  parent.stderr.write(protocol.encodeNotice({ kind: "PF2_CHILD_STARTED", pid: 5100 }));
  await tick();
  assert.equal(parent.input.join(""), "!");
  await closeFake(parent, 2);
  assert.equal((await read.completion).result.status, "FAIL");
});
await check("refused data arriving after exit destroys pipes but still awaits close", async () => {
  for (const badStream of ["stdout", "stderr"]) {
    const parent = new FakeProcess(), read = session(parent);
    let settled = false;
    read.completion.then(() => { settled = true; });
    parent.exit(1);
    parent[badStream].write(badStream === "stdout" ?
      Buffer.alloc(protocol.PUBLICATION_BYTES + 1, 32) : Buffer.from("invalid\n"));
    await tick();
    assert.equal(parent.stdin.destroyed, true);
    assert.equal(parent.stdout.destroyed, true);
    assert.equal(parent.stderr.destroyed, true);
    assert.equal(settled, false);
    assert.deepEqual(parent.killCalls, []);
    parent.close(1);
    assert.equal((await read.completion).result.status, "FAIL");
  }
});
await check("outer result requires canonical complete frame and matching exit", () => {
  const value = { version: 1, result: failed, cleanup: {
    parentPid: 4100, parentCloseObserved: true, childPid: 5100,
    childCleanupConfirmed: true, operatorActionRequired: false,
  } };
  const frame = protocol.encodeOuterResult(value);
  assert.deepEqual(protocol.decodeOuterResult(frame, 1), value);
  for (const code of [0, 2, null])
    assert.throws(() => protocol.decodeOuterResult(frame, code));
  assert.throws(() => protocol.decodeOuterResult(frame.subarray(0, -1), 1));
  assert.throws(() => protocol.decodeOuterResult(Buffer.from(` ${frame.toString()}`), 1));
  const unknown = JSON.parse(syntheticUnknown().toString()).result;
  assert.throws(() => protocol.encodeOuterResult({
    ...value, result: unknown, cleanup: { ...value.cleanup, childCleanupConfirmed: false },
  }));
});
await check("valid failure publication after exit still confirms child cleanup", async () => {
  for (const cooperativeAbort of [false, true, "stdin-error-after-exit"]) {
    const parent = new FakeProcess(), read = session(parent);
    parent.stderr.write(protocol.encodeNotice({ kind: "PF2_CLEANUP_PENDING",
      pid: 5100, status: "FAIL", reason: failed.reason }));
    await tick();
    if (cooperativeAbort === true) read.abort("pf2_operator_abort");
    parent.exit(1);
    if (cooperativeAbort === "stdin-error-after-exit")
      parent.stdin.emit("error", new Error("fixture broken input pipe"));
    assert.equal(parent.stdout.destroyed, false);
    assert.equal(parent.stderr.destroyed, false);
    parent.stdout.end(protocol.encodePublication({
      version: 1, runnerToken: "b".repeat(64), kind: "PF2_PROVISIONAL", acceptance: "complete-frame-and-parent-exit-zero",
      result: failed, preservation: null,
      cleanup: { childStarted: true, closeObserved: true, stopRequested: true },
    }));
    parent.stderr.end();
    await tick();
    parent.close(1);
    const value = await read.completion;
    assert.equal(value.result.status, "FAIL");
    assert.equal(value.cleanup.childCleanupConfirmed, true);
    assert.equal(value.cleanup.operatorActionRequired, false);
  }
});

await check("child frame, nonce, pending deadline and bounded stderr guards", () => {
  const result = JSON.parse(syntheticUnknown().toString()).result;
  const nonce = "a".repeat(64);
  const frame = protocol.encodeResponse({ version: 1, nonce, result });
  const options = { code: 0, signal: null, stderrPrefix: "", expired: false, frame, nonce };
  assert.deepEqual(protocol.classifyChildClose(options), result);
  assert.equal(protocol.classifyChildClose({ ...options, code: 2 }).status, "NOTRUN");
  assert.equal(protocol.classifyChildClose({ ...options, nonce: "c".repeat(64) }).status, "FAIL");
  assert.equal(protocol.classifyChildClose({ ...options, pending: refused,
    stderrPrefix: "unexpected", expired: true }).reason, "pf2_child_stderr");
  assert.deepEqual(protocol.appendStderrPrefix("", Buffer.alloc(8193, 120)).failure,
    { status: "FAIL", reason: "pf2_child_stderr_overflow", evaluatorCalls: null });
  const banner = Buffer.from("JavaScript heap out of memory");
  assert.equal(protocol.appendStderrPrefix("", banner).failure, null);
  assert.equal(protocol.appendStderrPrefix(banner.toString(), Buffer.alloc(8193)).failure, null);
});
await check("OOM diagnostic survives publication and complete parent close with exit two", async () => {
  const result = protocol.classifyChildClose({ code: null, signal: "SIGABRT",
    stderrPrefix: "JavaScript heap out of memory", expired: false,
    frame: Buffer.alloc(0), nonce: "a".repeat(64) });
  assert.equal(result.reason, "pf2_heap_cap");
  const parent = new FakeProcess(), read = session(parent);
  parent.stdout.write(protocol.encodePublication({ version: 1, runnerToken: "b".repeat(64),
    kind: "PF2_PROVISIONAL", acceptance: "complete-frame-and-parent-exit-zero", result,
    preservation: null, cleanup: { childStarted: true, closeObserved: true, stopRequested: false } }));
  await closeFake(parent, 2);
  assert.deepEqual((await read.completion).result, result);
});
await check("runner token mismatch cannot commit a valid publication", async () => {
  const parent = new FakeProcess(), read = session(parent);
  const publication = JSON.parse(syntheticUnknown().toString());
  publication.runnerToken = "c".repeat(64);
  parent.stdout.write(protocol.encodePublication(publication));
  await closeFake(parent, 0);
  assert.equal((await read.completion).result.reason, "pf2_runner_token");
});

console.log(JSON.stringify({ kind: "SIMULATED_GUARDS_ONLY", node: process.version,
  actualParentChildLaunches: 0, numericalImports: 0, evaluatorCalls: 0, trialInvocations: 0,
  checks: tests, status: "PASS" }));
