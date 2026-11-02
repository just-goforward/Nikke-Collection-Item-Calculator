import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import * as httpsExports from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import fsPromises, * as fsPromisesExports from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createD1DatabaseReadTransport, createD1FileHttpsTransport } from "./d1-file-import-https.mjs";
import { createD1ReadJournal, runD1DatabaseReadCheck } from "./d1-db-read-check.mjs";

const PURPOSE = "fixed-d1-db-info-read";
const ACCOUNT = "1".repeat(32);
const DATABASE = "3e18385a-af83-4c67-83a0-ab889149692c";
const NAME = "collection-kit-stats";
const EPOCH = 1800000000000;
const AUTH = "Bearer SYNTHETIC_READ_ONLY";
const PRIVATE = "PRIVATE_DIAGNOSTIC_TOKEN_DO_NOT_LOG";
const READ_PATH = `/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}?fields=uuid,name`;
const READ_URL = `https://api.cloudflare.com${READ_PATH}`;
const FILE_API = "https://api.cloudflare.com/client/v4/accounts/15be33fd20ea78eb3d60b719be831148/d1/database/3e18385a-af83-4c67-83a0-ab889149692c/import";

function approved(overrides = {}) {
  return {
    id: "synthetic-read-approval", purpose: PURPOSE, accountId: ACCOUNT, databaseId: DATABASE,
    expectedName: NAME, providerRef: "synthetic-provider-reference",
    credentialApprovalRef: "synthetic-credential-approval", readApprovalRef: "synthetic-read-permission",
    expiresAt: EPOCH + 600000, maxRequests: 1, ...overrides,
  };
}
const success = () => ({ success: true, result: { uuid: DATABASE, name: NAME } });
const counts = (reserved = 0, adapterInvoked = 0, dispatched = 0, confirmedResponse = 0) =>
  ({ reserved, adapterInvoked, dispatched, confirmedResponse });

function fakeClock() {
  let now = EPOCH, next = 0;
  const pending = new Map();
  return {
    pending,
    now: () => now,
    setTimeout(callback, ms) { const id = ++next; pending.set(id, { at: now + ms, callback }); return id; },
    clearTimeout(id) { pending.delete(id); },
    setNow(value) { now = value; },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...pending]) {
        if (timer.at <= now) { pending.delete(id); timer.callback(); }
      }
    },
  };
}

class Resource extends EventEmitter {
  destroyed = false;
  destroy() { this.destroyed = true; }
}

function wireFixture(t, options = {}) {
  const clock = fakeClock(), requests = [], agents = [], responses = [];
  const requestMock = t.mock.method(https, "request", function(url, config, onResponse) {
    const request = new Resource();
    request.end = payload => {
      request.payload = payload;
      queueMicrotask(() => {
        if (options.errorCode) {
          request.emit("error", Object.assign(new Error(PRIVATE), { code: options.errorCode }));
          return;
        }
        const response = new Resource();
        response.statusCode = options.status ?? 200;
        response.rawHeaders = options.rawHeaders ?? [];
        response.complete = options.complete ?? true;
        responses.push(response);
        onResponse(response);
        const chunks = options.chunks ?? [Buffer.from(options.rawBody ??
          JSON.stringify(options.envelope ?? success()))];
        for (const chunk of chunks) response.emit("data", chunk);
        response.emit("end");
      });
    };
    requests.push({ url, config, request });
    return request;
  });
  const agentMock = t.mock.method(https, "Agent", function(config) {
    const agent = new Resource();
    agents.push({ config, agent });
    return agent;
  });
  syncBuiltinESMExports();
  assert.equal(httpsExports.request, requestMock, "factory can only bind the installed request fake");
  assert.equal(httpsExports.Agent, agentMock, "factory can only construct the installed agent fake");
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { clock, requests, agents, responses };
}

