import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { after, test } from "node:test";
import { build } from "esbuild";

const directory = await mkdtemp(join(process.cwd(), ".certified-runtime-"));
await build({ entryPoints: ["src/certifiedRuntime/client.ts", "src/certifiedRuntime/nodeFixtureWorker.ts", "shared/certifiedEngineProfile.ts", "shared/certifiedForecastIdentity.ts", "src/certifiedRuntime/nodeClient.ts", "src/certifiedRuntime/nodeWorker.ts", "src/certifiedRuntime/integrationFixture.ts", "src/certifiedRuntime/outputBinding.ts"],
  outdir: directory, outbase: ".", bundle: true, platform: "node", format: "esm", logLevel: "silent" }).catch(async (error) => {
    assert.ok(directory.startsWith(process.cwd() + sep));
    await rm(directory, { recursive: true, force: true });
    throw error;
  });
const { createCertifiedClient } = await import(pathToFileURL(join(directory, "src/certifiedRuntime/client.js")).href);
const { CERTIFIED_STAGING_ENGINE_PROFILE: engineProfile } = await import(pathToFileURL(join(directory, "shared/certifiedEngineProfile.js")).href);
const workerUrl = pathToFileURL(join(directory, "src/certifiedRuntime/nodeFixtureWorker.js"));
const { createNodeCertifiedClient } = await import(pathToFileURL(join(directory, "src/certifiedRuntime/nodeClient.js")).href);
const { certifiedWorkerFixture } = await import(pathToFileURL(join(directory, "src/certifiedRuntime/integrationFixture.js")).href);
const { createCertifiedForecastIdentity } = await import(pathToFileURL(join(directory, "shared/certifiedForecastIdentity.js")).href);
const { assertCertifiedOutputBinding, bindCertifiedOutput } = await import(pathToFileURL(join(directory, "src/certifiedRuntime/outputBinding.js")).href);
after(() => {
  assert.ok(directory.startsWith(process.cwd() + sep));
  return rm(directory, { recursive: true, force: true });
});

function harness({ terminationDelayMs = 0, initializationDelayMs = 0, binding = {} } = {}) {
  const state = { workers: 0, terminations: 0, terminationPending: 0, overlaps: 0, messages: [], errors: [] };
  const client = createCertifiedClient({ idleTimeoutMs: 50, ...binding, createWorker: () => {
    if (state.terminationPending) state.overlaps++;
    state.workers++;
      const worker = new Worker(workerUrl, { workerData: { initializationDelayMs } });
    return { runtime: "node", postMessage: (message) => worker.postMessage(message),
      listen: (message, error) => {
        state.messages.push(message); state.errors.push(error);
        worker.on("message", message); worker.on("error", error);
        return () => { worker.off("message", message); worker.off("error", error); };
      }, terminate: async () => {
        state.terminations++; state.terminationPending++;
        await worker.terminate();
        if (terminationDelayMs) await new Promise((resolve) => setTimeout(resolve, terminationDelayMs));
        state.terminationPending--;
      } };
  } });
  const request = (value, delayMs = 5, options = {}) => client.request({ value, delayMs, block: true }, { sessionId: value, engineProfile, ...options });
  return { client, request, state };
}
const code = (expected) => (error) => error.code === expected;

test("target request binding normalizes alpha and defaults without changing no-target output", async () => {
  const identity = await createCertifiedForecastIdentity((await certifiedWorkerFixture()).snapshot);
  const body = { provenance: { snapshotRevision: identity.snapshotRevision,
    snapshotSourceHash: identity.sourceHash } };
  const input = { target: { version: "target-v1",
    alpha: { numerator: "2", denominator: "4" } } };
  const target = { version: "target-v1", alpha: { numerator: "1", denominator: "2" },
    maxDays: 14, status: "unresolved", minimumDays: null, probabilities: [],
    earliestNotRuledOutDay: null, attainedByDay: null, completedThroughDay: null,
    value: null, reason: "target_in_progress" };
  const bound = bindCertifiedOutput({ ...body, target }, identity, input);
  assert.doesNotThrow(() => assertCertifiedOutputBinding(bound, identity, input));
  const historical = bindCertifiedOutput(body, identity);
  const unrequested = bindCertifiedOutput(body, identity, {});
  assert.equal(JSON.stringify(unrequested), JSON.stringify(historical));
  assert.equal(Object.hasOwn(unrequested, "target"), false);
  for (const changed of [
    undefined,
    { ...target, alpha: { numerator: "3", denominator: "4" } },
    { ...target, maxDays: 13 },
    { ...target, maxDays: undefined },
    { ...target, version: "other" },
    { ...target, alpha: { numerator: "1", denominator: "0" } },
  ]) {
    assert.throws(() => bindCertifiedOutput({ ...body, target: changed }, identity, input));
    assert.throws(() => assertCertifiedOutputBinding({ ...bound, target: changed }, identity, input));
  }
  assert.throws(() => bindCertifiedOutput({ ...body, target }, identity, {}));
  assert.throws(() => assertCertifiedOutputBinding(bound, identity, {}));
});

