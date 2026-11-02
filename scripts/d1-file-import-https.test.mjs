import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import { createD1FileHttpsTransport } from "./d1-file-import-https.mjs";

const API = "https://api.cloudflare.com/client/v4/accounts/15be33fd20ea78eb3d60b719be831148/d1/database/3e18385a-af83-4c67-83a0-ab889149692c/import";
const ORIGIN = "https://upload.synthetic.invalid";
const SIGNED = `${ORIGIN}/a%2Fb?signature=PRIVATE%2FVALUE%2B&part=01`;
const AUTH = "Bearer SYNTHETIC_ONLY";
const EPOCH = 1800000000000;

class Resource extends EventEmitter {
  destroyed = false;
  destroy() { this.destroyed = true; }
  end(payload) { this.payload = payload; }
}

function harness(options = {}) {
  let now = EPOCH, nextTimer = 0;
  const timers = new Map(), requests = [], agents = [];
  const clock = {
    now: () => now,
    setTimeout(callback, ms) {
      const id = ++nextTimer;
      timers.set(id, { callback, at: now + ms, ms });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  const transport = createD1FileHttpsTransport({
    uploadOrigin: ORIGIN, clock,
    createAgent(config) {
      const agent = new Resource();
      agents.push({ agent, config });
      options.onAgent?.(clock);
      return agent;
    },
    requestImpl(url, config, onResponse) {
      const request = new Resource();
      requests.push({ url, config, onResponse, request });
      if (options.requestError) throw new Error(SIGNED);
      return request;
    },
  });
  function input(changes = {}) {
    return {
      method: "POST", url: API,
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: '{"action":"init","etag":"synthetic"}', redirect: "error",
      deadlineAt: EPOCH + 600000, ...changes,
    };
  }
  function incoming({ status = 200, headers = [], complete = true } = {}) {
    const response = new Resource();
    response.statusCode = status;
    response.rawHeaders = headers;
    response.complete = complete;
    requests.at(-1).onResponse(response);
    return response;
  }
  function advance(ms) {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) { timers.delete(id); timer.callback(); }
    }
  }
  return {
    transport, requests, agents, timers, clock, input, incoming, advance,
    setNow(value) { now = value; },
  };
}

function clean(h, response, signal) {
  assert.equal(h.timers.size, 0, "deadline timer removed");
  for (const { agent } of h.agents) assert.equal(agent.destroyed, true);
  for (const { request } of h.requests) {
    assert.equal(request.destroyed, true);
    assert.equal(request.listenerCount("close"), 0);
    assert.equal(request.listenerCount("timeout"), 0);
    assert.equal(request.listenerCount("error"), 1, "only inert late-error sink retained");
    assert.doesNotThrow(() => request.emit("error", new Error(SIGNED)));
  }
  if (response) {
    assert.equal(response.destroyed, true);
    for (const event of ["data", "end", "aborted", "close"]) assert.equal(response.listenerCount(event), 0);
    assert.equal(response.listenerCount("error"), 1);
    assert.doesNotThrow(() => response.emit("error", new Error(SIGNED)));
  }
  if (signal) assert.equal(getEventListeners(signal, "abort").length, 0);
}

async function rejected(promise) {
  await assert.rejects(promise, error => {
    assert.match(error.message, /^D1_HTTPS_[A-Z]+$/);
    assert.equal(error.code, error.message);
    assert.ok(!error.message.includes(SIGNED));
    return true;
  });
}

test("factory has no usable default network or agent implementation", () => {
  assert.throws(() => createD1FileHttpsTransport(), /D1_HTTPS_CONFIG/);
  assert.throws(() => createD1FileHttpsTransport({ requestImpl() {}, uploadOrigin: ORIGIN }), /D1_HTTPS_CONFIG/);
  assert.throws(() => createD1FileHttpsTransport({ createAgent() {}, uploadOrigin: ORIGIN }), /D1_HTTPS_CONFIG/);
  assert.throws(() => createD1FileHttpsTransport({
    requestImpl() {}, createAgent() {}, uploadOrigin: ORIGIN,
    clock: { now: () => EPOCH, setTimeout() {} },
  }), /D1_HTTPS_CONFIG/);
});