function checkerFixture(t, options = {}) {
  const wire = wireFixture(t, options);
  const contexts = [], records = [];
  let closeCalls = 0, providerCalls = 0;
  const approval = approved();
  const provider = {
    id: "synthetic-provider", reference: approval.providerRef, accountId: ACCOUNT, purpose: PURPOSE,
    async getAuthorization(context) {
      providerCalls++;
      contexts.push(context);
      return options.authorize ? await options.authorize(context, wire.clock) : AUTH;
    },
  };
  const journal = {
    async recordIntent(record) {
      if (options.intentFailure) throw new Error(PRIVATE);
      records.push(structuredClone(record));
    },
    async recordResult(record) {
      if (options.resultFailure) throw new Error(PRIVATE);
      records.push(structuredClone(record));
    },
    async close() {
      closeCalls++;
      if (options.closeFailure) throw new Error(PRIVATE);
    },
  };
  async function run(changes = {}) {
    const result = await runD1DatabaseReadCheck({
      approval, authProvider: provider, journal, clock: wire.clock, ...changes,
    });
    assert.equal(result.serverCancellationClaimed, false);
    const serialized = JSON.stringify({ result, records });
    assert.ok(!serialized.includes(AUTH));
    assert.ok(!serialized.includes(PRIVATE));
    return result;
  }
  return {
    ...wire, contexts, records, approval, provider, journal, run,
    get closeCalls() { return closeCalls; },
    get providerCalls() { return providerCalls; },
  };
}

function wireClean(f) {
  assert.equal(f.clock.pending.size, 0);
  for (const { request } of f.requests) assert.equal(request.destroyed, true);
  for (const { agent } of f.agents) assert.equal(agent.destroyed, true);
  for (const response of f.responses) assert.equal(response.destroyed, true);
}

test("unapproved preparation is refused with zero provider or HTTP calls, not an authentic GET pass", async t => {
  const f = checkerFixture(t);
  const result = await f.run({ approval: undefined, authProvider: undefined });
  assert.equal(result.status, "refused");
  assert.deepEqual(result.counts, counts());
  assert.equal(f.providerCalls, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.records.length, 0);
});

for (const missing of ["approval", "authProvider"]) {
  test(`missing ${missing} never searches for credentials or dispatches`, async t => {
    const f = checkerFixture(t);
    assert.equal((await f.run({ [missing]: undefined })).status, "refused");
    assert.equal(f.providerCalls, 0);
    assert.equal(f.requests.length, 0);
  });
}

for (const [key, value] of [
  ["purpose", "d1-file-import"], ["databaseId", "00000000-0000-0000-0000-000000000000"],
  ["expectedName", "other-database"], ["accountId", "not-an-approved-account"],
  ["providerRef", "different-provider"], ["credentialApprovalRef", ""], ["readApprovalRef", ""],
  ["expiresAt", EPOCH], ["maxRequests", 2],
]) {
  test(`unapproved ${key} refuses before reservation and authorization`, async t => {
    const f = checkerFixture(t);
    const result = await f.run({ approval: approved({ [key]: value }) });
    assert.equal(result.status, "refused");
    assert.deepEqual(result.counts, counts());
    assert.equal(f.providerCalls, 0);
    assert.equal(f.requests.length, 0);
    assert.equal(f.records.length, 0);
  });
}

test("offline builtin-stubbed factory sends the one exact approved GET with independent accounting", async t => {
  const f = checkerFixture(t);
  const result = await f.run();
  assert.equal(result.status, "verified", "only the injected synthetic response is verified");
  assert.deepEqual(result.counts, counts(1, 1, 1, 1));
  assert.equal(f.providerCalls, 1);
  assert.equal(f.requests.length, 1);
  const { url, config, request } = f.requests[0];
  assert.equal(url, READ_URL);
  assert.equal(config.method, "GET");
  assert.deepEqual({ ...config.headers }, { authorization: AUTH });
  assert.equal(request.payload, undefined);
  assert.equal(config.rejectUnauthorized, true);
  assert.equal(config.insecureHTTPParser, false);
  assert.equal(config.maxHeaderSize, 16384);
  assert.deepEqual(f.agents[0].config, {
    keepAlive: false, rejectUnauthorized: true, proxyEnv: {}, maxCachedSessions: 0,
  });
  assert.equal(f.contexts[0].deadlineAt, EPOCH + 30000);
  assert.deepEqual(f.records.map(record => record.status), ["intent", "verified"]);
  assert.deepEqual(f.records[0].counts, counts(1));
  assert.deepEqual(f.records[1].counts, counts(1, 1, 1, 1));
  wireClean(f);
});

for (const [key, value] of [
  ["accountId", "2".repeat(32)], ["reference", "other-provider-reference"], ["purpose", "d1-file-import"],
]) {
  test(`provider ${key} must match the caller's fixed read approval`, async t => {
    const f = checkerFixture(t);
    f.provider[key] = value;
    assert.equal((await f.run()).status, "refused");
    assert.equal(f.providerCalls, 0);
    assert.equal(f.requests.length, 0);
    assert.equal(f.records.length, 0);
  });
}

