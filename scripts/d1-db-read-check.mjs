import { open } from "node:fs/promises";
import { createD1DatabaseReadTransport } from "./d1-file-import-https.mjs";

const PURPOSE = "fixed-d1-db-info-read";
const DATABASE = "3e18385a-af83-4c67-83a0-ab889149692c";
const NAME = "collection-kit-stats";
const ref = value => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const failure = () => new Error("D1_READ_JOURNAL");
const countKeys = ["reserved", "adapterInvoked", "dispatched", "confirmedResponse"];
const statuses = ["intent", "verified", "refused", "authorization_timeout",
  "unauthorized_401", "forbidden_403", "target_mismatch", "tls_connect_failure",
  "limit_exceeded", "journal_failure", "unknown_after_dispatch", "failed_before_dispatch"];

function metadata(record) {
  const allowed = ["approvalId", "accountId", "databaseId", "method", "path",
    "timestamp", "counts", "status", "verifiedName"];
  if (!record || Object.keys(record).some(key => !allowed.includes(key)) ||
      !ref(record.approvalId) || !/^[a-f0-9]{32}$/.test(record.accountId ?? "") ||
      record.databaseId !== DATABASE || record.method !== "GET" ||
      record.path !== `/client/v4/accounts/${record.accountId}/d1/database/${DATABASE}?fields=uuid,name` ||
      !Number.isSafeInteger(record.timestamp) || !statuses.includes(record.status) ||
      !record.counts || Object.keys(record.counts).length !== 4 ||
      !Object.keys(record.counts).every(key => countKeys.includes(key)) ||
      !countKeys.every(key => [0, 1].includes(record.counts[key]) ||
        (["dispatched", "confirmedResponse"].includes(key) &&
          record.counts.adapterInvoked === 1 && record.counts[key] === null)) ||
      (record.verifiedName !== undefined &&
        (record.status !== "verified" || record.verifiedName !== NAME)))
    throw failure();
  return Object.freeze({ ...record, counts: Object.freeze({ ...record.counts }) });
}

// A fresh exclusive file is the one-attempt boundary; existing or partial files refuse reuse.
export async function createD1ReadJournal({ path } = {}) {
  if (typeof path !== "string" || !path || /[\x00-\x1f]/.test(path)) throw failure();
  let handle;
  try { handle = await open(path, "wx", 0o600); } catch { throw failure(); }
  let phase = "fresh", binding;
  const append = async (record, expected, next) => {
    if (phase !== expected) throw failure();
    const safe = metadata(record);
    if ((expected === "fresh") !== (safe.status === "intent")) throw failure();
    const identity = JSON.stringify([safe.approvalId, safe.accountId, safe.databaseId]);
    if (binding && binding !== identity) throw failure();
    binding = identity;
    phase = "writing";
    try {
      await handle.writeFile(`${JSON.stringify(safe)}\n`, "utf8");
      await handle.sync();
      phase = next;
      if (next === "complete") { await handle.close(); handle = undefined; }
    } catch {
      phase = "failed";
      try { await handle?.close(); } catch { /* Fixed sanitized failure below. */ }
      handle = undefined;
      throw failure();
    }
  };
  return Object.freeze({
    recordIntent: record => append(record, "fresh", "intent"),
    recordResult: record => append(record, "intent", "complete"),
    async close() {
      const owned = handle;
      handle = undefined;
      phase = "closed";
      try { await owned?.close(); } catch { throw failure(); }
    },
  });
}

