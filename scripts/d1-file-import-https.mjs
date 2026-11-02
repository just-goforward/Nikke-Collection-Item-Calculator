import * as https from "node:https";

const MANAGEMENT = "https://api.cloudflare.com/client/v4/accounts/15be33fd20ea78eb3d60b719be831148/d1/database/3e18385a-af83-4c67-83a0-ab889149692c/import";
const HEADER_CAP = 16 * 1024;
const BODY_CAP = 64 * 1024;
const controls = /[\x00-\x20\x7f]/;
const invalidHeader = /[\x00-\x1f\x7f]/;
const error = code => Object.assign(new Error(`D1_HTTPS_${code}`), { code: `D1_HTTPS_${code}` });
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

function destination(value) {
  if (typeof value !== "string" || controls.test(value) || value.includes("\\") ||
      value.includes("#")) throw error("POLICY");
  let parsed;
  try { parsed = new URL(value); } catch { throw error("POLICY"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
      !parsed.hostname) throw error("POLICY");
  return parsed;
}

// Offline injection only. Fakes do not establish real TLS, proxy, or DNS behavior.
export function createD1FileHttpsTransport({ requestImpl, createAgent, uploadOrigin, clock } = {}) {
  return createHttpsTransport({ requestImpl, createAgent, uploadOrigin, clock });
}

export function createD1DatabaseReadTransport({ approval, clock } = {}) {
  if (!object(approval) || approval.purpose !== "fixed-d1-db-info-read" ||
      !/^[a-f0-9]{32}$/.test(approval.accountId ?? "") ||
      approval.databaseId !== "3e18385a-af83-4c67-83a0-ab889149692c" ||
      approval.expectedName !== "collection-kit-stats" || approval.maxRequests !== 1 ||
      !Number.isSafeInteger(approval.expiresAt) ||
      !["id", "providerRef", "credentialApprovalRef", "readApprovalRef"].every(key =>
        typeof approval[key] === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(approval[key])))
    throw error("POLICY");
  const pinned = Object.freeze({ ...approval });
  const url = `https://api.cloudflare.com/client/v4/accounts/${pinned.accountId}/d1/database/${pinned.databaseId}?fields=uuid,name`;
  const core = createHttpsTransport({ requestImpl: https.request,
    createAgent: options => new https.Agent(options), uploadOrigin: "https://api.cloudflare.com",
    clock, readUrl: url });
  let invoked = false;
  return Object.freeze({
    purpose: pinned.purpose, synthetic: false, noRetries: true, noRedirects: true,
    get metrics() { return Object.freeze({ ...core.metrics, confirmedResponse: core.metrics.completed }); },
    async request(input) {
      if (invoked || !object(input) ||
          Object.keys(input).some(key => !["authorization", "deadlineAt", "signal"].includes(key)))
        throw error("POLICY");
      invoked = true;
      return core.request({ method: "GET", url,
        headers: { Authorization: input.authorization }, redirect: "error",
        deadlineAt: Math.min(input.deadlineAt, pinned.expiresAt), signal: input.signal });
    },
  });
}

function createHttpsTransport({ requestImpl, createAgent, uploadOrigin, clock, readUrl } = {}) {
  if (typeof requestImpl !== "function" || typeof createAgent !== "function")
    throw error("CONFIG");
  const origin = destination(uploadOrigin);
  if (uploadOrigin !== origin.origin) throw error("POLICY");
  const time = clock ?? { now: () => Date.now() };
  if (typeof time.now !== "function" ||
      (time.setTimeout !== undefined && typeof time.setTimeout !== "function") ||
      (time.clearTimeout !== undefined && typeof time.clearTimeout !== "function") ||
      (typeof time.setTimeout === "function") !== (typeof time.clearTimeout === "function"))
    throw error("CONFIG");
  const arm = time.setTimeout ? time.setTimeout.bind(time) : setTimeout;
  const disarm = time.clearTimeout ? time.clearTimeout.bind(time) : clearTimeout;
  const metrics = { dispatched: 0, completed: 0, failed: 0 };
  const now = () => {
    const value = time.now();
    if (!Number.isSafeInteger(value)) throw error("CLOCK");
    return value;
  };

  return Object.freeze({
    synthetic: true,
    noRetries: true,
    noRedirects: true,
    get metrics() { return Object.freeze({ ...metrics }); },
    async request(input) {
      let request, response, agent, timer, signal, abortListener;
      let settled = false;
      const listeners = [];
      const released = new Set();
      const listen = (emitter, event, handler) => {
        if (settled) return;
        listeners.push([emitter, event, handler]);
        emitter.on(event, handler);
        if (settled) emitter.removeListener(event, handler);
      };
      // Keep only an inert error sink after cleanup: destroy may emit errors later.
      const sink = () => {};
      const destroy = (resource, absorbErrors = false) => {
        if (!resource || released.has(resource)) return;
        released.add(resource);
        if (absorbErrors) resource.on("error", sink);
        try { resource?.destroy(); } catch { /* Never expose injected exceptions. */ }
      };
      const cleanup = () => {
        const ownedTimer = timer, ownedAbortListener = abortListener;
        const ownedRequest = request, ownedResponse = response, ownedAgent = agent;
        const ownedListeners = listeners.splice(0);
        timer = abortListener = request = response = agent = undefined;
        if (ownedTimer !== undefined) disarm(ownedTimer);
        if (signal && ownedAbortListener) signal.removeEventListener("abort", ownedAbortListener);
        for (const [emitter, event, handler] of ownedListeners) emitter.removeListener(event, handler);
        destroy(ownedRequest, true);
        destroy(ownedResponse, true);
        destroy(ownedAgent);
      };
      return new Promise((resolve, reject) => {
        const finish = (code, result) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (code) { metrics.failed++; reject(error(code)); }
          else { metrics.completed++; resolve(result); }
        };
        try {
          if (!object(input)) throw error("POLICY");
          const { method, url, headers, body, redirect, deadlineAt } = input;
          signal = input.signal;
          const target = destination(url);
          const api = readUrl ? method === "GET" && url === readUrl : method === "POST" && url === MANAGEMENT;
          if ((!api && !(!readUrl && method === "PUT" && target.origin === uploadOrigin)) ||
              redirect !== "error" || !object(headers) || !Number.isSafeInteger(deadlineAt))
            throw error("POLICY");
          if (signal && (typeof signal.addEventListener !== "function" ||
              typeof signal.removeEventListener !== "function" || typeof signal.aborted !== "boolean"))
            throw error("POLICY");
          const outgoing = Object.create(null);
          const names = new Set();
          let headerBytes = 0;
          for (const [name, value] of Object.entries(headers)) {
            const lower = name.toLowerCase();
            if (!/^[A-Za-z0-9-]+$/.test(name) || typeof value !== "string" ||
                invalidHeader.test(value) || names.has(lower) ||
                !(api ? (readUrl ? ["authorization"] : ["authorization", "content-type"]) : ["content-length"]).includes(lower))
              throw error("POLICY");
            names.add(lower);
            headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
            if (headerBytes > HEADER_CAP) throw error("HEADERS");
            outgoing[lower] = value;
          }
          let payload;
          if (readUrl) {
            if (names.size !== 1 || !/^Bearer [^\s]+$/.test(outgoing.authorization))
              throw error("POLICY");
            payload = undefined;
          } else if (api) {
            if (names.size !== 2 || !/^Bearer [^\s]+$/.test(outgoing.authorization) ||
                outgoing["content-type"] !== "application/json" || typeof body !== "string")
              throw error("POLICY");
            payload = Buffer.from(body);
          } else {
            if (names.size !== 1 || !Buffer.isBuffer(body) ||
                outgoing["content-length"] !== String(body.length)) throw error("POLICY");
            payload = body;
          }
          if (payload && payload.byteLength > BODY_CAP) throw error("BODY");
          const deadline = Math.min(deadlineAt, now() + 30000);
          const check = () => {
            if (signal?.aborted) throw error("ABORTED");
            if (now() >= deadline) throw error("DEADLINE");
          };
          check();
          abortListener = () => finish("ABORTED");
          signal?.addEventListener("abort", abortListener, { once: true });
          if (settled) return;
          agent = createAgent({ keepAlive: false, rejectUnauthorized: true,
            proxyEnv: {}, maxCachedSessions: 0 });
          if (settled) { cleanup(); return; }
          const delay = Math.max(0, deadline - now());
          if (settled) return;
          timer = arm(() => finish("DEADLINE"), delay);
          if (settled) { cleanup(); return; }
          const onResponse = incoming => {
            if (settled) { destroy(incoming, true); return; }
            if (response) { destroy(incoming, true); finish("RESPONSE"); return; }
            response = incoming;
            try {
              listen(response, "error", () => finish("IO"));
              listen(response, "aborted", () => finish("TRUNCATED"));
              listen(response, "close", () => { if (!settled) finish("TRUNCATED"); });
              const status = response.statusCode;
              if (!Number.isInteger(status) || status < 200 || status > 599) throw error("RESPONSE");
              if (status >= 300 && status < 400) throw error("REDIRECT");
              const raw = response.rawHeaders;
              if (!Array.isArray(raw) || raw.length % 2) throw error("HEADERS");
              let size = 2, contentLength, etag;
              const seen = new Set();
              for (let i = 0; i < raw.length; i += 2) {
                const name = raw[i], value = raw[i + 1];
                if (typeof name !== "string" || typeof value !== "string" ||
                    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || invalidHeader.test(value))
                  throw error("HEADERS");
                size += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
                if (size > HEADER_CAP) throw error("HEADERS");
                const lower = name.toLowerCase();
                if (["content-length", "etag", "transfer-encoding"].includes(lower)) {
                  if (seen.has(lower)) throw error("HEADERS");
                  seen.add(lower);
                }
                if (lower === "content-length") {
                  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw error("HEADERS");
                  contentLength = Number(value);
                  if (!Number.isSafeInteger(contentLength) || contentLength > BODY_CAP)
                    throw error("BODY");
                }
                if (lower === "etag") etag = value;
              }
              if (seen.has("content-length") && seen.has("transfer-encoding")) throw error("HEADERS");
              let bytes = 0;
              const chunks = [];
              listen(response, "data", chunk => {
                if (settled) return;
                try { check(); } catch { finish(signal?.aborted ? "ABORTED" : "DEADLINE"); return; }
                if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
                  finish("RESPONSE"); return;
                }
                bytes += chunk.byteLength;
                if (bytes > BODY_CAP) { finish("BODY"); return; }
                chunks.push(Buffer.from(chunk));
              });
              listen(response, "end", () => {
                if (settled) return;
                try { check(); } catch { finish(signal?.aborted ? "ABORTED" : "DEADLINE"); return; }
                if (response.complete !== true || (contentLength !== undefined && contentLength !== bytes)) {
                  finish("TRUNCATED"); return;
                }
                if (!api) { finish(null, { status, headers: etag === undefined ? {} : { etag } }); return; }
                if (readUrl && (status === 401 || status === 403)) {
                  finish(null, { status, body: {} }); return;
                }
                try {
                  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
                  const envelope = JSON.parse(decoded);
                  if (!object(envelope)) throw error("RESPONSE");
                  finish(null, { status, body: envelope });
                } catch { finish("RESPONSE"); }
              });
            } catch (cause) {
              finish(readUrl && ["D1_HTTPS_HEADERS", "D1_HTTPS_BODY"].includes(cause?.code)
                ? cause.code.slice("D1_HTTPS_".length) : "RESPONSE");
            }
          };
          check();
          if (settled) return;
          metrics.dispatched++;
          request = requestImpl(url, { method, headers: outgoing, agent,
            rejectUnauthorized: true, maxHeaderSize: HEADER_CAP, insecureHTTPParser: false }, onResponse);
          if (settled) { cleanup(); return; }
          listen(request, "error", cause => finish(readUrl && cause?.code === "HPE_HEADER_OVERFLOW"
            ? "HEADERS" : readUrl && [
            "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "CERT_HAS_EXPIRED",
            "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
            "ERR_TLS_CERT_ALTNAME_INVALID",
          ].includes(cause?.code) ? "TLS_CONNECT" : "IO"));
          listen(request, "close", () => { if (!response && !settled) finish("TRUNCATED"); });
          listen(request, "timeout", () => finish("DEADLINE"));
          check();
          if (settled) return;
          request.end(payload);
        } catch (cause) {
          const allowed = ["POLICY", "HEADERS", "BODY", "CLOCK", "ABORTED", "DEADLINE", "CONFIG"];
          const code = allowed.find(value => cause?.code === `D1_HTTPS_${value}`);
          finish(code ?? "IO");
        }
      });
    },
  });
}
