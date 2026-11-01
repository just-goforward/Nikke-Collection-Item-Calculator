import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FILE_IMPORT_TARGET, runFileImport } from "./d1-file-import.mjs";
import { openStateStore } from "./d1-file-import-state.mjs";
import { createD1FileHttpsTransport } from "./d1-file-import-https.mjs";

const SHA = "df5394e74a3553516673fccd042e2a6b9bd07481aac44e8216aa62c5ae97e6de";
const SIZE = 13969;
const EXECUTION = "00000000-0000-0000-0000-000000000001";
const ORIGIN = "https://file-upload.synthetic.invalid";
const PRIVATE_URL = `${ORIGIN}/private-upload?signature=DO_NOT_DISCLOSE`;
const AUTHORIZATION = "Bearer SYNTHETIC_ONLY_DO_NOT_DISCLOSE";
const EPOCH = 1800000000000;
const PINNED = await readFile(FILE_IMPORT_TARGET.path);
assert.equal(PINNED.byteLength, SIZE, "approved fixture size");
assert.equal(createHash("sha256").update(PINNED).digest("hex"), SHA, "approved fixture hash");
const MD5 = createHash("md5").update(PINNED).digest("hex");
const API_URL = `https://api.cloudflare.com/client/v4/accounts/${FILE_IMPORT_TARGET.account}/d1/database/${FILE_IMPORT_TARGET.database}/import`;

const api = result => ({ status: 200, body: { success: true, result } });
const upload = () => api({ upload_url: PRIVATE_URL, filename: "synthetic-approved.sql" });
const active = bookmark => api({ status: "active", success: true, at_bookmark: bookmark });
const complete = () => api({
  status: "complete", success: true, result: { final_bookmark: "synthetic-final-bookmark" },
});
const stageOf = request => request.method === "PUT" ? "put" : JSON.parse(request.body).action;

function callerApproval(overrides = {}) {
  return {
    id: "synthetic-caller-approval",
    providerId: "synthetic-provider",
    purpose: "d1-file-import",
    binding: {
      accountId: FILE_IMPORT_TARGET.account, databaseId: FILE_IMPORT_TARGET.database,
      sqlSha256: SHA, executionId: EXECUTION,
    },
    expiresAt: EPOCH + 600000,
    scope: "synthetic",
    permissionEvidenceRef: "synthetic-caller-evidence",
    ...overrides,
  };
}

function retainedState(overrides = {}) {
  return {
    version: 1,
    binding: {
      accountId: FILE_IMPORT_TARGET.account,
      databaseId: FILE_IMPORT_TARGET.database,
      sqlSha256: SHA,
      executionId: EXECUTION,
    },
    sequence: 4,
    phase: "poll",
    counts: { init: 1, put: 0, ingest: 0, poll: 0 },
    startedAt: EPOCH,
    deadlineAt: EPOCH + 600000,
    inFlight: null,
    operation: { atBookmark: "synthetic-retained-bookmark" },
    outcome: "pending",
    postcheck: "not_run",
    ...overrides,
  };
}