test("caller decision and provider selection are pinned before journal awaits", async t => {
  const f = checkerFixture(t);
  let replacementCalls = 0;
  const recordIntent = f.journal.recordIntent;
  f.journal.recordIntent = async record => {
    Object.assign(f.approval, {
      accountId: "2".repeat(32), databaseId: "wrong", expectedName: "wrong",
      id: "replacement-approval", purpose: "other", providerRef: "replacement",
      credentialApprovalRef: "", readApprovalRef: "", expiresAt: EPOCH, maxRequests: 9,
    });
    Object.assign(f.provider, {
      id: "replacement", reference: "replacement", purpose: "other", accountId: "2".repeat(32),
      getAuthorization() { replacementCalls++; return "Bearer REPLACEMENT"; },
    });
    await recordIntent(record);
  };
  const result = await f.run();
  assert.equal(result.status, "verified");
  assert.equal(replacementCalls, 0);
  assert.equal(f.providerCalls, 1);
  assert.equal(f.requests[0].url, READ_URL);
  assert.equal(f.requests[0].config.headers.authorization, AUTH);
  assert.ok(f.records.every(record => record.approvalId === "synthetic-read-approval"));
});

test("read transport is live-marked, fixed-purpose, single-use and not a generic URL or FILE adapter", async t => {
  const f = wireFixture(t), controller = new AbortController();
  const transport = createD1DatabaseReadTransport({ approval: approved(), clock: f.clock });
  assert.equal(transport.synthetic, false);
  assert.equal(transport.purpose, PURPOSE);
  const input = { authorization: AUTH, deadlineAt: EPOCH + 1000, signal: controller.signal };
  await transport.request(input);
  await assert.rejects(transport.request(input), /D1_HTTPS_POLICY/);
  assert.equal(f.requests.length, 1);
  assert.equal(transport.metrics.dispatched, 1);
  assert.equal(transport.metrics.confirmedResponse, 1);
  const genericAttempt = createD1DatabaseReadTransport({ approval: approved(), clock: f.clock });
  await assert.rejects(genericAttempt.request({ ...input, url: `${READ_URL}/other`, method: "POST" }), /D1_HTTPS_POLICY/);
  assert.equal(f.requests.length, 1);
  wireClean(f);
});

for (const [status, expected] of [[401, "unauthorized_401"], [403, "forbidden_403"]]) {
  test(`GET ${status} is confirmed without parsing private error content or retrying`, async t => {
    const f = checkerFixture(t, { status, rawBody: PRIVATE });
    const result = await f.run();
    assert.equal(result.status, expected);
    assert.deepEqual(result.counts, counts(1, 1, 1, 1));
    assert.equal(f.requests.length, 1);
    wireClean(f);
  });
}

for (const [label, envelope] of [
  ["UUID", { success: true, result: { uuid: "wrong", name: NAME } }],
  ["name", { success: true, result: { uuid: DATABASE, name: "wrong" } }],
  ["provider success", { success: false, result: { uuid: DATABASE, name: NAME } }],
]) {
  test(`confirmed response with mismatched ${label} cannot verify the database`, async t => {
    const f = checkerFixture(t, { envelope });
    const result = await f.run();
    assert.equal(result.status, "target_mismatch");
    assert.deepEqual(result.counts, counts(1, 1, 1, 1));
    assert.equal(f.requests.length, 1);
  });
}

for (const errorCode of ["ENOTFOUND", "ERR_TLS_CERT_ALTNAME_INVALID"]) {
  test(`offline ${errorCode} maps to sanitized TLS/connect failure with no fallback`, async t => {
    const f = checkerFixture(t, { errorCode });
    const result = await f.run();
    assert.equal(result.status, "tls_connect_failure");
    assert.deepEqual(result.counts, counts(1, 1, 1, 0));
    assert.equal(f.requests.length, 1);
    wireClean(f);
  });
}

for (const [label, options] of [
  ["header overflow", { errorCode: "HPE_HEADER_OVERFLOW" }],
  ["raw header limit", { rawHeaders: ["x", "a".repeat(16384)] }],
  ["incremental body limit", { chunks: [Buffer.alloc(65536, 32), Buffer.from(" ")] }],
]) {
  test(`GET ${label} preserves limit classification and consumes no second attempt`, async t => {
    const f = checkerFixture(t, options);
    const result = await f.run();
    assert.equal(result.status, "limit_exceeded");
    assert.deepEqual(result.counts, counts(1, 1, 1, 0));
    assert.equal(f.requests.length, 1);
    wireClean(f);
  });
}