test("API dispatch pins exact target, explicit TLS/proxy/reuse options and bounded parsed response", async () => {
  const h = harness();
  const controller = new AbortController();
  const pending = h.transport.request(h.input({ signal: controller.signal }));
  assert.equal(h.requests.length, 1);
  const dispatched = h.requests[0];
  assert.equal(dispatched.url, API);
  assert.equal(dispatched.config.method, "POST");
  assert.deepEqual({ ...dispatched.config.headers }, {
    authorization: AUTH, "content-type": "application/json",
  });
  assert.equal(dispatched.request.payload.toString(), '{"action":"init","etag":"synthetic"}');
  assert.equal(dispatched.config.agent, h.agents[0].agent);
  assert.equal(dispatched.config.rejectUnauthorized, true);
  assert.equal(dispatched.config.maxHeaderSize, 16384);
  assert.equal(dispatched.config.insecureHTTPParser, false);
  assert.deepEqual(h.agents[0].config, {
    keepAlive: false, rejectUnauthorized: true, proxyEnv: {}, maxCachedSessions: 0,
  });
  assert.equal([...h.timers.values()][0].ms, 30000);
  const response = h.incoming();
  response.emit("data", Buffer.from('{"success":'));
  response.emit("data", Buffer.from("true}"));
  response.emit("end");
  assert.deepEqual(await pending, { status: 200, body: { success: true } });
  assert.deepEqual(h.transport.metrics, { dispatched: 1, completed: 1, failed: 0 });
  clean(h, response, controller.signal);
});

test("PUT preserves original signed URL and buffer identity, without API or cookie headers", async () => {
  const h = harness(), payload = Buffer.from([0, 255, 13, 10, 128]);
  const pending = h.transport.request(h.input({
    method: "PUT", url: SIGNED, headers: { "Content-Length": "5" }, body: payload,
  }));
  const sent = h.requests[0];
  assert.equal(sent.url, SIGNED);
  assert.equal(sent.request.payload, payload);
  assert.deepEqual({ ...sent.config.headers }, { "content-length": "5" });
  const response = h.incoming({ headers: ["ETag", '"synthetic-md5"'] });
  response.emit("end");
  assert.deepEqual(await pending, { status: 200, headers: { etag: '"synthetic-md5"' } });
  clean(h, response);
});

const invalidRequests = [
  ["other database", { url: API.replace("3e18385a", "00000000") }],
  ["API query", { url: `${API}?query=1` }],
  ["API normalized alias", { url: API.replace("api.cloudflare.com", "API.cloudflare.com") }],
  ["GET", { method: "GET" }],
  ["redirect follow", { redirect: "follow" }],
  ["URL control", { url: `${API}\n` }],
  ["URL space", { url: `${API} ` }],
  ["URL backslash", { url: API.replace("/client", "\\client") }],
  ["URL username", { url: API.replace("https://", "https://user@") }],
  ["URL fragment", { url: `${API}#fragment` }],
  ["HTTP upload", { method: "PUT", url: SIGNED.replace("https:", "http:") }],
  ["wrong upload origin", { method: "PUT", url: "https://other.synthetic.invalid/object" }],
  ["API cookie", { headers: { Authorization: AUTH, "Content-Type": "application/json", Cookie: "private" } }],
  ["duplicate authorization case", { headers: {
    Authorization: AUTH, authorization: AUTH, "Content-Type": "application/json",
  } }],
  ["header injection", { headers: { Authorization: `${AUTH}\r\nCookie: private`, "Content-Type": "application/json" } }],
  ["empty bearer", { headers: { Authorization: "Bearer ", "Content-Type": "application/json" } }],
];
for (const [label, changes] of invalidRequests) {
  test(`${label} refuses before agent creation and requestImpl`, async () => {
    const h = harness();
    await rejected(h.transport.request(h.input(changes)));
    assert.equal(h.requests.length, 0);
    assert.equal(h.agents.length, 0);
    assert.deepEqual(h.transport.metrics, { dispatched: 0, completed: 0, failed: 1 });
    clean(h);
  });
}

for (const name of ["Authorization", "authorization", "AUTHORIZATION", "Cookie", "cookie"]) {
  test(`PUT rejects ${name} rather than forwarding it to the signed destination`, async () => {
    const h = harness();
    await rejected(h.transport.request(h.input({
      method: "PUT", url: SIGNED, body: Buffer.from("x"),
      headers: { "Content-Length": "1", [name]: AUTH },
    })));
    assert.equal(h.requests.length, 0);
  });
}

test("authorization header case is normalized only for an approved API request", async () => {
  const h = harness();
  const pending = h.transport.request(h.input({
    headers: { AUTHORIZATION: AUTH, "CONTENT-TYPE": "application/json" },
  }));
  const response = h.incoming();
  response.emit("data", Buffer.from("{}"));
  response.emit("end");
  await pending;
  assert.deepEqual({ ...h.requests[0].config.headers }, {
    authorization: AUTH, "content-type": "application/json",
  });
  clean(h, response);
});