export async function runD1DatabaseReadCheck({
  approval, authProvider, journal, clock, transport,
} = {}) {
  const time = clock ?? { now: () => Date.now(), setTimeout, clearTimeout };
  const counts = { reserved: 0, adapterInvoked: 0, dispatched: 0, confirmedResponse: 0 };
  let pinned, client, intentRecorded = false, authorization, recordResult, closeJournal;
  const controller = new AbortController();
  const possiblyDispatched = () => counts.adapterInvoked === 1 && counts.dispatched !== 0;
  const outcome = status => Object.freeze({ status, counts: Object.freeze({ ...counts }),
    observation: status === "journal_failure" && possiblyDispatched() ? "unknown_after_dispatch" : status,
    synthetic: client?.synthetic !== false, serverCancellationClaimed: false });
  let status = "refused";
  const readMetrics = () => {
    const metrics = client.metrics;
    const dispatched = metrics.dispatched, confirmedResponse = metrics.confirmedResponse;
    if (![0, 1].includes(dispatched) || ![0, 1].includes(confirmedResponse) ||
        confirmedResponse > dispatched) throw new Error("D1_READ_METRICS");
    return { dispatched, confirmedResponse };
  };
  const captureMetrics = () => {
    try { Object.assign(counts, readMetrics()); return true; }
    catch {
      counts.dispatched = counts.confirmedResponse = null;
      return false;
    }
  };
  const timestamp = () => {
    const value = time.now();
    if (!Number.isSafeInteger(value)) throw new Error("D1_READ_CLOCK");
    return value;
  };
  const record = value => metadata({
    approvalId: pinned.id, accountId: pinned.accountId, databaseId: DATABASE,
    method: "GET",
    path: `/client/v4/accounts/${pinned.accountId}/d1/database/${DATABASE}?fields=uuid,name`,
    timestamp: timestamp(), counts: { ...counts }, status: value,
    ...(value === "verified" ? { verifiedName: NAME } : {}),
  });
  try {
    closeJournal = journal?.close;
    if (!approval || !authProvider || !journal ||
        typeof time.now !== "function" || typeof time.setTimeout !== "function" ||
        typeof time.clearTimeout !== "function") return outcome(status);
    pinned = Object.freeze(Object.fromEntries([
      "id", "purpose", "accountId", "databaseId", "expectedName", "providerRef",
      "credentialApprovalRef", "readApprovalRef", "expiresAt", "maxRequests",
    ].map(key => [key, approval[key]])));
    const provider = Object.freeze({
      id: authProvider.id, reference: authProvider.reference, accountId: authProvider.accountId,
      purpose: authProvider.purpose, getAuthorization: authProvider.getAuthorization,
    });
    const recordIntent = journal.recordIntent;
    recordResult = journal.recordResult;
    if (pinned.purpose !== PURPOSE || pinned.databaseId !== DATABASE ||
        pinned.expectedName !== NAME || pinned.maxRequests !== 1 ||
        !/^[a-f0-9]{32}$/.test(pinned.accountId ?? "") ||
        !["id", "providerRef", "credentialApprovalRef", "readApprovalRef"].every(key => ref(pinned[key])) ||
        !Number.isSafeInteger(pinned.expiresAt) || timestamp() >= pinned.expiresAt ||
        !ref(provider.id) || provider.reference !== pinned.providerRef ||
        provider.accountId !== pinned.accountId || provider.purpose !== PURPOSE ||
        typeof provider.getAuthorization !== "function" ||
        typeof recordIntent !== "function" || typeof recordResult !== "function")
      return outcome(status);
    client = transport ?? createD1DatabaseReadTransport({ approval: pinned, clock: time });
    if (client.purpose !== PURPOSE || client.noRetries !== true ||
        client.noRedirects !== true || typeof client.request !== "function")
      return outcome(status);
    try {
      const initial = readMetrics();
      if (initial.dispatched !== 0 || initial.confirmedResponse !== 0) return outcome("refused");
    } catch { return outcome("refused"); }
    counts.reserved = 1;
    try { await recordIntent.call(journal, record("intent")); intentRecorded = true; }
    catch { return outcome("journal_failure"); }
    const deadlineAt = Math.min(pinned.expiresAt, timestamp() + 30000);
    let timer;
    try {
      authorization = await new Promise((resolve, reject) => {
        timer = time.setTimeout(() => {
          controller.abort();
          reject(new Error("D1_READ_AUTH_TIMEOUT"));
        }, Math.max(0, deadlineAt - timestamp()));
        if (controller.signal.aborted) return;
        Promise.resolve().then(() => {
          if (controller.signal.aborted || timestamp() >= deadlineAt)
            throw new Error("D1_READ_AUTH_TIMEOUT");
          return provider.getAuthorization.call(provider, { signal: controller.signal, deadlineAt });
        }).then(resolve, reject);
      });
    } catch {
      status = controller.signal.aborted ? "authorization_timeout" : "failed_before_dispatch";
    } finally { if (timer !== undefined) time.clearTimeout(timer); }
    if (authorization !== undefined) {
      if (typeof authorization !== "string" || !/^Bearer [^\s]+$/.test(authorization) ||
          timestamp() >= deadlineAt) status = "failed_before_dispatch";
      else {
        counts.adapterInvoked = 1;
        try {
          const response = await client.request({ authorization, deadlineAt, signal: controller.signal });
          if (!captureMetrics()) status = "unknown_after_dispatch";
          else if (response.status === 401) status = "unauthorized_401";
          else if (response.status === 403) status = "forbidden_403";
          else if (counts.dispatched === 1 && counts.confirmedResponse === 1 &&
              response.status === 200 && response.body?.success === true &&
              response.body?.result?.uuid === DATABASE && response.body?.result?.name === NAME)
            status = "verified";
          else status = "target_mismatch";
        } catch (cause) {
          if (!captureMetrics()) status = "unknown_after_dispatch";
          else if (cause?.code === "D1_HTTPS_TLS_CONNECT") status = "tls_connect_failure";
          else if (["D1_HTTPS_HEADERS", "D1_HTTPS_BODY", "D1_HTTPS_DEADLINE"].includes(cause?.code))
            status = "limit_exceeded";
          else status = counts.dispatched ? "unknown_after_dispatch" : "failed_before_dispatch";
        }
      }
    } else if (status === "refused") status = "failed_before_dispatch";
    authorization = undefined;
    try { await recordResult.call(journal, record(status)); }
    catch { return outcome("journal_failure"); }
    return outcome(status);
  } catch {
    authorization = undefined;
    if (intentRecorded) {
      try { await recordResult.call(journal, record(possiblyDispatched() ? "unknown_after_dispatch" : "failed_before_dispatch")); }
      catch { return outcome("journal_failure"); }
    }
    return outcome(possiblyDispatched() ? "unknown_after_dispatch" : "failed_before_dispatch");
  } finally {
    authorization = undefined;
    controller.abort();
    try {
      if (typeof closeJournal === "function") await closeJournal.call(journal);
    } catch { return outcome("journal_failure"); }
  }
}