for (const [label, options] of [
  ["malformed JSON", { rawBody: "{" }],
  ["truncated response", { complete: false }],
  ["redirect", { status: 307, rawHeaders: ["Location", "https://other.synthetic.invalid/private"] }],
  ["connection reset after invocation", { errorCode: "ECONNRESET" }],
]) {
  test(`${label} remains UNKNOWN after dispatch and never resends`, async t => {
    const f = checkerFixture(t, options);
    const result = await f.run();
    assert.equal(result.status, "unknown_after_dispatch");
    assert.deepEqual(result.counts, counts(1, 1, 1, 0));
    assert.equal(f.requests.length, 1);
    wireClean(f);
  });
}

for (const [label, value] of [["empty", ""], ["empty bearer", "Bearer "], ["control", "Bearer token\r\n"]]) {
  test(`${label} credential result cannot trigger an HTTP dispatch`, async t => {
    const f = checkerFixture(t, { authorize: () => value });
    const result = await f.run();
    assert.equal(result.status, "failed_before_dispatch");
    assert.deepEqual(result.counts, counts(1));
    assert.equal(f.requests.length, 0);
  });
}

test("late authorization cannot start GET after the pinned original deadline", async t => {
  const f = checkerFixture(t, {
    authorize: async (_context, clock) => {
      f.approval.expiresAt = EPOCH + 600000;
      clock.setNow(EPOCH + 1000);
      await Promise.resolve();
      return AUTH;
    },
  });
  f.approval.expiresAt = EPOCH + 1000;
  const result = await f.run();
  assert.equal(result.status, "failed_before_dispatch");
  assert.deepEqual(result.counts, counts(1));
  assert.equal(f.requests.length, 0);
  assert.equal(f.clock.pending.size, 0);
});

test("authorization timeout aborts the provider without dispatching or claiming server cancellation", async t => {
  let entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const f = checkerFixture(t, {
    authorize: context => { entered(context); return new Promise(() => {}); },
  });
  const pending = f.run();
  const context = await reached;
  assert.equal(context.signal.aborted, false);
  f.clock.advance(30000);
  const result = await pending;
  assert.equal(result.status, "authorization_timeout");
  assert.equal(context.signal.aborted, true);
  assert.deepEqual(result.counts, counts(1));
  assert.equal(f.requests.length, 0);
});

test("provider success closes authorization scope and optional journal after the result", async t => {
  const f = checkerFixture(t);
  assert.equal((await f.run()).status, "verified");
  assert.deepEqual({
    providerAborted: f.contexts[0].signal.aborted, journalClosed: f.closeCalls,
    pendingTimers: f.clock.pending.size,
  }, { providerAborted: true, journalClosed: 1, pendingTimers: 0 });
});

test("provider rejection closes authorization scope and journal without exposing its error", async t => {
  const f = checkerFixture(t, { authorize: () => { throw new Error(PRIVATE); } });
  assert.equal((await f.run()).status, "failed_before_dispatch");
  assert.equal(f.requests.length, 0);
  assert.deepEqual({ providerAborted: f.contexts[0].signal.aborted, journalClosed: f.closeCalls },
    { providerAborted: true, journalClosed: 1 });
});

test("pre-dispatch journal failure closes the journal, reserves once and sends nothing", async t => {
  const f = checkerFixture(t, { intentFailure: true });
  const result = await f.run();
  assert.equal(result.status, "journal_failure");
  assert.deepEqual(result.counts, counts(1));
  assert.equal(f.providerCalls, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.closeCalls, 1);
});

test("post-dispatch journal failure preserves UNKNOWN observation and closes without resending", async t => {
  const f = checkerFixture(t, { resultFailure: true });
  const result = await f.run();
  assert.equal(result.status, "journal_failure");
  assert.equal(result.observation, "unknown_after_dispatch");
  assert.deepEqual(result.counts, counts(1, 1, 1, 1));
  assert.equal(f.requests.length, 1);
  assert.equal(f.closeCalls, 1);
});