function fixture(options = {}) {
  const calls = [], saves = [], contexts = [], waits = [];
  const store = { record: structuredClone(options.record ?? null) };
  let now = EPOCH, timeoutPending = false, closes = 0, authCalls = 0;
  const clock = {
    now: () => now,
    async wait(promise, ms) {
      waits.push(ms);
      await Promise.resolve();
      if (timeoutPending) throw new Error("synthetic timeout after dispatch");
      return await promise;
    },
  };
  const session = () => ({
    async load() { return structuredClone(store.record); },
    async save(record) {
      if (options.rejectSave?.({ record, calls, saves })) throw new Error(PRIVATE_URL);
      store.record = structuredClone(record);
      saves.push(structuredClone(record));
    },
    async close() { closes++; },
  });
  const transport = {
    synthetic: true, noRetries: true, noRedirects: true,
    get metrics() { return { dispatched: calls.length }; },
    async request(request) {
      const stage = stageOf(request);
      calls.push({ ...request, headers: { ...request.headers }, stage });
      const durable = store.record;
      assert.equal(durable.inFlight, stage, "intent durable before each dispatch");
      assert.equal(durable.counts[stage], calls.filter(call => call.stage === stage).length +
        (options.record?.counts[stage] ?? 0), "attempt charged before dispatch");
      if (stage === options.timeoutAt) {
        timeoutPending = true;
        return await new Promise(() => {});
      }
      const responder = options[stage] ?? {
        init: upload,
        put: () => ({ status: 200, headers: { etag: `"${MD5}"` } }),
        ingest: () => active("synthetic-ingest-bookmark"),
        poll: complete,
      }[stage];
      return await responder(request, calls.filter(call => call.stage === stage).length);
    },
  };
  const authProvider = {
    id: "synthetic-provider",
    synthetic: true,
    async getAuthorization(context) {
      authCalls++;
      contexts.push(context);
      return options.authorize ? await options.authorize(context) : AUTHORIZATION;
    },
  };
  async function run(changes = {}) {
    timeoutPending = false;
    const result = await runFileImport({
      session: session(), transport, authProvider, clock,
      input: { ...FILE_IMPORT_TARGET }, uploadOrigin: ORIGIN, operationId: EXECUTION,
      approval: callerApproval(),
      ...changes,
    });
    assert.equal(result.postverified, false);
    assert.equal(result.rollbackClaimed, false);
    assert.equal(result.serverCancellationClaimed, false);
    for (const context of contexts) assert.equal(context.signal.aborted, true, "provider scope closed");
    for (const call of calls) assert.equal(call.signal.aborted, true, "request scope closed");
    const publicText = JSON.stringify(result);
    for (const sensitive of [AUTHORIZATION, PRIVATE_URL, "synthetic-retained-bookmark",
      "synthetic-final-bookmark", "synthetic-ingest-bookmark"]) {
      assert.ok(!publicText.includes(sensitive), "public summary excludes secrets and handles");
    }
    return result;
  }
  return {
    calls, saves, contexts, waits, store, session, transport, clock, authProvider, run,
    setNow(value) { now = value; },
    get closes() { return closes; },
    get authCalls() { return authCalls; },
  };
}

function stages(f) { return f.calls.map(call => call.stage); }
function assertStopped(result, f, expected) {
  assert.equal(result.status, "unknown");
  assert.deepEqual(stages(f), expected);
  assert.equal(result.actualRequestsThisRun, expected.length);
  assert.equal(result.transportInvocationsThisRun, expected.length);
  assert.equal(f.store.record.outcome, "unknown");
}

test("approved byte snapshot alone is uploaded despite subsequent scratch-file mutation", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "file-import-snapshot-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scratchSQL = path.join(directory, "approved-copy.sql");
  await writeFile(scratchSQL, PINNED);
  const f = fixture();
  let snapshots = 0;
  const result = await f.run({
    input: { ...FILE_IMPORT_TARGET, path: scratchSQL },
    async afterPin(metadata) {
      snapshots++;
      assert.deepEqual(metadata, { sha256: SHA, byteLength: SIZE });
      await writeFile(scratchSQL, "MUTATED SCRATCH COPY; NOT APPROVED SQL\n");
    },
  });
  assert.equal(result.status, "complete_pending_postcheck");
  assert.equal(result.actualRequestsThisRun, 4);
  assert.equal(result.transportInvocationsThisRun, 4);
  assert.equal(snapshots, 1);
  assert.deepEqual(stages(f), ["init", "put", "ingest", "poll"]);
  assert.equal(f.closes, 1);
  assert.equal(f.authCalls, 1);
  const [init, put, ingest, poll] = f.calls;
  for (const request of [init, ingest, poll]) {
    assert.equal(request.method, "POST");
    assert.equal(request.url, API_URL);
    assert.equal(request.redirect, "error");
    assert.deepEqual(request.headers, {
      Authorization: AUTHORIZATION, "Content-Type": "application/json",
    });
  }
  assert.deepEqual(JSON.parse(init.body), { action: "init", etag: MD5 });
  assert.deepEqual(JSON.parse(ingest.body), {
    action: "ingest", filename: "synthetic-approved.sql", etag: MD5,
  });
  assert.deepEqual(JSON.parse(poll.body), {
    action: "poll", current_bookmark: "synthetic-ingest-bookmark",
  });
  assert.equal(put.url, PRIVATE_URL);
  assert.equal(put.redirect, "error");
  assert.deepEqual(put.headers, { "Content-Length": "13969" });
  assert.ok(Buffer.isBuffer(put.body));
  assert.deepEqual(put.body, PINNED);
  assert.equal(createHash("sha256").update(put.body).digest("hex"), SHA);
  assert.notDeepEqual(await readFile(scratchSQL), put.body);
  assert.ok(!JSON.stringify(f.saves).includes(PRIVATE_URL), "upload URL never persisted");
  assert.equal(f.store.record.postcheck, "pending");
});