test("outgoing headers and payload have independent 16KiB and 64KiB ceilings", async () => {
  for (const changes of [
    { headers: { Authorization: `Bearer ${"a".repeat(16384)}`, "Content-Type": "application/json" } },
    { body: "x".repeat(65537) },
  ]) {
    const h = harness();
    await rejected(h.transport.request(h.input(changes)));
    assert.equal(h.requests.length, 0);
    clean(h);
  }
});

test("64KiB JSON response is accepted across chunks, one further byte is rejected before end", async () => {
  const exact = JSON.stringify({ data: "x".repeat(65536 - Buffer.byteLength('{"data":""}')) });
  assert.equal(Buffer.byteLength(exact), 65536);
  const h = harness();
  const pending = h.transport.request(h.input({ body: exact }));
  assert.equal(h.requests[0].request.payload.byteLength, 65536);
  const response = h.incoming();
  response.emit("data", Buffer.from(exact.slice(0, 32768)));
  response.emit("data", Buffer.from(exact.slice(32768)));
  response.emit("end");
  assert.deepEqual((await pending).body, JSON.parse(exact));
  clean(h, response);

  const overflow = harness();
  const refused = overflow.transport.request(overflow.input());
  const stream = overflow.incoming();
  stream.emit("data", Buffer.alloc(32768, 32));
  stream.emit("data", Buffer.alloc(32768, 32));
  assert.equal(stream.destroyed, false);
  stream.emit("data", Buffer.from(" "));
  await rejected(refused);
  assert.equal(stream.destroyed, true, "incremental rejection does not wait for end");
  clean(overflow, stream);
});

test("header byte cap counts UTF-8 rather than JavaScript characters", async () => {
  const h = harness();
  const pending = h.transport.request(h.input());
  const response = h.incoming({ headers: ["x", "é".repeat(8192)] });
  await rejected(pending);
  clean(h, response);
});

test("16KiB raw header boundary accepts the limit and rejects the next byte", async () => {
  const h = harness();
  const pending = h.transport.request(h.input());
  const response = h.incoming({ headers: ["x", "a".repeat(16377)] });
  response.emit("data", Buffer.from("{}"));
  response.emit("end");
  await pending;
  clean(h, response);
  const overflow = harness();
  const refused = overflow.transport.request(overflow.input());
  const oversized = overflow.incoming({ headers: ["x", "a".repeat(16378)] });
  await rejected(refused);
  clean(overflow, oversized);
});

for (const [label, options, chunks, event] of [
  ["redirect", { status: 307, headers: ["Location", SIGNED] }, [], null],
  ["unknown status", { status: 0 }, [], null],
  ["odd raw headers", { headers: ["Content-Length"] }, [], null],
  ["duplicate content length", { headers: ["Content-Length", "2", "content-length", "2"] }, [], null],
  ["CL and transfer encoding", { headers: ["Content-Length", "2", "Transfer-Encoding", "chunked"] }, [], null],
  ["declared oversized body", { headers: ["Content-Length", "65537"] }, [], null],
  ["truncated complete flag", { complete: false }, [Buffer.from("{}")], "end"],
  ["truncated content length", { headers: ["Content-Length", "3"] }, [Buffer.from("{}")], "end"],
  ["aborted body", {}, [], "aborted"],
  ["premature close", {}, [], "close"],
  ["stream error", {}, [], "error"],
  ["malformed JSON", {}, [Buffer.from('{"private":')], "end"],
  ["invalid UTF-8", {}, [Buffer.from([0xc3, 0x28])], "end"],
  ["non-object JSON", {}, [Buffer.from("[]")], "end"],
  ["unknown chunk shape", {}, ["not-a-byte-buffer"], null],
]) {
  test(`${label} rejects once, destroys resources and never redirects or retries`, async () => {
    const h = harness();
    const pending = h.transport.request(h.input());
    const response = h.incoming(options);
    for (const chunk of chunks) response.emit("data", chunk);
    if (event) response.emit(event, new Error(SIGNED));
    await rejected(pending);
    assert.deepEqual(h.transport.metrics, { dispatched: 1, completed: 0, failed: 1 });
    clean(h, response);
    response.emit("data", Buffer.from("{}"));
    response.emit("end");
    assert.equal(h.requests.length, 1);
  });
}