test("target mismatch is rejected on both current and result with matching envelopes", async () => {
  const identity = await createCertifiedForecastIdentity((await certifiedWorkerFixture()).snapshot);
  const input = { target: { version: "target-v1", alpha: { numerator: "1", denominator: "2" } } };
  const target = { ...input.target, maxDays: 14, status: "unresolved",
    earliestNotRuledOutDay: null, attainedByDay: null, completedThroughDay: null,
    minimumDays: null, probabilities: [], value: null, reason: "target_in_progress" };
  const good = bindCertifiedOutput({ target, provenance: {
    snapshotRevision: identity.snapshotRevision, snapshotSourceHash: identity.sourceHash,
  } }, identity, input);
  const bad = { ...good, target: { ...target, maxDays: 13 } };
  for (const phase of ["current", "result"]) {
    const published = [];
    const { client } = harness({ binding: {
      bindForecastIdentity: async () => identity,
      validateOutputBinding: assertCertifiedOutputBinding,
    } });
    try {
      await assert.rejects(client.request({ ...input, partial: phase === "current" ? bad : good,
        value: bad, delayMs: 5 }, { sessionId: phase, engineProfile,
        onCurrent: output => published.push(output) }), code("worker"));
      assert.deepEqual(published, phase === "current" ? [] : [good]);
    } finally { await client.dispose(); }
  }
});

test("target certificate checks inequalities, missing prefixes and selected exact value", async () => {
  const identity = await createCertifiedForecastIdentity((await certifiedWorkerFixture()).snapshot);
  const q = (numerator, denominator = 1) => ({ numerator: String(numerator), denominator: String(denominator) });
  const value = p => ({ successP: p, weightedExpectedConsumptionB: q(0),
    expectedTotalConsumptionC: q(0), expectedConsumed: [q(0), q(0), q(0)] });
  const input = { target: { version: "target-v1", alpha: q(1, 2), maxDays: 2 } };
  const body = { current: { value: value(q(0)) }, claimNotice: null,
    provenance: { snapshotRevision: identity.snapshotRevision, snapshotSourceHash: identity.sourceHash } };
  const target = { ...input.target, status: "certified", minimumDays: 1,
    earliestNotRuledOutDay: 1, attainedByDay: 1, completedThroughDay: 2,
    probabilities: [{ day: 0, successP: q(0) }, { day: 1, successP: q(1, 2) },
      { day: 2, successP: q(0) }], value: value(q(1, 2)), reason: null };
  const accept = t => bindCertifiedOutput({ ...body, target: t }, identity, input);
  assert.doesNotThrow(() => accept(target));
  for (const completedThroughDay of [2, 3, 14])
    assert.doesNotThrow(() => accept({ ...target, completedThroughDay }));
  for (const completedThroughDay of [-1, 1, 15, 2.5, null])
    assert.throws(() => accept({ ...target, completedThroughDay }));
  const gap = { ...target, status: "unresolved", minimumDays: null, value: null,
    earliestNotRuledOutDay: 1, attainedByDay: 2, completedThroughDay: 0,
    probabilities: [{ day: 0, successP: q(0) }, { day: 2, successP: q(1) }],
    reason: "missing_exact_dates" };
  assert.doesNotThrow(() => accept(gap));
  for (const corrupt of [
    { ...target, minimumDays: 2 },
    { ...target, attainedByDay: 2 },
    { ...target, completedThroughDay: 0 },
    { ...target, value: value(q(1)) },
    { ...target, value: { ...value(q(1, 2)), expectedTotalConsumptionC: q(1) } },
    { ...target, probabilities: [{ day: 0, successP: q(1) }, ...target.probabilities.slice(1)] },
    { ...target, probabilities: [...target.probabilities, { day: 2, successP: q(1) }] },
    { ...gap, status: "certified", minimumDays: 2, value: value(q(1)) },
    { ...gap, completedThroughDay: 2 },
    { ...target, status: "not_reached_within_limit", minimumDays: null, value: null },
  ]) assert.throws(() => accept(corrupt));
});

test("output binding receives submitted input snapshot for current and result", async () => {
  const identity = await createCertifiedForecastIdentity((await certifiedWorkerFixture()).snapshot);
  const seen = [];
  const { client } = harness({ binding: {
    bindForecastIdentity: async () => identity,
    validateOutputBinding: (output, actualIdentity, input) => {
      assert.deepEqual(actualIdentity, identity);
      assert.equal(input.context, "submitted");
      assert.equal(output.context, input.context);
      seen.push(output.phase);
    },
  } });
  try {
    const input = { context: "submitted", partial: { context: "submitted", phase: "current" },
      value: { context: "submitted", phase: "result" }, delayMs: 5 };
    const pending = client.request(input, { sessionId: "input-context", engineProfile });
    input.context = "caller-mutated";
    const result = await pending;
    assert.deepEqual(seen, ["current", "result"]);
    assert.deepEqual(result.output, input.value);
    assert.equal(Object.hasOwn(result.output, "target"), false);
  } finally { await client.dispose(); }
});