test("cache-pending INIT observes bookmark without PUT or INGEST", async () => {
  const f = fixture({ init: () => active("synthetic-cache-bookmark") });
  const result = await f.run();
  assert.equal(result.status, "complete_pending_postcheck");
  assert.deepEqual(stages(f), ["init", "poll"]);
  assert.deepEqual(JSON.parse(f.calls[1].body), {
    action: "poll", current_bookmark: "synthetic-cache-bookmark",
  });
});

test("cache-complete acknowledgement remains pending independent postcheck on restart", async () => {
  const f = fixture({ init: complete });
  const first = await f.run();
  assert.equal(first.status, "complete_pending_postcheck");
  assert.equal(first.postverified, false);
  assert.deepEqual(stages(f), ["init"]);
  const second = await f.run();
  assert.equal(second.status, "complete_pending_postcheck");
  assert.equal(second.reason, "terminal_record");
  assert.equal(second.actualRequestsThisRun, 0);
  assert.equal(f.authCalls, 1);
});

for (const stage of ["init", "put", "ingest", "poll"]) {
  const prefix = ["init", "put", "ingest", "poll"].slice(0,
    ["init", "put", "ingest", "poll"].indexOf(stage) + 1);
  for (const failure of ["timeout", "lost acknowledgement", "malformed acknowledgement"]) {
    test(`${stage} ${failure} stops without retry or subsequent stage`, async () => {
      const options = failure === "timeout" ? { timeoutAt: stage } : {
        [stage]: failure === "lost acknowledgement"
          ? () => { throw new Error(PRIVATE_URL); }
          : () => stage === "put"
            ? { status: 200, headers: {} }
            : { status: 200, body: { success: true, result: {} } },
      };
      const f = fixture(options);
      assertStopped(await f.run(), f, prefix);
      assert.equal(f.closes, 1);
    });
  }
}

test("first journal failure prevents authorization and every dispatch", async () => {
  const f = fixture({ rejectSave: () => true });
  const result = await f.run();
  assert.equal(result.journalDurable, false);
  assert.equal(result.actualRequestsThisRun, 0);
  assert.equal(f.authCalls, 0);
  assert.deepEqual(f.calls, []);
});

for (const stage of ["init", "put", "ingest", "poll"]) {
  test(`${stage} durable-intent failure prevents its dispatch`, async () => {
    const f = fixture({
      rejectSave: ({ record }) => record.inFlight === stage,
    });
    const result = await f.run();
    const expected = ["init", "put", "ingest", "poll"].slice(0,
      ["init", "put", "ingest", "poll"].indexOf(stage));
    assert.equal(result.journalDurable, false);
    assert.deepEqual(stages(f), expected);
    assert.equal(result.actualRequestsThisRun, expected.length);
    assert.equal(result.status, "unknown");
  });
}

test("acknowledged INIT followed by journal failure is UNKNOWN and cannot upload", async () => {
  const f = fixture({
    rejectSave: ({ record, calls }) => calls.length === 1 && record.inFlight === null,
  });
  const result = await f.run();
  assert.equal(result.status, "unknown");
  assert.equal(result.journalDurable, false);
  assert.deepEqual(stages(f), ["init"]);
  assert.equal(f.store.record.inFlight, "init", "last durable intent remains uncertain");
});

test("late successful acknowledgement cannot become confirmed after deadline", async () => {
  const f = fixture({ init: () => { f.setNow(EPOCH + 600000); return complete(); } });
  assertStopped(await f.run(), f, ["init"]);
});

test("deadline expires before queued dispatch: durable attempt but zero HTTP calls", async () => {
  const f = fixture();
  let waits = 0;
  const clock = {
    now: f.clock.now,
    async wait(promise) {
      if (++waits === 2) f.setNow(EPOCH + 600000);
      return await promise;
    },
  };
  const result = await f.run({ clock });
  assertStopped(result, f, []);
  assert.equal(result.counts.init, 1);
});

