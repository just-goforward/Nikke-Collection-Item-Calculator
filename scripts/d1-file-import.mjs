import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const FILE_IMPORT_TARGET = Object.freeze({
  account: "15be33fd20ea78eb3d60b719be831148",
  database: "3e18385a-af83-4c67-83a0-ab889149692c",
  expectedSHA: "df5394e74a3553516673fccd042e2a6b9bd07481aac44e8216aa62c5ae97e6de",
  expectedBytes: 13969,
  path: fileURLToPath(new URL("../cloudflare/decision-analytics/0002_stats_public_read_models.proposed.sql", import.meta.url)),
});
export const FILE_IMPORT_LIMITS = Object.freeze({ init: 1, put: 1, ingest: 1, poll: 12 });
const WINDOW = 600000;
const phases = ["prepared", "init", "upload", "ingest", "poll", "api_complete", "server_failed", "unknown"];
const outcomes = ["ready", "pending", "unknown", "api_complete", "server_failed"];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.length > 0 && value.length <= 16384;
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest("hex");

export const fileImportClock = Object.freeze({
  now: () => Date.now(),
  async wait(promise, ms) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("deadline")), ms);
      })]);
    } finally { clearTimeout(timer); }
  },
});

function binding(input) {
  if (!object(input) || input.account !== FILE_IMPORT_TARGET.account ||
      input.database !== FILE_IMPORT_TARGET.database ||
      input.expectedSHA !== FILE_IMPORT_TARGET.expectedSHA ||
      input.expectedBytes !== FILE_IMPORT_TARGET.expectedBytes ||
      typeof input.path !== "string" || !input.path)
    throw new Error("binding");
  return { account: input.account, database: input.database,
    sha256: input.expectedSHA, bytes: input.expectedBytes };
}

function validState(record, target, operationId) {
  const allowed = ["version", "binding", "sequence", "phase", "counts", "startedAt",
    "deadlineAt", "inFlight", "operation", "outcome", "postcheck"];
  const bound = { accountId: target.account, databaseId: target.database,
    sqlSha256: target.sha256, executionId: operationId };
  if (!object(record) || Object.keys(record).length !== allowed.length ||
      Object.keys(record).some(key => !allowed.includes(key)) || record.version !== 1 ||
      !object(record.binding) || Object.keys(record.binding).length !== 4 ||
      Object.keys(bound).some(key => record.binding[key] !== bound[key]) ||
      !Number.isSafeInteger(record.sequence) || record.sequence < 1 ||
      !phases.includes(record.phase) || !outcomes.includes(record.outcome) ||
      !Number.isSafeInteger(record.startedAt) || !Number.isSafeInteger(record.deadlineAt) ||
      record.deadlineAt !== record.startedAt + WINDOW ||
      !object(record.counts) || Object.keys(record.counts).length !== 4 || Object.keys(FILE_IMPORT_LIMITS).some(key =>
        !Number.isSafeInteger(record.counts[key]) || record.counts[key] < 0 ||
        record.counts[key] > FILE_IMPORT_LIMITS[key]) ||
      ![null, "init", "put", "ingest", "poll"].includes(record.inFlight) ||
      !["not_run", "pending"].includes(record.postcheck) ||
      !object(record.operation) || Object.keys(record.operation).some(key =>
        !["filename", "atBookmark", "finalBookmark", "etag"].includes(key) || !text(record.operation[key])))
    return false;
  if ((record.counts.put || record.counts.ingest || record.counts.poll) && record.counts.init !== 1) return false;
  if (record.counts.ingest && record.counts.put !== 1) return false;
  if (record.outcome === "pending" && !record.operation.atBookmark) return false;
  if (record.outcome === "api_complete" && (record.phase !== "api_complete" ||
      !record.operation.finalBookmark || record.postcheck !== "pending")) return false;
  if (record.outcome === "server_failed" && record.phase !== "server_failed") return false;
  return true;
}