for (const kind of ["missing", "nonnumeric", "throwing"]) {
  test(`${kind} transport metrics fail closed before authorization rather than inventing zero dispatches`, async t => {
    const f = checkerFixture(t);
    let invocations = 0;
    const transport = {
      purpose: PURPOSE, synthetic: true, noRetries: true, noRedirects: true,
      async request() { invocations++; return { status: 200, body: success() }; },
    };
    if (kind !== "missing") Object.defineProperty(transport, "metrics", {
      get() {
        if (kind === "throwing") throw new Error(PRIVATE);
        return { dispatched: "zero", confirmedResponse: NaN };
      },
    });
    const result = await f.run({ transport });
    assert.equal(result.status, "refused");
    assert.equal(f.providerCalls, 0);
    assert.equal(invocations, 0);
    assert.equal(f.requests.length, 0);
    assert.equal(f.records.length, 0);
  });
}

test("journal close failure cannot return verified after a confirmed response", async t => {
  const f = checkerFixture(t, { closeFailure: true });
  const result = await f.run();
  assert.equal(result.status, "journal_failure");
  assert.equal(result.observation, "unknown_after_dispatch");
  assert.deepEqual(result.counts, counts(1, 1, 1, 1));
  assert.equal(f.closeCalls, 1);
  assert.equal(f.contexts[0].signal.aborted, true);
  assert.equal(f.requests.length, 1);
  wireClean(f);
});

for (const kind of ["missing", "nonnumeric", "throwing"]) {
  test(`${kind} metrics after invocation remain UNKNOWN without fabricating zero HTTP counts`, async t => {
    const f = checkerFixture(t);
    let invoked = 0;
    const transport = {
      purpose: PURPOSE, synthetic: true, noRetries: true, noRedirects: true,
      get metrics() {
        if (!invoked) return { dispatched: 0, confirmedResponse: 0 };
        if (kind === "throwing") throw new Error(PRIVATE);
        return kind === "missing" ? undefined : { dispatched: NaN, confirmedResponse: -1 };
      },
      async request() { invoked++; return { status: 200, body: success() }; },
    };
    const result = await f.run({ transport });
    assert.equal(result.status, "unknown_after_dispatch");
    assert.equal(result.counts.reserved, 1);
    assert.equal(result.counts.adapterInvoked, 1);
    assert.equal(result.counts.dispatched, null);
    assert.equal(result.counts.confirmedResponse, null);
    assert.equal(invoked, 1);
    assert.equal(f.providerCalls, 1);
    assert.equal(f.closeCalls, 1);
  });
}

function journalRecord(status, attemptCounts, extra = {}) {
  return {
    approvalId: "synthetic-read-approval", accountId: ACCOUNT, databaseId: DATABASE,
    method: "GET", path: READ_PATH, timestamp: EPOCH, counts: attemptCounts, status, ...extra,
  };
}