for (const phase of ["prepared", "init", "upload", "ingest", "poll"]) {
  test(`existing ${phase} record without observation handle never restarts INIT`, async () => {
    const f = fixture({
      record: retainedState({
        phase, operation: {}, outcome: phase === "prepared" ? "ready" : "unknown",
        inFlight: phase === "init" ? "init" : null,
      }),
    });
    const result = await f.run();
    assertStopped(result, f, []);
    assert.equal(result.reason, "reconciliation_required");
    assert.equal(f.authCalls, 0);
  });
}

test("retained uncertain poll handle resumes observation only", async () => {
  const f = fixture({
    record: retainedState({ outcome: "unknown", inFlight: "poll",
      counts: { init: 1, put: 0, ingest: 0, poll: 1 } }),
  });
  const result = await f.run();
  assert.equal(result.status, "complete_pending_postcheck");
  assert.deepEqual(stages(f), ["poll"]);
  assert.deepEqual(JSON.parse(f.calls[0].body), {
    action: "poll", current_bookmark: "synthetic-retained-bookmark",
  });
  assert.equal(result.counts.poll, 2);
});

test("poll budget survives lost acknowledgement and multiple restarts", async () => {
  let firstRun = true;
  const f = fixture({
    init: () => active("synthetic-retained-bookmark"),
    poll: (_request, count) => {
      if (firstRun && count === 5) throw new Error("synthetic process boundary after dispatch");
      return active("synthetic-retained-bookmark");
    },
  });
  const first = await f.run();
  assert.equal(first.status, "unknown");
  assert.equal(first.counts.poll, 5);
  assert.equal(first.actualRequestsThisRun, 6);
  firstRun = false;
  const second = await f.run();
  assert.equal(second.status, "unknown");
  assert.equal(second.counts.poll, 12);
  assert.equal(second.actualRequestsThisRun, 7);
  const third = await f.run();
  assert.equal(third.status, "unknown");
  assert.equal(third.counts.poll, 12);
  assert.equal(third.actualRequestsThisRun, 0);
  assert.equal(f.calls.filter(call => call.stage === "init").length, 1);
  assert.equal(f.calls.filter(call => call.stage === "poll").length, 12);
});

for (const [key, value] of [
  ["account", "0".repeat(32)],
  ["database", "00000000-0000-0000-0000-000000000099"],
  ["expectedSHA", "0".repeat(64)],
  ["expectedBytes", 13968],
]) {
  test(`input ${key} mismatch refuses before authorization or dispatch`, async () => {
    const f = fixture();
    const result = await f.run({ input: { ...FILE_IMPORT_TARGET, [key]: value } });
    assert.equal(result.status, "refused");
    assert.deepEqual(f.calls, []);
    assert.equal(f.saves.length, 0);
    assert.equal(f.authCalls, 0);
  });
}

for (const [key, value] of [
  ["accountId", "0".repeat(32)],
  ["databaseId", "00000000-0000-0000-0000-000000000099"],
  ["sqlSha256", "0".repeat(64)],
  ["executionId", "00000000-0000-0000-0000-000000000099"],
]) {
  test(`retained ${key} mismatch cannot authorize any request`, async () => {
    const record = retainedState();
    record.binding[key] = value;
    const f = fixture({ record });
    const result = await f.run();
    assert.equal(result.status, "refused");
    assert.equal(result.reason, "state_refused");
    assert.deepEqual(f.calls, []);
    assert.equal(f.saves.length, 0);
    assert.equal(f.authCalls, 0);
  });
}

for (const destination of [
  "http://file-upload.synthetic.invalid/object",
  "file:///C:/synthetic-only.sql",
  "https://other.synthetic.invalid/object",
  "https://user:password@file-upload.synthetic.invalid/object",
  `${ORIGIN}/object#fragment`,
]) {
  test(`unapproved upload destination ${new URL(destination).protocol} cannot receive PUT`, async () => {
    const f = fixture({
      init: () => api({ upload_url: destination, filename: "synthetic-approved.sql" }),
    });
    assertStopped(await f.run(), f, ["init"]);
  });
}

for (const stage of ["init", "put", "ingest", "poll"]) {
  test(`${stage} redirect response stops without following Location`, async () => {
    const f = fixture({
      [stage]: () => ({
        status: 307, headers: { location: "https://other.synthetic.invalid/steal" },
        body: { success: true, result: { status: "complete", success: true,
          result: { final_bookmark: "synthetic-final-bookmark" } } },
      }),
    });
    assertStopped(await f.run(), f, ["init", "put", "ingest", "poll"].slice(0,
      ["init", "put", "ingest", "poll"].indexOf(stage) + 1));
    assert.ok(f.calls.every(call => call.redirect === "error"));
  });
}