async function targetLifecycleHarness() {
  const identity = await createCertifiedForecastIdentity((await certifiedWorkerFixture()).snapshot);
  const input = { target: { version: "target-v1", alpha: { numerator: "1", denominator: "2" } } };
  const target = { ...input.target, maxDays: 14, status: "unresolved", minimumDays: null,
    probabilities: [], value: null, earliestNotRuledOutDay: null, attainedByDay: null,
    completedThroughDay: null, reason: "target_in_progress" };
  const output = bindCertifiedOutput({ target, provenance: {
    snapshotRevision: identity.snapshotRevision, snapshotSourceHash: identity.sourceHash,
  } }, identity, input);
  const ports = [];
  const started = [];
  const waiters = [];
  const preserved = [];
  const client = createCertifiedClient({
    bindForecastIdentity: async () => identity,
    validateOutputBinding: assertCertifiedOutputBinding,
    preservePartial: (partial, reason) => { preserved.push(reason); return partial; },
    createWorker: () => {
      const port = { receive: null };
      ports.push(port);
      return { runtime: "node", terminate: async () => {},
        listen: receive => { port.receive = receive; return () => {}; },
        postMessage: message => {
          if (message.type === "init") queueMicrotask(() => port.receive({
            type: "initComplete", generation: message.generation, engineProfile }));
          else {
            const run = { port, message };
            const waiter = waiters.shift();
            if (waiter) waiter(run); else started.push(run);
          }
        },
      };
    },
  });
  const next = () => started.length ? Promise.resolve(started.shift())
    : new Promise(resolve => waiters.push(resolve));
  const emit = (run, type, extra = {}) => run.port.receive({
    type, generation: run.message.generation, id: run.message.id,
    engineProfile, forecastIdentity: identity, output, ...extra,
  });
  return { client, input, output, next, emit, preserved };
}

test("target failures preserve only previously validated partials", async () => {
  for (const failureCode of ["solver_execution_failure", "request_total_deadline",
    "protocol_invariant", "response_payload_ceiling"]) {
    for (const hasCurrent of [false, true]) {
      const h = await targetLifecycleHarness();
      try {
        const pending = h.client.request(h.input, { sessionId: "failure", engineProfile });
        const allowed = hasCurrent && ["solver_execution_failure", "request_total_deadline"].includes(failureCode);
        const settled = allowed ? pending : assert.rejects(pending, code("worker"));
        const run = await h.next();
        if (hasCurrent) h.emit(run, "current");
        h.emit(run, "error", { code: failureCode, message: "synthetic failure" });
        const result = await settled;
        if (allowed) assert.deepEqual(result.output, h.output);
        assert.deepEqual(h.preserved, allowed
          ? [failureCode === "request_total_deadline" ? "deadline" : "worker"] : []);
      } finally { await h.client.dispose(); }
    }
  }
});

test("target cancelled and superseded runs cannot publish late current or results", async () => {
  for (const mode of ["aborted", "superseded"]) {
    for (const hasCurrent of [false, true]) {
      const h = await targetLifecycleHarness();
      try {
        const controller = new AbortController();
        const published = [];
        const old = h.client.request(h.input, { sessionId: "same", engineProfile,
          signal: controller.signal, onCurrent: value => published.push(value) });
        const settled = mode === "aborted" && hasCurrent ? old : assert.rejects(old, code(mode));
        const oldRun = await h.next();
        if (hasCurrent) h.emit(oldRun, "current");
        if (mode === "aborted") controller.abort();
        const replacement = h.client.request(h.input, { sessionId: "same", engineProfile,
          onCurrent: value => published.push(value) });
        const result = await settled;
        if (mode === "aborted" && hasCurrent) assert.deepEqual(result.output, h.output);
        const live = await h.next();
        const corrupt = { ...h.output, target: { ...h.output.target, minimumDays: 999 } };
        // Retired generation, then wrong request ID within the live generation.
        for (const type of ["current", "result"]) {
          h.emit(oldRun, type, { output: corrupt });
          h.emit(live, type, { id: oldRun.message.id, output: corrupt });
        }
        assert.equal(published.length, hasCurrent ? 1 : 0);
        h.emit(live, "result");
        assert.deepEqual((await replacement).output, h.output);
        assert.deepEqual(h.preserved, mode === "aborted" && hasCurrent ? ["aborted"] : []);
      } finally { await h.client.dispose(); }
    }
  }
});

test("target corrupt current is neither published nor preserved after worker failure", async () => {
  const h = await targetLifecycleHarness();
  try {
    let published = 0;
    const pending = h.client.request(h.input, { sessionId: "corrupt", engineProfile,
      onCurrent: () => published++ });
    const rejected = assert.rejects(pending, code("worker"));
    const run = await h.next();
    h.emit(run, "current", { output: { ...h.output,
      target: { ...h.output.target, attainedByDay: 1 } } });
    h.emit(run, "error", { code: "solver_execution_failure", message: "late failure" });
    await rejected;
    assert.equal(published, 0);
    assert.deepEqual(h.preserved, []);
  } finally { await h.client.dispose(); }
});