async function journalRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "fixed-read-journal-"));
  const journals = [];
  t.after(async () => {
    try { for (const journal of journals) await journal.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  return { root, track(journal) { journals.push(journal); return journal; } };
}

test("fresh journal fsyncs each whitelisted record and refuses an existing or completed attempt", async t => {
  const { root, track } = await journalRoot(t);
  const probe = await open(path.join(root, "probe"), "wx");
  const prototype = Object.getPrototypeOf(probe), originalSync = prototype.sync;
  await probe.close();
  let syncs = 0;
  t.mock.method(prototype, "sync", async function() { syncs++; return originalSync.call(this); });
  const destination = path.join(root, "read.jsonl");
  const journal = track(await createD1ReadJournal({ path: destination }));
  await assert.rejects(createD1ReadJournal({ path: destination }), /D1_READ_JOURNAL/);
  await journal.recordIntent(journalRecord("intent", counts(1)));
  assert.equal(syncs, 1);
  await journal.recordResult(journalRecord("verified", counts(1, 1, 1, 1), { verifiedName: NAME }));
  assert.equal(syncs, 2);
  const rows = (await readFile(destination, "utf8")).trim().split("\n").map(row => JSON.parse(row));
  assert.deepEqual(rows, [
    journalRecord("intent", counts(1)),
    journalRecord("verified", counts(1, 1, 1, 1), { verifiedName: NAME }),
  ]);
  await assert.rejects(journal.recordIntent(journalRecord("intent", counts(1))), /D1_READ_JOURNAL/);
  await assert.rejects(createD1ReadJournal({ path: destination }), /D1_READ_JOURNAL/);
});

test("journal rejects secrets, unknown metadata and result binding substitution before append", async t => {
  const { root, track } = await journalRoot(t), destination = path.join(root, "read.jsonl");
  const journal = track(await createD1ReadJournal({ path: destination }));
  for (const field of ["authorization", "rawError", "upload_url", "importReservation"]) {
    await assert.rejects(journal.recordIntent(journalRecord("intent", counts(1), { [field]: PRIVATE })),
      /D1_READ_JOURNAL/);
  }
  await journal.recordIntent(journalRecord("intent", counts(1)));
  await assert.rejects(journal.recordResult(journalRecord("failed_before_dispatch", counts(1), {
    approvalId: "substituted-approval",
  })), /D1_READ_JOURNAL/);
  await journal.recordResult(journalRecord("failed_before_dispatch", counts(1)));
  const text = await readFile(destination, "utf8");
  assert.ok(!text.includes(PRIVATE));
  assert.ok(!text.includes("substituted-approval"));
  assert.equal(text.trim().split("\n").length, 2);
});

test("journal fsync failure closes its file and cannot become a reusable fresh attempt", async t => {
  const { root, track } = await journalRoot(t), destination = path.join(root, "read.jsonl");
  const probe = await open(path.join(root, "probe"), "wx");
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  let closes = 0;
  t.mock.method(prototype, "sync", async () => { throw new Error(PRIVATE); });
  const originalOpen = fsPromises.open;
  const openMock = t.mock.method(fsPromises, "open", async (...args) => {
    const handle = await originalOpen(...args), originalClose = handle.close;
    t.mock.method(handle, "close", async () => { closes++; return originalClose.call(handle); });
    return handle;
  });
  syncBuiltinESMExports();
  assert.equal(fsPromisesExports.open, openMock);
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const journal = track(await createD1ReadJournal({ path: destination }));
  await assert.rejects(journal.recordIntent(journalRecord("intent", counts(1))), /D1_READ_JOURNAL/);
  assert.equal(closes, 1);
  await assert.rejects(createD1ReadJournal({ path: destination }), /D1_READ_JOURNAL/);
});

function fileTransport(f) {
  return createD1FileHttpsTransport({
    requestImpl: https.request, createAgent: options => new https.Agent(options),
    uploadOrigin: "https://upload.synthetic.invalid", clock: f.clock,
  });
}
function fileInput(changes = {}) {
  return {
    method: "POST", url: FILE_API, headers: { Authorization: AUTH, "Content-Type": "application/json" },
    body: '{"action":"init"}', redirect: "error", deadlineAt: EPOCH + 30000, ...changes,
  };
}

test("shared route change leaves FILE POST JSON and PUT byte/header separation intact", async t => {
  const f = wireFixture(t, { rawHeaders: ["ETag", '"synthetic-etag"'] });
  const transport = fileTransport(f);
  assert.deepEqual((await transport.request(fileInput())).body, success());
  const bytes = Buffer.from([0, 255, 13, 10]);
  const put = await transport.request(fileInput({
    method: "PUT", url: "https://upload.synthetic.invalid/object?signature=synthetic",
    body: bytes, headers: { "Content-Length": "4" },
  }));
  assert.deepEqual(put, { status: 200, headers: { etag: '"synthetic-etag"' } });
  assert.equal(f.requests[0].request.payload.toString(), '{"action":"init"}');
  assert.equal(f.requests[1].request.payload, bytes);
  assert.deepEqual({ ...f.requests[1].config.headers }, { "content-length": "4" });
  wireClean(f);
});

test("new GET permission cannot widen the FILE factory route policy", async t => {
  const f = wireFixture(t), transport = fileTransport(f);
  await assert.rejects(transport.request(fileInput({
    method: "GET", url: READ_URL, headers: { Authorization: AUTH },
  })), /D1_HTTPS_POLICY/);
  assert.equal(f.requests.length, 0);
  assert.equal(transport.metrics.dispatched, 0);
});

test("read-only 401 body allowance does not bypass FILE JSON response validation", async t => {
  const f = wireFixture(t, { status: 401, rawBody: PRIVATE });
  await assert.rejects(fileTransport(f).request(fileInput()), /D1_HTTPS_RESPONSE/);
  assert.equal(f.requests.length, 1);
  wireClean(f);
});

test("read TLS classification does not alter the FILE error contract", async t => {
  const f = wireFixture(t, { errorCode: "ERR_TLS_CERT_ALTNAME_INVALID" });
  await assert.rejects(fileTransport(f).request(fileInput()), /D1_HTTPS_IO/);
  assert.equal(f.requests.length, 1);
  wireClean(f);
});