for (const [label, response] of [
  ["top-level API failure", { status: 200, body: { success: false, result: {
    status: "complete", success: true, result: { final_bookmark: "synthetic-final-bookmark" },
  } } }],
  ["unconfirmed completion", api({ status: "complete", success: false,
    result: { final_bookmark: "synthetic-final-bookmark" } })],
  ["completion without final bookmark", api({ status: "complete", success: true, result: {} })],
  ["active without bookmark", api({ status: "active", success: true })],
  ["error without success flag", api({ status: "error" })],
  ["contradictory error success=true", api({ status: "error", success: true })],
]) {
  test(`${label} remains UNKNOWN rather than falsely confirming a terminal outcome`, async () => {
    const f = fixture({ init: () => response });
    assertStopped(await f.run(), f, ["init"]);
  });
}

test("explicit server error success=false is terminal failure, never rollback or resubmission", async () => {
  const f = fixture({ init: () => api({ status: "error", success: false }) });
  const first = await f.run();
  assert.equal(first.status, "failed");
  assert.equal(first.reason, "authoritative_failure");
  assert.deepEqual(stages(f), ["init"]);
  const second = await f.run();
  assert.equal(second.status, "failed");
  assert.equal(second.actualRequestsThisRun, 0);
  assert.equal(f.authCalls, 1);
});