test("target validation time consumes the original response deadline", async () => {
  const h = await targetLifecycleHarness();
  const originalNow = Date.now;
  try {
    let published = 0;
    const pending = h.client.request(h.input, { sessionId: "validation-expiry", engineProfile,
      onCurrent: () => published++ });
    const rejected = assert.rejects(pending, code("deadline"));
    const run = await h.next();
    const output = { ...h.output, target: { ...h.output.target } };
    // Configuration is read inside host binding; no new timeout is started.
    Object.defineProperty(output.target, "alpha", { enumerable: true, get() {
      Date.now = () => run.message.deadlineAt;
      return h.input.target.alpha;
    } });
    h.emit(run, "result", { output });
    await rejected;
    assert.equal(published, 0);
    assert.deepEqual(h.preserved, []);
  } finally { Date.now = originalNow; await h.client.dispose(); }
});

test("target large exact probabilities use shared capacity, not the response byte cap", async () => {
  const h = await targetLifecycleHarness();
  try {
    const p = { numerator: "9".repeat(10000), denominator: "1" + "0".repeat(10000) };
    const input = { target: { version: "target-v1", alpha: { numerator: "1", denominator: "1" } } };
    const output = { ...h.output, current: { value: { successP: p } },
      target: { ...h.output.target, alpha: input.target.alpha, status: "not_reached_within_limit",
        probabilities: Array.from({ length: 15 }, (_, day) => ({ day, successP: p })),
        completedThroughDay: 14, reason: null } };
    assert.ok(Buffer.byteLength(JSON.stringify(output)) < 2 * 1024 * 1024);
    let held = 0;
    let peak = 0;
    const budget = { check() {}, reserve(bytes) { held += bytes; peak = Math.max(peak, held); },
      release(bytes) { held -= bytes; } };
    assertCertifiedOutputBinding(output, h.output.runtimeBinding.forecastIdentity, input, budget);
    assert.ok(peak > 2 * 1024 * 1024);
    assert.equal(held, 0);
    const exhausted = Object.assign(new Error("capacity exhausted"), { code: "memory" });
    const limited = { ...budget, reserve(bytes) { held += bytes; throw exhausted; } };
    assert.throws(() => assertCertifiedOutputBinding(output,
      h.output.runtimeBinding.forecastIdentity, input, limited), error => error === exhausted);
    assert.equal(held, 0, "failed reserve must also be released");
    const invalid = { ...output, target: { ...output.target, attainedByDay: 2 } };
    assert.throws(() => assertCertifiedOutputBinding(invalid,
      h.output.runtimeBinding.forecastIdentity, input, budget), /target_evidence_binding_mismatch/);
    assert.equal(held, 0, "schema failure must release admitted workspace");
  } finally { await h.client.dispose(); }
});

test("real Worker target rollback preserves current while binding memory and corruption stay failures", async () => {
  const workerPath = join(directory, "target-boundary-worker.mjs");
  await build({
    entryPoints: ["src/certifiedRuntime/nodeWorker.ts"], outfile: workerPath,
    bundle: true, platform: "node", format: "esm", logLevel: "silent",
    plugins: [{ name: "synthetic-solver-only", setup(builder) {
      builder.onResolve({ filter: /\/certified\/wasm(?:Solver|Backend)\.ts$/ }, () => ({
        path: join(process.cwd(), "src/certifiedRuntime/targetBoundarySolverFixture.mjs"),
      }));
    } }],
  });
  const input = { ...await certifiedWorkerFixture(),
    target: { version: "target-v1", alpha: { numerator: "1", denominator: "2" } } };
  const identity = await createCertifiedForecastIdentity(input.snapshot);
  const output = {
    status: "partial", current: { value: { successP: { numerator: "0", denominator: "1" } } },
    target: { ...input.target, maxDays: 14, status: "unresolved", minimumDays: null,
      probabilities: [], value: null, earliestNotRuledOutDay: null, attainedByDay: null,
      completedThroughDay: null, reason: "target_in_progress" },
    provenance: { snapshotRevision: identity.snapshotRevision, snapshotSourceHash: identity.sourceHash },
  };
  for (const mode of ["rollback", "binding-memory", "invalid-binding"]) {
    const replies = [];
    const published = [];
    let preserved = 0;
    const client = createCertifiedClient({
      bindForecastIdentity: async () => identity,
      validateOutputBinding: assertCertifiedOutputBinding,
      preservePartial: partial => { preserved++; return partial; },
      createWorker: () => {
        const worker = new Worker(pathToFileURL(workerPath), { workerData: { mode, output } });
        return { runtime: "node", postMessage: message => worker.postMessage(message),
          terminate: () => worker.terminate(), listen: (receive, error) => {
            const message = reply => { replies.push(reply); receive(reply); };
            worker.on("message", message); worker.on("error", error);
            return () => { worker.off("message", message); worker.off("error", error); };
          } };
      },
    });
    try {
      const pending = client.request(input, { sessionId: mode, engineProfile,
        onCurrent: current => published.push(current) });
      if (mode === "rollback") {
        const result = await pending;
        assert.deepEqual(result.output.current, output.current);
        assert.equal(result.output.target.status, "unresolved");
        assert.equal(result.output.refusal.reason, "managed_payload_ceiling");
        assert.equal(replies.at(-1).type, "result");
      } else {
        await assert.rejects(pending, code(mode === "binding-memory" ? "memory" : "worker"));
        assert.equal(replies.at(-1).code,
          mode === "binding-memory" ? "managed_payload_ceiling" : "protocol_invariant");
      }
      assert.equal(published.length, 1);
      assert.deepEqual(published[0].current, output.current);
      assert.equal(preserved, 0, "normal final result or hard binding failure; no expanded recovery");
    } finally { await client.dispose(); }
  }
});