test("reset and requestImpl exception each consume one invocation with no automatic retry", async () => {
  const h = harness();
  const pending = h.transport.request(h.input());
  h.requests[0].request.emit("error", Object.assign(new Error(SIGNED), { code: "ECONNRESET" }));
  await rejected(pending);
  assert.deepEqual(h.transport.metrics, { dispatched: 1, completed: 0, failed: 1 });
  clean(h);
  const thrown = harness({ requestError: true });
  await rejected(thrown.transport.request(thrown.input()));
  assert.deepEqual(thrown.transport.metrics, { dispatched: 1, completed: 0, failed: 1 });
  assert.equal(thrown.agents[0].agent.destroyed, true);
  assert.equal(thrown.timers.size, 0);
});

test("expired and pre-aborted calls consume zero requestImpl invocations", async () => {
  for (const abort of [false, true]) {
    const h = harness(), controller = new AbortController();
    if (abort) controller.abort();
    await rejected(h.transport.request(h.input({
      deadlineAt: abort ? EPOCH + 10000 : EPOCH, signal: controller.signal,
    })));
    assert.equal(h.requests.length, 0);
    assert.equal(h.transport.metrics.dispatched, 0);
    clean(h, undefined, controller.signal);
  }
});

test("deadline expiring during agent creation still consumes zero requestImpl invocations", async () => {
  let h;
  h = harness({ onAgent: () => h.setNow(EPOCH + 1000) });
  await rejected(h.transport.request(h.input({ deadlineAt: EPOCH + 1000 })));
  assert.equal(h.requests.length, 0);
  assert.equal(h.transport.metrics.dispatched, 0);
  clean(h);
});

for (const cause of ["deadline", "abort", "request timeout"]) {
  test(`${cause} destroys both request and response, removes listeners and ignores late events`, async () => {
    const h = harness(), controller = new AbortController();
    const pending = h.transport.request(h.input({
      deadlineAt: EPOCH + 1000, signal: controller.signal,
    }));
    assert.equal([...h.timers.values()][0].ms, 1000);
    const response = h.incoming();
    response.emit("data", Buffer.from('{"unfinished":'));
    if (cause === "deadline") h.advance(1000);
    else if (cause === "abort") controller.abort();
    else h.requests[0].request.emit("timeout");
    await rejected(pending);
    clean(h, response, controller.signal);
    const late = new Resource();
    h.requests[0].onResponse(late);
    assert.equal(late.destroyed, true);
    assert.doesNotThrow(() => late.emit("error", new Error(SIGNED)));
    response.emit("end");
    h.advance(600000);
    assert.deepEqual(h.transport.metrics, { dispatched: 1, completed: 0, failed: 1 });
    assert.equal(h.requests.length, 1);
  });
}

test("30 second request cap aborts even when caller observation deadline is later", async () => {
  const h = harness();
  const pending = h.transport.request(h.input());
  h.advance(30000);
  await rejected(pending);
  clean(h);
});

test("successive requests allocate independent disposable agents and immutable metric snapshots", async () => {
  const h = harness(), before = h.transport.metrics;
  for (let index = 0; index < 2; index++) {
    const pending = h.transport.request(h.input());
    const response = h.incoming();
    response.emit("data", Buffer.from("{}"));
    response.emit("end");
    await pending;
    clean(h, response);
  }
  assert.equal(h.agents.length, 2);
  assert.notEqual(h.agents[0].agent, h.agents[1].agent);
  assert.deepEqual(before, { dispatched: 0, completed: 0, failed: 0 });
  assert.deepEqual(h.transport.metrics, { dispatched: 2, completed: 2, failed: 0 });
  assert.equal(Object.isFrozen(h.transport.metrics), true);
});

test("R4 synchronous abort inside agent factory destroys returned agent without arming a timer", async () => {
  const controller = new AbortController();
  const h = harness({ onAgent: () => controller.abort() });
  await rejected(h.transport.request(h.input({ signal: controller.signal })));
  assert.deepEqual({
    requestImplCalls: h.requests.length,
    returnedAgentDestroyed: h.agents[0].agent.destroyed,
    pendingTimers: h.timers.size,
    abortListeners: getEventListeners(controller.signal, "abort").length,
  }, {
    requestImplCalls: 0, returnedAgentDestroyed: true, pendingTimers: 0, abortListeners: 0,
  });
  const settled = h.transport.metrics;
  h.advance(600000);
  controller.abort();
  assert.deepEqual(h.transport.metrics, settled);
  assert.equal(h.requests.length, 0);
  clean(h, undefined, controller.signal);
});