test("protected-store handoff preserves consumed poll budget and permits observation only", async t => {
  assert.equal(process.platform, "win32", "protected-store integration requires Windows DPAPI");
  const root = await mkdtemp(path.join(os.tmpdir(), "file-import-handoff-"));
  const directory = path.join(root, "operation");
  const binding = {
    accountId: FILE_IMPORT_TARGET.account, databaseId: FILE_IMPORT_TARGET.database,
    sqlSha256: SHA, executionId: EXECUTION,
  };
  let session, firstRun = true;
  t.after(async () => {
    try { await session?.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  const requests = [];
  const transport = {
    synthetic: true, noRetries: true, noRedirects: true,
    get metrics() { return { dispatched: requests.length }; },
    async request(request) {
      const action = stageOf(request);
      requests.push({ action, ...request });
      assert.equal(request.method, "POST");
      assert.equal(request.url, API_URL);
      assert.equal(request.redirect, "error");
      const durable = await session.load();
      assert.equal(durable.inFlight, action);
      assert.equal(durable.counts[action], requests.filter(item => item.action === action).length);
      if (action === "init") return active("synthetic-retained-bookmark");
      assert.equal(action, "poll", "restart must never upload or ingest");
      assert.deepEqual(JSON.parse(request.body), {
        action: "poll", current_bookmark: "synthetic-retained-bookmark",
      });
      if (firstRun && durable.counts.poll === 5) throw new Error("synthetic lost poll ACK");
      return active("synthetic-retained-bookmark");
    },
  };
  const run = async () => {
    const result = await runFileImport({
      session, transport, input: { ...FILE_IMPORT_TARGET }, uploadOrigin: ORIGIN,
      operationId: EXECUTION,
      authProvider: { id: "synthetic-provider", synthetic: true, getAuthorization: async () => AUTHORIZATION },
      approval: callerApproval(),
      clock: { now: () => EPOCH, wait: async promise => await promise },
    });
    assert.equal(result.status, "unknown");
    assert.equal(result.journalDurable, true);
    assert.equal(result.postverified, false);
    assert.equal(result.rollbackClaimed, false);
    assert.equal(result.serverCancellationClaimed, false);
    assert.ok(!JSON.stringify(result).includes("synthetic-retained-bookmark"));
    return result;
  };

  session = await openStateStore({ directory, binding, mode: "create" });
  const first = await run();
  assert.equal(first.counts.poll, 5);
  assert.equal(first.actualRequestsThisRun, 6);

  firstRun = false;
  session = await openStateStore({ directory, binding, mode: "resume" });
  const retained = await session.load();
  assert.equal(retained.counts.poll, 5);
  assert.equal(retained.inFlight, "poll");
  assert.equal(retained.outcome, "unknown");
  assert.equal(retained.operation.atBookmark, "synthetic-retained-bookmark");
  const second = await run();
  assert.equal(second.counts.poll, 12);
  assert.equal(second.actualRequestsThisRun, 7);

  session = await openStateStore({ directory, binding, mode: "resume" });
  assert.equal((await session.load()).counts.poll, 12);
  const third = await run();
  assert.equal(third.counts.poll, 12);
  assert.equal(third.actualRequestsThisRun, 0);
  assert.equal(requests.filter(item => item.action === "init").length, 1);
  assert.equal(requests.filter(item => item.action === "poll").length, 12);
  assert.equal(requests.length, 13);
});

test("provider receives frozen purpose, binding and caller approval ID, with scoped signal", async () => {
  const f = fixture({
    authorize(context) {
      assert.deepEqual(Object.keys(context).sort(), ["approvalId", "binding", "purpose", "signal"]);
      assert.equal(context.purpose, "d1-file-import");
      assert.equal(context.approvalId, "synthetic-caller-approval");
      assert.deepEqual(context.binding, callerApproval().binding);
      assert.equal(Object.isFrozen(context), true);
      assert.equal(Object.isFrozen(context.binding), true);
      assert.equal(context.signal.aborted, false);
      return AUTHORIZATION;
    },
  });
  assert.equal((await f.run()).status, "complete_pending_postcheck");
  assert.equal(f.contexts.length, 1);
  assert.deepEqual(f.waits, [600000, 30000, 30000, 30000, 30000]);
  for (const call of f.calls) {
    assert.equal(call.deadlineAt, EPOCH + 30000);
    assert.notEqual(call.signal, f.contexts[0].signal);
  }
  assert.equal(new Set(f.calls.map(call => call.signal)).size, 4);
});

for (const [label, change] of [
  ["missing approval", () => undefined],
  ["provider callback posing as approval", () => () => callerApproval()],
  ["wrong provider ID", value => ({ ...value, providerId: "different-provider" })],
  ["wrong purpose", value => ({ ...value, purpose: "other-purpose" })],
  ["wrong scope", value => ({ ...value, scope: "live" })],
  ["expired approval", value => ({ ...value, expiresAt: EPOCH })],
  ["missing approval ID", value => ({ ...value, id: "" })],
  ["control in approval ID", value => ({ ...value, id: "synthetic\napproval" })],
  ["missing evidence reference", value => ({ ...value, permissionEvidenceRef: "" })],
  ["noncanonical binding", value => ({ ...value, binding: { ...value.binding, extra: "invalid" } })],
  ...["accountId", "databaseId", "sqlSha256", "executionId"].map(key => [
    `wrong approved ${key}`, value => ({ ...value, binding: { ...value.binding, [key]: "wrong" } }),
  ]),
]) {
  test(`${label} refuses before provider and HTTP dispatch`, async () => {
    const f = fixture();
    const result = await f.run({ approval: change(callerApproval()) });
    assert.equal(result.status, "refused");
    assert.equal(f.authCalls, 0);
    assert.equal(f.saves.length, 0);
    assert.equal(result.actualRequestsThisRun, 0);
    assert.deepEqual(f.calls, []);
  });
}

for (const [label, value] of [
  ["empty", ""], ["empty bearer", "Bearer "], ["space", "Bearer two tokens"],
  ["tab", "Bearer token\t"], ["CRLF", "Bearer token\r\n"], ["NUL", "Bearer token\0"],
  ["DEL", "Bearer token\x7f"],
  ["provider self-approval object", { approved: true, authorization: AUTHORIZATION }],
]) {
  test(`${label} provider result cannot authorize an HTTP request`, async () => {
    const f = fixture({ authorize: () => value });
    const result = await f.run();
    assert.equal(result.status, "unknown");
    assert.equal(f.authCalls, 1);
    assert.equal(result.actualRequestsThisRun, 0);
    assert.equal(f.store.record.counts.init, 0);
    assert.deepEqual(f.calls, []);
  });
}

test("provider rejection is redacted and its signal aborted before returning UNKNOWN", async () => {
  const f = fixture({ authorize: () => { throw new Error(PRIVATE_URL); } });
  assertStopped(await f.run(), f, []);
  assert.equal(f.contexts[0].signal.aborted, true);
});

test("provider timeout aborts even when callback never settles and starts no HTTP", async () => {
  const f = fixture({ authorize: () => new Promise(() => {}) });
  const clock = {
    now: f.clock.now,
    async wait(promise) {
      await Promise.resolve();
      assert.equal(f.contexts.length, 1);
      assert.equal(f.contexts[0].signal.aborted, false);
      throw new Error("synthetic provider timeout");
    },
  };
  assertStopped(await f.run({ clock }), f, []);
  assert.equal(f.contexts[0].signal.aborted, true);
});

test("provider result arriving at approval expiry is unusable", async () => {
  const approved = callerApproval({ expiresAt: EPOCH + 1000 });
  const f = fixture({ authorize: () => { f.setNow(approved.expiresAt); return AUTHORIZATION; } });
  assertStopped(await f.run({ approval: approved }), f, []);
});

test("caller binding mutation cannot replace the pinned provider context or dispatch target", async () => {
  const approved = callerApproval();
  const f = fixture({
    authorize: () => {
      approved.binding.executionId = "00000000-0000-0000-0000-000000000099";
      return AUTHORIZATION;
    },
  });
  assert.equal((await f.run({ approval: approved })).status, "complete_pending_postcheck");
  assert.deepEqual(f.contexts[0].binding, callerApproval().binding);
  assert.equal(f.contexts[0].approvalId, "synthetic-caller-approval");
  assert.equal(f.calls[0].url, API_URL);
  assert.equal(f.store.record.binding.executionId, EXECUTION);
});

test("approval expiring after durable intent prevents dispatch without refunding INIT", async () => {
  const approved = callerApproval({ expiresAt: EPOCH + 1000 });
  const f = fixture({
    rejectSave: ({ record }) => {
      if (record.inFlight === "init") f.setNow(approved.expiresAt);
      return false;
    },
  });
  const result = await f.run({ approval: approved });
  assertStopped(result, f, []);
  assert.equal(result.counts.init, 1);
  assert.equal(f.store.record.counts.init, 1);
});

test("approval expiring before queued HTTP callback prevents every dispatch", async () => {
  const f = fixture(), approved = callerApproval({ expiresAt: EPOCH + 1000 });
  let waits = 0;
  const clock = {
    now: f.clock.now,
    async wait(promise) {
      if (++waits === 2) f.setNow(approved.expiresAt);
      return await promise;
    },
  };
  const result = await f.run({ approval: approved, clock });
  assertStopped(result, f, []);
  assert.equal(result.counts.init, 1);
});

test("approval expiry in flight aborts client observation, never claiming server cancellation", async () => {
  const approved = callerApproval({ expiresAt: EPOCH + 1000 });
  const f = fixture({
    init: request => {
      assert.equal(request.deadlineAt, approved.expiresAt);
      assert.equal(request.signal.aborted, false);
      f.setNow(approved.expiresAt);
      return complete();
    },
  });
  assertStopped(await f.run({ approval: approved }), f, ["init"]);
  assert.equal(f.calls[0].signal.aborted, true);
  assert.deepEqual(f.waits, [1000, 1000]);
});

test("per-request deadline cannot accept a late ACK within a longer approval window", async () => {
  const f = fixture({
    init: request => {
      assert.equal(request.deadlineAt, EPOCH + 30000);
      f.setNow(request.deadlineAt);
      return complete();
    },
  });
  assertStopped(await f.run(), f, ["init"]);
});

test("persisted observation deadline wins over approval expiry and request cap on resume", async () => {
  const f = fixture({
    record: retainedState({ startedAt: EPOCH - 591000, deadlineAt: EPOCH + 9000 }),
    poll: request => {
      assert.equal(request.deadlineAt, EPOCH + 9000);
      return complete();
    },
  });
  assert.equal((await f.run({ approval: callerApproval({ expiresAt: EPOCH + 20000 }) })).status,
    "complete_pending_postcheck");
  assert.deepEqual(stages(f), ["poll"]);
  assert.deepEqual(f.waits, [9000, 9000]);
});

test("adapter pre-dispatch expiry reports zero actual requests while retaining durable INIT intent", async () => {
  const f = fixture();
  let invocations = 0, destroyed = false;
  const transport = createD1FileHttpsTransport({
    uploadOrigin: ORIGIN,
    clock: { now: f.clock.now, setTimeout: () => 1, clearTimeout() {} },
    createAgent() {
      f.setNow(EPOCH + 30000);
      return { destroy() { destroyed = true; } };
    },
    requestImpl() { invocations++; throw new Error("must not be invoked"); },
  });
  const result = await f.run({ transport });
  assert.equal(result.status, "unknown");
  assert.equal(result.counts.init, 1);
  assert.equal(f.store.record.counts.init, 1);
  assert.equal(transport.metrics.dispatched, 0);
  assert.equal(invocations, 0);
  assert.equal(destroyed, true);
  assert.equal(result.actualRequestsThisRun, 0, "actual dispatch accounting excludes adapter refusal");
  assert.equal(result.transportInvocationsThisRun, 1);
});

for (const kind of ["missing", "invalid", "throwing", "regressed"]) {
  test(`${kind} adapter metrics report unknown dispatch count, never an outer-call estimate`, async () => {
    const f = fixture();
    const transport = {
      synthetic: true, noRetries: true, noRedirects: true, request: f.transport.request,
    };
    if (kind !== "missing") {
      Object.defineProperty(transport, "metrics", {
        get() {
          if (kind === "throwing") throw new Error(PRIVATE_URL);
          return { dispatched: kind === "invalid" ? 0.5 : f.calls.length ? 99 : 100 };
        },
      });
    }
    const result = await f.run({ transport });
    assert.equal(result.status, "complete_pending_postcheck");
    assert.equal(result.actualRequestsThisRun, null);
    assert.equal(result.transportInvocationsThisRun, 4);
    assert.equal(f.calls.length, 4);
  });
}

test("R5 provider cannot extend original caller expiry to authorize later dispatch", async () => {
  const originalExpiry = EPOCH + 1000;
  const approved = callerApproval({ expiresAt: originalExpiry });
  const afterExpiry = [];
  const f = fixture({
    authorize: async () => {
      approved.expiresAt = EPOCH + 600000;
      await Promise.resolve();
      return AUTHORIZATION;
    },
    init: () => {
      f.setNow(originalExpiry);
      return active("synthetic-retained-bookmark");
    },
    poll: request => { afterExpiry.push(request); return complete(); },
  });
  const result = await f.run({ approval: approved });
  assert.deepEqual({
    status: result.status, dispatched: stages(f), newDispatchesAfterExpiry: afterExpiry.length,
  }, {
    status: "unknown", dispatched: ["init"], newDispatchesAfterExpiry: 0,
  });
  assert.equal(result.counts.poll, 0);
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(result.serverCancellationClaimed, false);
});

test("attempted mutation of frozen provider-context binding throws and authorizes no HTTP", async () => {
  let mutationError;
  const f = fixture({
    authorize(context) {
      try { context.binding.executionId = "00000000-0000-0000-0000-000000000099"; }
      catch (error) { mutationError = error; throw error; }
      return AUTHORIZATION;
    },
  });
  assertStopped(await f.run(), f, []);
  assert.ok(mutationError instanceof TypeError);
  assert.deepEqual(f.contexts[0].binding, callerApproval().binding);
});

test("approval fields and provider selection are pinned before the first asynchronous boundary", async () => {
  const approved = callerApproval();
  const f = fixture();
  let substitutedProviderCalls = 0;
  const result = await f.run({
    approval: approved,
    afterPin() {
      Object.assign(approved, {
        id: "substituted-approval", providerId: "substituted-provider", purpose: "other-purpose",
        scope: "live", expiresAt: EPOCH, permissionEvidenceRef: "",
      });
      Object.assign(approved.binding, {
        accountId: "wrong", databaseId: "wrong", sqlSha256: "wrong", executionId: "wrong",
      });
      Object.assign(f.authProvider, {
        id: "substituted-provider", synthetic: false,
        getAuthorization() { substitutedProviderCalls++; return "Bearer SUBSTITUTED"; },
      });
    },
  });
  assert.equal(result.status, "complete_pending_postcheck");
  assert.equal(f.authCalls, 1);
  assert.equal(substitutedProviderCalls, 0);
  assert.equal(f.contexts[0].approvalId, "synthetic-caller-approval");
  assert.equal(f.contexts[0].purpose, "d1-file-import");
  assert.deepEqual(f.contexts[0].binding, callerApproval().binding);
  assert.equal(f.calls[0].url, API_URL);
  assert.equal(f.calls[0].headers.Authorization, AUTHORIZATION);
  assert.ok(f.calls.every(call => call.deadlineAt === EPOCH + 30000));
});