test("input binding mismatch fails without publishing corrupt current or result", async () => {
  const identity = await createCertifiedForecastIdentity((await certifiedWorkerFixture()).snapshot);
  for (const phase of ["current", "result"]) {
    const published = [];
    const { client } = harness({ binding: {
      bindForecastIdentity: async () => identity,
      validateOutputBinding: (output, _identity, input) => {
        if (output.context !== input.context) throw new Error("input mismatch");
      },
    } });
    try {
      await assert.rejects(client.request({
        context: "submitted",
        partial: { context: phase === "current" ? "wrong" : "submitted" },
        value: { context: "wrong" }, delayMs: 5,
      }, { sessionId: phase, engineProfile, onCurrent: output => published.push(output) }),
      code("worker"));
      assert.deepEqual(published, phase === "current" ? [] : [{ context: "submitted" }]);
    } finally { await client.dispose(); }
  }
});

test("completed signal cannot cancel a newer request; input is snapshotted", async () => {
  const { client, request } = harness();
  try {
    const controller = new AbortController();
    assert.equal((await request("first", 5, { signal: controller.signal })).output, "first");
    const pending = request("second", 20);
    controller.abort();
    assert.equal((await pending).output, "second");
    const input = { value: "snapshot", delayMs: 5 };
    const immutable = client.request(input, { sessionId: "snapshot", engineProfile });
    input.value = "mutated";
    assert.equal((await immutable).output, "snapshot");
    const observer = await client.request({ value: "observer", partial: "current", delayMs: 5 },
      { sessionId: "observer", engineProfile, onCurrent: () => { throw new Error("observer failure"); } });
    assert.equal(observer.output, "observer");
    assert.equal(observer.diagnostics.observerCallbackFailureCount, 1);
    assert.equal(observer.diagnostics.observerFailureCode, "observer_callback_failure");
    assert.equal(client.memory().observerPayloadBytes, 0);
  } finally { await client.dispose(); }
});
test("queued B deadline never terminates A (A 300ms, B 5ms / 150ms total)", async () => {
  const { client, request, state } = harness();
  try {
    const a = request("A", 300);
    const b = request("B", 5, { totalDeadlineMs: 150 });
    await assert.rejects(b, code("deadline"));
    await assert.rejects(client.request({ value: "oversized", delayMs: 5, bytes: new Uint8Array(17 * 1024 * 1024) },
      { sessionId: "A", engineProfile }), code("memory"));
    assert.equal((await a).output, "A");
    assert.equal(state.terminations, 0);
  } finally { await client.dispose(); }
});
test("supersedes both same-session queued and inflight, preserves other sessions", async () => {
  const { client, request } = harness();
  try {
    const a = request("A", 300, { sessionId: "same" });
    const aRejected = assert.rejects(a, code("superseded"));
    await new Promise((resolve) => setTimeout(resolve, 35));
    const other = request("other", 15);
    const oldQueued = request("old-queued", 10, { sessionId: "same" });
    const oldRejected = assert.rejects(oldQueued, code("superseded"));
    const latest = request("latest", 5, { sessionId: "same" });
    await Promise.all([aRejected, oldRejected]);
    assert.equal((await other).output, "other");
    assert.equal((await latest).output, "latest");
  } finally { await client.dispose(); }
});
test("awaits actual Node termination before replacement and ignores stale error callbacks", async () => {
  const { client, request, state } = harness({ terminationDelayMs: 80 });
  try {
    const controller = new AbortController();
    const first = request("first", 300, { signal: controller.signal });
    const rejected = assert.rejects(first, code("aborted"));
    await new Promise((resolve) => setTimeout(resolve, 35));
    const oldError = state.errors[0];
    controller.abort();
    const replacement = request("replacement", 100);
    await rejected;
    await new Promise((resolve) => setTimeout(resolve, 110));
    oldError(new Error("late retired Worker error"));
    state.messages[0]({ type: "result", generation: 1, id: 1, output: "destroyed-worker" });
    assert.equal((await replacement).output, "replacement");
    assert.equal(state.overlaps, 0);
    assert.equal(state.workers, 2);
  } finally { await client.dispose(); }
});
test("abort a real Worker during delayed initialization and expire initialization deadline", async () => {
  const { client, request, state } = harness({ initializationDelayMs: 300 });
  try {
    const controller = new AbortController();
    const pending = request("abort-init", 5, { signal: controller.signal });
    const rejected = assert.rejects(pending, (error) => error.code === "aborted" && error.message.includes("init"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(state.workers, 1);
    controller.abort();
    await rejected;
    await assert.rejects(request("expire-init", 5, { totalDeadlineMs: 100 }),
      (error) => error.code === "deadline" && error.message.includes("init"));
    assert.equal(state.terminations, 2);
  } finally { await client.dispose(); }
});
test("abort initialization/compute, idle disposal, profile rejection, no double settlement", async () => {
  const { client, request, state } = harness();
  try {
    await assert.rejects(request("bad", 1, { engineProfile: { ...engineProfile, environment: "production" } }), code("profile"));
    for (const field of Object.keys(engineProfile)) {
      await assert.rejects(request("bad-field", 1, { engineProfile: { ...engineProfile, [field]: "mismatch" } }), code("profile"));
    }
    const controller = new AbortController();
    const init = request("init", 200, { signal: controller.signal });
    const rejected = assert.rejects(init, code("aborted"));
    controller.abort();
    await rejected;
    assert.equal((await request("next")).output, "next");
    assert.ok(client.memory().totalPayloadBytes === 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(state.terminations, state.workers);
    await client.dispose();
    await assert.rejects(request("disposed"), code("disposed"));
  } finally { await client.dispose(); }
});
test("hard total deadline preserves the streamed certified current partial", async () => {
  const { client } = harness();
  try {
    let received = 0;
    const result = await client.request({ value: "full", delayMs: 300, block: true, partial: "current" },
      { sessionId: "partial", engineProfile, totalDeadlineMs: 150, onCurrent: () => received++ });
    assert.equal(result.output, "current");
    assert.equal(received, 1);
    assert.ok(result.timing.totalMs < 220);
  } finally { await client.dispose(); }
});

test("Worker deadline error arriving before delayed client timer retains exact current", async () => {
  const { client } = harness();
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, delay > 125 && delay <= 150 ? 500 : delay, ...args);
  try {
    const task = client.request({ value: "unreachable", partial: "exact-current", delayMs: 0,
      failureCode: "request_total_deadline", errorAtDeadline: true },
      { sessionId: "deadline-error-first", engineProfile, totalDeadlineMs: 150 });
    const result = await task;
    assert.equal(result.output, "exact-current");
    assert.ok(result.timing.totalMs < 350, "Worker error must settle before the delayed client timer.");
  } finally { globalThis.setTimeout = originalSetTimeout; await client.dispose(); }
});

test("computation failures preserve current; invariant failures reject corrupted request", async () => {
  for (const failureCode of ["solver_execution_failure", "protocol_invariant", "profile_mismatch", "response_payload_ceiling"]) {
    const { client } = harness();
    try {
      const task = client.request({ value: "unreachable", partial: "exact-current", delayMs: 5, failureCode },
        { sessionId: failureCode, engineProfile });
      if (failureCode === "solver_execution_failure") assert.equal((await task).output, "exact-current");
      else await assert.rejects(task, code("worker"));
      assert.equal((await client.request({ value: "replacement", delayMs: 5 },
        { sessionId: "replacement", engineProfile })).output, "replacement");
    } finally { await client.dispose(); }
  }
});

test("actual production Worker handler rejects each profile mismatch before solving", async () => {
  const worker = new Worker(pathToFileURL(join(directory, "src/certifiedRuntime/nodeWorker.js")));
  const exchange = (message) => new Promise((resolveReply, rejectReply) => {
    const error = (failure) => rejectReply(failure);
    worker.once("error", error);
    worker.once("message", (reply) => { worker.off("error", error); resolveReply(reply); });
    worker.postMessage(message);
  });
  try {
    for (const field of Object.keys(engineProfile)) {
      const reply = await exchange({ type: "init", generation: 1,
        engineProfile: { ...engineProfile, [field]: "mismatch" } });
      assert.equal(reply.type, "error", field);
      assert.equal(reply.code, "profile_mismatch", field);
    }
    const initialized = await exchange({ type: "init", generation: 1, engineProfile });
    assert.equal(initialized.type, "initComplete");
    const badSolve = await exchange({ type: "solve", generation: 1, id: 1, sessionId: "direct-mismatch",
      engineProfile: { ...engineProfile, schemaVersion: "mismatch" }, input: {}, deadlineAt: Date.now() + 1000 });
    assert.equal(badSolve.type, "error");
    assert.equal(badSolve.code, "profile_mismatch");
  } finally { await worker.terminate(); }
});

test("production Worker independently rejects identity/content mismatches before compute", async () => {
  const worker = new Worker(pathToFileURL(join(directory, "src/certifiedRuntime/nodeWorker.js")));
  let computes = 0;
  worker.on("message", (reply) => { if (reply.type === "computeStarted") computes++; });
  const exchange = (message) => new Promise((resolveReply, rejectReply) => {
    const error = (failure) => rejectReply(failure);
    worker.once("error", error);
    worker.once("message", (reply) => { worker.off("error", error); resolveReply(reply); });
    worker.postMessage(message);
  });
  try {
    await exchange({ type: "init", generation: 1, engineProfile });
    const input = await certifiedWorkerFixture();
    const identity = await createCertifiedForecastIdentity(input.snapshot);
    let id = 0;
    for (const field of Object.keys(identity)) {
      const forecastIdentity = {...identity, [field]: field.endsWith("Hash") ? "b".repeat(64) : "mismatch"};
      const reply = await exchange({ type: "solve", generation: 1, id: ++id, sessionId: "identity",
        engineProfile, forecastIdentity, input, deadlineAt: Date.now() + 15000 });
      assert.equal(reply.type, "error", field);
      assert.equal(reply.code, "forecast_identity_mismatch", field);
    }
    input.snapshot = {...input.snapshot, provenance: [...input.snapshot.provenance, "changed-semantic-content"]};
    assert.notEqual((await createCertifiedForecastIdentity(input.snapshot)).snapshotHash, identity.snapshotHash);
    const changed = await exchange({ type: "solve", generation: 1, id: ++id, sessionId: "changed-content",
      engineProfile, forecastIdentity: identity, input, deadlineAt: Date.now() + 15000 });
    assert.equal(changed.type, "error");
    assert.equal(changed.code, "forecast_identity_mismatch");
    assert.equal(computes, 0);
  } finally { await worker.terminate(); }
});

test("same-generation stale result identity/code hash cannot replace streamed current", async () => {
  const identity = await createCertifiedForecastIdentity((await certifiedWorkerFixture()).snapshot);
  for (const mutation of ["resultIdentityMutation", "resultProfileMutation"]) {
    const {client} = harness({binding: {bindForecastIdentity: async () => identity}});
    try {
      let sawCurrent = false;
      await assert.rejects(client.request({value: "stale", partial: "exact-current", delayMs: 5, [mutation]: true},
        {sessionId: mutation, engineProfile, onCurrent: () => {sawCurrent = true;}}), code("worker"));
      assert.equal(sawCurrent, true);
    } finally { await client.dispose(); }
  }
});

test("every compute/error response must match full profile and forecast binding", async () => {
  const identity = await createCertifiedForecastIdentity((await certifiedWorkerFixture()).snapshot);
  for (const mutation of ["computeIdentityMutation", "computeProfileMutation", "errorIdentityMutation", "errorProfileMutation", "omitComputeIdentity", "omitErrorIdentity"]) {
    const {client} = harness({binding: {bindForecastIdentity: async () => identity}});
    try {
      await assert.rejects(client.request({value: "unreachable", partial: "exact-current", delayMs: 5,
        failureCode: "solver_execution_failure", [mutation]: true}, {sessionId: mutation, engineProfile}), code("worker"));
    } finally {await client.dispose();}
  }
});

test("hash workspace stays charged after supersession until its ownership release", async () => {
  const identity = await createCertifiedForecastIdentity((await certifiedWorkerFixture()).snapshot);
  let release;
  let hashing;
  const held = new Promise((resolveHash) => { release = resolveHash; });
  const started = new Promise((resolveStarted) => { hashing = resolveStarted; });
  let calls = 0;
  const {client, request} = harness({binding: {bindForecastIdentity: async (_input, track) => {
    if (++calls === 1) { track(1024 * 1024); hashing(); await held; track(0); }
    return identity;
  }}});
  try {
    const old = request("old", 5, {sessionId: "same"});
    const rejected = assert.rejects(old, code("superseded"));
    await started;
    const next = request("new", 5, {sessionId: "same"});
    await rejected;
    assert.ok(client.memory().bindingPayloadBytes >= 1024 * 1024);
    release();
    assert.equal((await next).output, "new");
    assert.equal(client.memory().bindingPayloadBytes, 0);
  } finally { release(); await client.dispose(); }
});
test("correct response envelope cannot authorize stale solver provenance", async () => {
  const identity = await createCertifiedForecastIdentity((await certifiedWorkerFixture()).snapshot);
  const current = {provenance: {snapshotRevision: identity.snapshotRevision, snapshotSourceHash: identity.sourceHash},
    runtimeBinding: {engineProfile, forecastIdentity: identity}};
  const {client} = harness({binding: {bindForecastIdentity: async () => identity,
    validateOutputBinding: assertCertifiedOutputBinding}});
  try {
    let sawCurrent = false;
    await assert.rejects(client.request({value: {provenance: {...current.provenance, snapshotRevision: "stale"}},
      partial: current, delayMs: 5}, {sessionId: "stale-content", engineProfile,
      onCurrent: () => {sawCurrent = true;}}), code("worker"));
    assert.equal(sawCurrent, true);
  } finally { await client.dispose(); }
});

test("output body binding validates code hash and complete forecast identity", async () => {
  const identity = await createCertifiedForecastIdentity((await certifiedWorkerFixture()).snapshot);
  const valid = {provenance: {snapshotRevision: identity.snapshotRevision, snapshotSourceHash: identity.sourceHash},
    runtimeBinding: {engineProfile, forecastIdentity: identity}};
  for (const field of ["codeHash", "forecastId", "snapshotHash"]) {
    const changed = structuredClone(valid);
    if (field === "codeHash") changed.runtimeBinding.engineProfile.codeHash = "b".repeat(64);
    else changed.runtimeBinding.forecastIdentity[field] = field === "snapshotHash" ? "b".repeat(64) : "stale";
    const {client} = harness({binding: {bindForecastIdentity: async () => identity,
      validateOutputBinding: assertCertifiedOutputBinding}});
    try {
      await assert.rejects(client.request({value: changed, partial: valid, delayMs: 5},
        {sessionId: field, engineProfile}), code("worker"));
    } finally {await client.dispose();}
  }
});

test("dispose awaits pending hash ownership release and prevents late dispatch", async () => {
  const identity = await createCertifiedForecastIdentity((await certifiedWorkerFixture()).snapshot);
  let release;
  let hashing;
  const held = new Promise((resolveHash) => {release = resolveHash;});
  const started = new Promise((resolveStarted) => {hashing = resolveStarted;});
  const {client, request, state} = harness({binding: {bindForecastIdentity: async (_input, track) => {
    track(1024 * 1024); hashing(); await held; track(0); return identity;
  }}});
  try {
    let sawCurrent = false;
    const pending = request("never-dispatched", 5, {onCurrent: () => {sawCurrent = true;}});
    const rejected = assert.rejects(pending, code("disposed"));
    await started;
    let disposed = false;
    const disposal = client.dispose().then(() => {disposed = true;});
    await rejected;
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
    assert.equal(disposed, false);
    assert.ok(client.memory().bindingPayloadBytes >= 1024 * 1024);
    release();
    await disposal;
    assert.equal(client.memory().bindingPayloadBytes, 0);
    assert.equal(sawCurrent, false);
    assert.equal(state.terminations, state.workers);
  } finally {release(); await client.dispose();}
});

test("production client rejects a self-consistent unapproved snapshot", async () => {
  const client = createNodeCertifiedClient(pathToFileURL(join(directory, "src/certifiedRuntime/nodeWorker.js")));
  try {
    const input = await certifiedWorkerFixture();
    input.snapshot = {...input.snapshot, provenance: [...input.snapshot.provenance, "unapproved-self-consistent-content"]};
    await assert.rejects(client.request(input, {sessionId: "unapproved", engineProfile}), code("worker"));
  } finally {await client.dispose();}
});

test("production Worker independently rejects a self-consistent unapproved snapshot", async () => {
  const worker = new Worker(pathToFileURL(join(directory, "src/certifiedRuntime/nodeWorker.js")));
  const exchange = (message) => new Promise((resolveReply, rejectReply) => {
    const error = (failure) => rejectReply(failure);
    worker.once("error", error);
    worker.once("message", (reply) => {worker.off("error", error); resolveReply(reply);});
    worker.postMessage(message);
  });
  try {
    await exchange({type: "init", generation: 1, engineProfile});
    const input = await certifiedWorkerFixture();
    input.snapshot = {...input.snapshot, provenance: [...input.snapshot.provenance, "unapproved-self-consistent-content"]};
    const forecastIdentity = await createCertifiedForecastIdentity(input.snapshot);
    const reply = await exchange({type: "solve", generation: 1, id: 1, sessionId: "unapproved",
      engineProfile, forecastIdentity, input, deadlineAt: Date.now()+15000});
    assert.equal(reply.type, "error");
    assert.equal(reply.code, "forecast_identity_mismatch");
  } finally {await worker.terminate();}
});

test("actual certified Node Worker solves sequentially under the 15s all-phase contract", async () => {
  const client = createNodeCertifiedClient(pathToFileURL(join(directory, "src/certifiedRuntime/nodeWorker.js")));
  try {
    let current = 0;
    const minimumStages = [];
    for (let repeat = 0; repeat < 3; repeat++) {
      const waiting = repeat % 2 === 1;
      const result = await client.request(await certifiedWorkerFixture(waiting), { sessionId: "actual-solver", engineProfile,
        onCurrent: partial => { current++; minimumStages.push(partial.minimumWait?.status); } });
      assert.equal(result.output.status, "completed");
      assert.equal(result.output.current.kit, "blue");
      assert.equal(result.output.current.value.display.successP, 1);
      assert.equal(result.output.waiting.status, waiting ? "certified" : "not_requested");
      if (waiting) assert.equal(result.output.waiting.recommendedDays, 0);
      assert.equal(result.output.provenance.requestBudgetMs, 15000);
      assert.ok(result.timing.totalMs < 15000);
      assert.ok(result.memory.activePayloadBytes > 0);
      assert.ok(result.memory.workerPayloadBytes > 0);
      assert.equal(client.memory().totalPayloadBytes, 0);
    }
    assert.equal(current, 6);
    assert.deepEqual(minimumStages, ["unknown", "beyond_horizon", "unknown", "beyond_horizon", "unknown", "beyond_horizon"]);
    const controller = new AbortController();
    const interrupted = await client.request(await certifiedWorkerFixture(true), { sessionId: "interrupt-waiting", engineProfile,
      signal: controller.signal, onCurrent: () => controller.abort() });
    assert.equal(interrupted.output.status, "partial");
    assert.equal(interrupted.output.current.value.display.successP, 1);
    assert.equal(interrupted.output.waiting.status, "unresolved");
    assert.equal(interrupted.output.waiting.reason, "worker_abort");
    assert.equal(interrupted.output.waiting.recommendedDays, null);
    await assert.rejects(client.request(await certifiedWorkerFixture(), { sessionId: "invalid-deadline", engineProfile, totalDeadlineMs: 30000 }), code("deadline"));
  } finally { await client.dispose(); }
});