function uploadDestination(raw, approvedOrigin) {
  if (!text(raw) || typeof approvedOrigin !== "string") throw new Error("upload_policy");
  const url = new URL(raw), approved = new URL(approvedOrigin);
  if (url.protocol !== "https:" || url.username || url.password || url.hash ||
      approved.protocol !== "https:" || approved.username || approved.password ||
      approved.pathname !== "/" || approved.search || approved.hash ||
      approved.origin !== approvedOrigin || url.origin !== approvedOrigin)
    throw new Error("upload_policy");
  return raw;
}

/**
 * Security owns the exclusive, authenticated/encrypted session and its durable save.
 * This module has no live transport/auth implementation and never accesses OAuth state.
 * request receives synthetic HTTP {method,url,headers,body,redirect}; no retry contract.
 * API response: {status, body:{success,result}}, PUT: {status,headers:{etag}}.
 */
export async function runFileImport({
  session, transport, authProvider, clock = fileImportClock,
  input, uploadOrigin, operationId, afterPin, approval,
} = {}) {
  let state = null, bytes, authorization;
  let approvedBinding, approvalDecision, providerDecision;
  const controllers = new Set();
  let reason = "preflight_refused", durable = true, transportInvocationsThisRun = 0, publicResult;
  function dispatchCount() {
    try {
      const value = transport?.metrics?.dispatched;
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    } catch { return null; }
  }
  const initialDispatched = dispatchCount();
  function actualDispatches() {
    const current = dispatchCount();
    return initialDispatched !== null && current !== null && current >= initialDispatched
      ? current - initialDispatched : null;
  }
  const summary = () => (publicResult = {
    operationId: typeof operationId === "string" && /^[0-9a-f-]{36}$/.test(operationId) ? operationId : null,
    status: ({ ready: "refused", pending: "observing", unknown: "unknown",
      api_complete: "complete_pending_postcheck", server_failed: "failed" })[state?.outcome] ?? "refused", reason,
    counts: state ? { ...state.counts } : null,
    actualRequestsThisRun: actualDispatches(), transportInvocationsThisRun,
    journalDurable: durable, postverified: false,
    serverCancellationClaimed: false, rollbackClaimed: false,
  });
  async function save() {
    state.sequence++;
    try { await session.save(structuredClone(state)); }
    catch { durable = false; throw new Error("journal"); }
  }
  function validateApproval() {
    const reference = value => text(value) && !/[\x00-\x20\x7f]/.test(value);
    const now = clock.now();
    if (!object(approvalDecision) || !reference(approvalDecision.id) || !reference(providerDecision.id) ||
        approvalDecision.providerId !== providerDecision.id || approvalDecision.purpose !== "d1-file-import" ||
        approvalDecision.scope !== "synthetic" || !reference(approvalDecision.permissionEvidenceRef) ||
        !Number.isSafeInteger(now) || !Number.isSafeInteger(approvalDecision.expiresAt) ||
        now >= approvalDecision.expiresAt || !object(approvalDecision.binding) ||
        Object.keys(approvalDecision.binding).length !== 4 ||
        Object.keys(approvedBinding).some(key => approvalDecision.binding[key] !== approvedBinding[key]))
      throw new Error("approval");
  }
  function remaining() {
    validateApproval();
    const now = clock.now();
    if (!Number.isSafeInteger(now) || now < state.startedAt) throw new Error("clock");
    const deadline = Math.min(state.deadlineAt, approvalDecision.expiresAt);
    if (now >= deadline) throw new Error("deadline");
    return deadline - now;
  }
  async function boundedCall(callback, deadlineAt) {
    const controller = new AbortController();
    controllers.add(controller);
    try {
      remaining();
      const ms = deadlineAt - clock.now();
      if (ms <= 0) throw new Error("deadline");
      const response = await clock.wait(Promise.resolve().then(() => {
        remaining();
        if (clock.now() >= deadlineAt || controller.signal.aborted) throw new Error("deadline");
        return callback(controller.signal, deadlineAt);
      }), ms);
      remaining();
      if (clock.now() >= deadlineAt) throw new Error("deadline");
      return response;
    } finally {
      controller.abort();
      controllers.delete(controller);
    }
  }
  async function request(kind, method, url, body, api = true) {
    remaining();
    if (state.counts[kind] >= FILE_IMPORT_LIMITS[kind]) throw new Error("budget");
    state.counts[kind]++;
    state.phase = kind === "put" ? "upload" : kind; state.outcome = "unknown"; state.inFlight = kind;
    await save();
    remaining();
    const deadlineAt = Math.min(state.deadlineAt, approvalDecision.expiresAt, clock.now() + 30000);
    const headers = api ? { Authorization: authorization, "Content-Type": "application/json" }
      : { "Content-Length": String(bytes.length) };
    return await boundedCall((signal, requestDeadline) => {
      remaining();
      transportInvocationsThisRun++;
      // Adapter calls are not HTTP dispatches; only adapter-owned metrics count those.
      return transport.request({ method, url, headers, body, redirect: "error",
        deadlineAt: requestDeadline, signal });
    }, deadlineAt);
  }
  async function api(action, fields = {}) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${state.binding.accountId}/d1/database/${state.binding.databaseId}/import`;
    const response = await request(action === "ingest" ? "ingest" : action === "poll" ? "poll" : "init",
      "POST", url, JSON.stringify({ action, ...fields }));
    remaining();
    if (!object(response) || response.status !== 200 || !object(response.body) ||
        response.body.success !== true || !object(response.body.result)) throw new Error("response");
    return response.body.result;
  }
  async function acknowledge(response) {
    if (response.status === "complete") {
      if (response.success !== true || !object(response.result) || !text(response.result.final_bookmark))
        throw new Error("response");
      state.operation.finalBookmark = response.result.final_bookmark;
      state.phase = "api_complete"; state.outcome = "api_complete"; state.postcheck = "pending";
    } else if (response.status === "error") {
      if (response.success !== false) throw new Error("response");
      state.phase = "server_failed"; state.outcome = "server_failed";
    } else if (response.status === "active") {
      if (response.success !== true || !text(response.at_bookmark)) throw new Error("response");
      state.operation.atBookmark = response.at_bookmark;
      state.outcome = "pending";
    } else throw new Error("response");
    state.inFlight = null;
    await save();
  }
  try {
    if (object(approval)) {
      const { id, providerId, purpose, binding: callerBinding, expiresAt, scope, permissionEvidenceRef } = approval;
      approvalDecision = Object.freeze({ id, providerId, purpose, expiresAt, scope, permissionEvidenceRef,
        binding: object(callerBinding) ? Object.freeze({ ...callerBinding }) : null });
    }
    providerDecision = Object.freeze({ id: authProvider?.id, synthetic: authProvider?.synthetic,
      getAuthorization: authProvider?.getAuthorization });
    if (!session || typeof session.load !== "function" || typeof session.save !== "function" ||
        typeof session.close !== "function" || transport?.synthetic !== true ||
        transport?.noRetries !== true || transport?.noRedirects !== true ||
        typeof transport.request !== "function" || providerDecision.synthetic !== true ||
        typeof providerDecision.getAuthorization !== "function" ||
        typeof operationId !== "string" || !/^[0-9a-f-]{36}$/.test(operationId))
      return summary();
    const target = binding(input);
    approvedBinding = Object.freeze({ accountId: target.account, databaseId: target.database,
      sqlSha256: target.sha256, executionId: operationId });
    validateApproval();
    // Validate exact-origin policy before even cache-hit INIT can start.
    uploadDestination(`${uploadOrigin}/synthetic-policy-check`, uploadOrigin);
    bytes = await readFile(input.path);
    if (bytes.length !== target.bytes || bytes.includes(13) ||
        bytes.at(-1) !== 10 || digest("sha256", bytes) !== target.sha256) return summary();
    if (afterPin !== undefined) {
      if (typeof afterPin !== "function") return summary();
      await afterPin({ sha256: target.sha256, byteLength: bytes.length });
    }
    const loaded = await session.load();
    if (loaded !== null) {
      if (!validState(loaded, target, operationId)) { reason = "state_refused"; return summary(); }
      state = structuredClone(loaded);
      if (state.outcome === "api_complete" || state.outcome === "server_failed") {
        reason = "terminal_record"; return summary();
      }
      // Existing records may only observe a known operation, never resume writes.
      if (!state.operation.atBookmark || !["pending", "unknown"].includes(state.outcome) ||
          !["poll", null].includes(state.inFlight)) {
        state.phase = "unknown"; state.outcome = "unknown";
        reason = "reconciliation_required"; await save(); return summary();
      }
      state.outcome = "pending";
    } else {
      const now = clock.now();
      if (!Number.isSafeInteger(now)) return summary();
      state = { version: 1, binding: { accountId: target.account, databaseId: target.database,
        sqlSha256: target.sha256, executionId: operationId }, sequence: 0,
        startedAt: now, deadlineAt: now + WINDOW, counts: { init: 0, put: 0, ingest: 0, poll: 0 },
        phase: "prepared", outcome: "ready", inFlight: null, operation: {}, postcheck: "not_run" };
      await save();
    }
    remaining();
    authorization = await boundedCall(signal => providerDecision.getAuthorization.call(authProvider, Object.freeze({
      purpose: "d1-file-import", binding: approvedBinding, approvalId: approvalDecision.id, signal,
    })), Math.min(state.deadlineAt, approvalDecision.expiresAt));
    if (typeof authorization !== "string" || !/^Bearer [^\x00-\x20\x7f]+$/.test(authorization))
      throw new Error("authorization");
    if (loaded === null) {
      const response = await api("init", { etag: digest("md5", bytes) });
      if (Object.hasOwn(response, "upload_url")) {
        if (!text(response.filename) || response.status === "active" || response.status === "complete" ||
            response.status === "error") throw new Error("response");
        const url = uploadDestination(response.upload_url, uploadOrigin);
        state.operation.filename = response.filename; state.inFlight = null;
        await save();
        const ack = await request("put", "PUT", url, bytes, false);
        remaining();
        if (!object(ack) || ack.status !== 200 || !object(ack.headers) ||
            ack.headers.etag?.replace(/^"|"$/g, "") !== digest("md5", bytes)) throw new Error("upload_ack");
        state.inFlight = null; await save();
        await acknowledge(await api("ingest", { filename: state.operation.filename, etag: digest("md5", bytes) }));
      } else {
        await acknowledge(response);
      }
    }
    while (state.outcome === "pending") {
      await acknowledge(await api("poll", { current_bookmark: state.operation.atBookmark }));
    }
    reason = state.outcome === "server_failed" ? "authoritative_failure" : "postcheck_required";
    return summary();
  } catch {
    for (const controller of controllers) controller.abort();
    // Raw errors can contain request URLs, credentials, bodies or provider messages.
    reason = durable ? "observation_stopped" : "journal_unavailable";
    if (state) {
      state.phase = "unknown"; state.outcome = "unknown";
      if (durable) { try { await save(); } catch { reason = "journal_unavailable"; } }
    }
    return summary();
  } finally {
    for (const controller of controllers) controller.abort();
    controllers.clear();
    authorization = undefined;
    if (session && typeof session.close === "function") {
      try { await session.close(); }
      catch {
        durable = false;
        if (publicResult) {
          publicResult.journalDurable = false;
          publicResult.reason = "session_close_failed";
          publicResult.status = state ? "unknown" : "refused";
        }
      }
    }
  }
}
