// Source-value protocol bounds, not V8/native-buffer/heap bounds.
// Never imports an evaluator. Encoding/decoding is inactive during node --check.
import { CONTROLS, TARGET, CALL_CAP, WORK_CAP, WINDOW_MS, PINS, OOM_BANNER_SUBSTRING } from "./contract.mjs";

const enumeration = (...values) => ({ type: "enum", values });
const integer = (max, min = 0) => ({ type: "integer", min, max });
const text = (max, pattern) => ({ type: "text", max, pattern });
const object = fields => ({ type: "object", fields });
const tuple = items => ({ type: "tuple", items });
const nullable = value => ({ type: "nullable", value });
const union = (...values) => ({ type: "union", values });
const hex = text(64, /^[0-9a-f]{64}$/);
// Decimal digits <= bit length. The conservative B09 unreduced numerator
// envelope is 2253+3072+2 = 5327 bits; normalized wire values are no larger.
const digits = text(5327, /^(0|[1-9]\d*)$/);
const positiveDigits = text(5327, /^[1-9]\d*$/);
const rational = object({ numerator: digits, denominator: positiveDigits });
const endpoint = object({
  P: object({ numerator: enumeration("1"), denominator: enumeration("1") }),
  B: rational, C: rational, consumed: tuple([rational, rational, rational]),
  mask: integer(7, 1), chosen: integer(2),
  worstAll: tuple([integer(224), integer(224), integer(224)]),
});
const summary = control => object({
  id: enumeration(control.id), status: enumeration("PASS"),
  helperStatus: enumeration(control.expectedStatus),
  rows: integer(control.helper.rows), peakRows: integer(control.helper.peak),
  oracleNodes: integer(control.oracle.memo),
  staticallyReservedWork: enumeration(control.work),
});
const failed = object({
  status: enumeration("FAIL", "NOTRUN"),
  // Protocol vocabulary is ASCII and bounded. Raw exceptions/stacks are forbidden.
  reason: text(96, /^pf2_[a-z0-9_]+$/),
  evaluatorCalls: nullable(integer(CALL_CAP)),
});
const completed = object({
  status: enumeration("PASS", "UNKNOWN"), scope: enumeration("B09-first-normal-only"),
  controls: tuple(CONTROLS.map(summary)), evaluatorCalls: enumeration(CALL_CAP),
  staticallyReservedWork: enumeration(WORK_CAP),
  memoryObservation: object({
    maxRSSKiB: nullable(integer(Number.MAX_SAFE_INTEGER)), certifying: enumeration(false),
  }),
  target: object({
    status: enumeration("PASS", "UNKNOWN"), finiteEndpoint: nullable(endpoint),
    rows: integer(TARGET.helper.rows), peakRows: integer(TARGET.helper.peak),
  }),
});
export const TRIAL_SCHEMA = union(failed, completed);
const requestSchema = object({
  version: enumeration(1), nonce: hex,
  remainingMs: integer(WINDOW_MS),
  fixtureBase64: text(4 * Math.ceil(22814 / 3), /^[A-Za-z0-9+/]+={0,2}$/),
});
const responseSchema = object({ version: enumeration(1), nonce: hex, result: TRIAL_SCHEMA });
const cleanupSchema = object({
  childStarted: enumeration(false, true), closeObserved: enumeration(false, true),
  stopRequested: enumeration(false, true),
});
const noticeSchema = union(
  object({ kind: enumeration("PF2_CHILD_STARTED"), pid: integer(Number.MAX_SAFE_INTEGER, 1) }),
  object({ kind: enumeration("PF2_CLEANUP_PENDING"),
    pid: nullable(integer(Number.MAX_SAFE_INTEGER, 1)), status: enumeration("FAIL", "NOTRUN"),
    reason: text(96, /^pf2_[a-z0-9_]+$/) }),
);
const publicationSchema = object({
  runnerToken: hex,
  version: enumeration(1), kind: enumeration("PF2_PROVISIONAL"),
  acceptance: enumeration("complete-frame-and-parent-exit-zero"),
  result: TRIAL_SCHEMA,
  cleanup: cleanupSchema,
  preservation: nullable(object({
    before: hex, after: hex, selectedFiles: enumeration(PINS.length + 5),
  })),
});
const outerSchema = object({
  version: enumeration(1), result: TRIAL_SCHEMA,
  cleanup: object({
    parentPid: nullable(integer(Number.MAX_SAFE_INTEGER, 1)),
    parentCloseObserved: enumeration(false, true),
    childPid: nullable(integer(Number.MAX_SAFE_INTEGER, 1)),
    childCleanupConfirmed: enumeration(false, true),
    operatorActionRequired: enumeration(false, true),
  }),
});
const outerPendingSchema = object({
  kind: enumeration("PF2_OUTER_CLEANUP_PENDING"),
  parentPid: nullable(integer(Number.MAX_SAFE_INTEGER, 1)),
  childPid: nullable(integer(Number.MAX_SAFE_INTEGER, 1)),
  reason: text(96, /^pf2_[a-z0-9_]+$/),
});

function valid(schema, value) {
  switch (schema.type) {
    case "enum": return schema.values.includes(value);
    case "integer": return Number.isSafeInteger(value) && value >= schema.min && value <= schema.max;
    case "text": return typeof value === "string" && value.length <= schema.max && schema.pattern.test(value);
    case "nullable": return value === null || valid(schema.value, value);
    case "union": return schema.values.some(item => valid(item, value));
    case "tuple": return Array.isArray(value) && value.length === schema.items.length &&
      schema.items.every((item, i) => valid(item, value[i]));
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value).length === Object.keys(schema.fields).length &&
      Object.entries(schema.fields).every(([key, item]) =>
        Object.hasOwn(value, key) && valid(item, value[key]));
    default: return false;
  }
}

function encodedMaximum(schema) {
  switch (schema.type) {
    case "enum": return Math.max(...schema.values.map(value => JSON.stringify(value).length));
    case "integer": return String(schema.max).length;
    // Every allowed text alphabet is ASCII without quote/backslash/control bytes.
    case "text": return schema.max + 2;
    case "nullable": return Math.max(4, encodedMaximum(schema.value));
    case "union": return Math.max(...schema.values.map(encodedMaximum));
    case "tuple": return 2 + Math.max(0, schema.items.length - 1) +
      schema.items.reduce((total, item) => total + encodedMaximum(item), 0);
    case "object": return 2 + Math.max(0, Object.keys(schema.fields).length - 1) +
      Object.entries(schema.fields).reduce((total, [key, item]) =>
        total + JSON.stringify(key).length + 1 + encodedMaximum(item), 0);
    default: throw new Error("pf2_protocol_schema");
  }
}
export const REQUEST_BYTES = encodedMaximum(requestSchema) + 1;
export const RESPONSE_BYTES = encodedMaximum(responseSchema) + 1;
export const PUBLICATION_BYTES = encodedMaximum(publicationSchema) + 1;
export const NOTICE_BYTES = encodedMaximum(noticeSchema) + 1;
export const NOTICE_TOTAL_BYTES = 2 * NOTICE_BYTES; // one start and one pending notice
export const OUTER_RESULT_BYTES = encodedMaximum(outerSchema) + 1;
export const OUTER_PENDING_BYTES = encodedMaximum(outerPendingSchema) + 1;
export const TRANSPORT_RESERVATION = Object.freeze({
  parentResponseAccumulatorBytes: RESPONSE_BYTES,
  parentVisibleReadChunkBytes: RESPONSE_BYTES + 1,
  childRequestAccumulatorBytes: REQUEST_BYTES,
  childVisibleReadChunkBytes: REQUEST_BYTES + 1,
  parentRequestFrameBytes: REQUEST_BYTES,
  childResponseFrameBytes: RESPONSE_BYTES,
  parentPublicationFrameBytes: PUBLICATION_BYTES,
  // Receiver text + sender stringify text can coexist at each endpoint.
  materializedTextCodeUnits: 2 * (REQUEST_BYTES + RESPONSE_BYTES + PUBLICATION_BYTES),
  stderrVisibleProbeBytes: 8192,
  // Object graphs, source frames and Node/kernel-private queues remain distinct
  // ledger terms; this is NOT a complete combined-memory reservation.
});
export const OUTER_RESERVATION = Object.freeze({
  publicationAccumulatorBytes: PUBLICATION_BYTES,
  publicationVisibleReadChunkBytes: PUBLICATION_BYTES + 1,
  noticeAccumulatorBytes: NOTICE_BYTES,
  noticeVisibleReadChunkBytes: 1,
  noticeForwardingBytes: NOTICE_TOTAL_BYTES,
  pendingNoticeBytes: OUTER_PENDING_BYTES,
  resultFrameBytes: OUTER_RESULT_BYTES,
  // Source-visible text only. Parsed objects, hashes, process/event records,
  // cleanup closures and native queues still require the complete ledger.
  textCodeUnits: PUBLICATION_BYTES + NOTICE_TOTAL_BYTES + OUTER_PENDING_BYTES + OUTER_RESULT_BYTES,
});
export const KNOWN_TRANSPORT_VALUE_BYTES =
  REQUEST_BYTES * 3 + RESPONSE_BYTES * 3 + PUBLICATION_BYTES +
  2 + 1 + 2 * TRANSPORT_RESERVATION.materializedTextCodeUnits +
  2 * PUBLICATION_BYTES + 1 + NOTICE_BYTES + 1 + NOTICE_TOTAL_BYTES +
  OUTER_PENDING_BYTES + OUTER_RESULT_BYTES + 2 * OUTER_RESERVATION.textCodeUnits;

export function validateTrial(value) {
  if (!valid(TRIAL_SCHEMA, value)) throw new Error("pf2_result_schema");
  if (value.status !== "PASS" && value.status !== "UNKNOWN") return value;
  if (value.target.status !== value.status ||
      (value.status === "PASS") !== (value.target.finiteEndpoint !== null))
    throw new Error("pf2_target_status_schema");
  value.controls.forEach((item, i) => {
    const expected = CONTROLS[i];
    if ((expected.helper.exact.rows !== undefined && item.rows !== expected.helper.exact.rows) ||
        (expected.helper.exact.peak !== undefined && item.peakRows !== expected.helper.exact.peak) ||
        (expected.oracle.exactMemo !== null && item.oracleNodes !== expected.oracle.exactMemo))
      throw new Error("pf2_summary_identity");
  });
  const valueEndpoint = value.target.finiteEndpoint;
  if (valueEndpoint && valueEndpoint.chosen !== [0, 1, 2].find(color => valueEndpoint.mask & (1 << color)))
    throw new Error("pf2_result_mask_schema");
  return value;
}
function encode(schema, value) {
  if (!valid(schema, value)) throw new Error("pf2_protocol_schema");
  const frame = Buffer.from(`${JSON.stringify(value)}\n`, "ascii");
  if (frame.length > encodedMaximum(schema) + 1) throw new Error("pf2_protocol_size");
  return frame;
}
function decode(schema, frame) {
  if (frame.length > encodedMaximum(schema) + 1 || frame.at(-1) !== 10 ||
      frame.subarray(0, -1).includes(10) || frame.some(byte => byte > 127))
    throw new Error("pf2_protocol_frame");
  const value = JSON.parse(frame.toString("ascii"));
  if (!valid(schema, value)) throw new Error("pf2_protocol_schema");
  // Canonical encoding rejects duplicate keys, alternate spellings and whitespace.
  if (!encode(schema, value).equals(frame)) throw new Error("pf2_protocol_noncanonical");
  return value;
}
export const encodeRequest = value => encode(requestSchema, value);
export const decodeRequest = frame => decode(requestSchema, frame);
export const encodeResponse = value => {
  validateTrial(value.result);
  return encode(responseSchema, value);
};
export const decodeResponse = frame => {
  const value = decode(responseSchema, frame);
  validateTrial(value.result);
  return value;
};
export function appendStderrPrefix(prefix, chunk) {
  const remaining = 8192 - prefix.length;
  const next = prefix + chunk.subarray(0, remaining).toString("latin1");
  return { prefix: next,
    failure: chunk.length > remaining && !next.includes(OOM_BANNER_SUBSTRING)
      ? { status: "FAIL", reason: "pf2_child_stderr_overflow", evaluatorCalls: null } : null };
}
export function classifyChildClose({ code, signal, stderrPrefix, expired, frame, nonce, pending = null }) {
  const outcome = (status, reason) => ({ status, reason, evaluatorCalls: null });
  if (pending?.status === "FAIL") return pending;
  if (stderrPrefix.length && !stderrPrefix.includes(OOM_BANNER_SUBSTRING))
    return outcome("FAIL", "pf2_child_stderr");
  if (pending) return pending;
  const abnormal = signal !== null || ![0, 1, 2].includes(code);
  let message;
  if (frame?.at(-1) === 10) {
    try { message = decodeResponse(frame); }
    catch { return outcome("FAIL", "pf2_child_protocol"); }
    if (message.nonce !== nonce) return outcome("FAIL", "pf2_child_nonce");
    if (message.result.status === "FAIL") return message.result;
  }
  if (abnormal && stderrPrefix.includes(OOM_BANNER_SUBSTRING))
    return outcome("NOTRUN", "pf2_heap_cap");
  if (abnormal) return outcome("FAIL", "pf2_child_abnormal_exit");
  if (stderrPrefix.length) return outcome("FAIL", "pf2_child_stderr");
  if (expired) return outcome("NOTRUN", "pf2_parent_deadline");
  if (!message) return outcome("FAIL", "pf2_child_protocol");
  if (code === 2) return outcome("NOTRUN", "pf2_child_no_commit");
  if (code !== 0 || !["PASS", "UNKNOWN"].includes(message.result.status))
    return outcome("FAIL", "pf2_child_exit_contract");
  return message.result;
}
export const encodePublication = value => {
  validateTrial(value.result);
  return encode(publicationSchema, value);
};
// For cleanup diagnostics only; this is NOT an acceptance/commit operation.
export function inspectPublication(frame) {
  const value = decode(publicationSchema, frame);
  validateTrial(value.result);
  return value;
}
export const encodeNotice = value => encode(noticeSchema, value);
export const decodeNotice = frame => decode(noticeSchema, frame);
export const encodeOuterPending = value => encode(outerPendingSchema, value);
export function cleanNodeEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment)
    .filter(([name]) => !/^(NODE_|UV_)/i.test(name)));
}
export function encodeOuterResult(value) {
  validateTrial(value.result);
  if (["PASS", "UNKNOWN"].includes(value.result.status) &&
      (!value.cleanup.parentCloseObserved || !value.cleanup.childCleanupConfirmed ||
       value.cleanup.operatorActionRequired))
    throw new Error("pf2_outer_cleanup_commit");
  return encode(outerSchema, value);
}
export function decodeOuterResult(frame, runnerExitCode) {
  const value = decode(outerSchema, frame);
  // Reuse successful cleanup requirements as well as canonical framing.
  encodeOuterResult(value);
  const expectedCode = value.result.status === "FAIL" ? 1 :
    value.result.status === "NOTRUN" ? 2 : 0;
  if (runnerExitCode !== expectedCode) throw new Error("pf2_outer_exit_contract");
  return value;
}
export function acceptPublication(frame, parentExitCode, expectedRunnerToken) {
  // Exit is the commit signal. NEVER use stdout alone as a certificate.
  // Any partial/late frame is discarded atomically by this interpretation.
  if (parentExitCode === 2) {
    try {
      const value = inspectPublication(frame);
      if (expectedRunnerToken !== undefined && value.runnerToken !== expectedRunnerToken)
        return { status: "FAIL", reason: "pf2_runner_token", evaluatorCalls: null };
      if (value.result.status === "NOTRUN" || value.result.status === "FAIL")
        return value.result; // validated diagnostic only, never a success commit
    } catch { /* A partial frame cannot supply a diagnostic reason. */ }
    return { status: "NOTRUN", reason: "pf2_parent_no_commit", evaluatorCalls: null };
  }
  if (parentExitCode !== 0)
    return { status: "FAIL", reason: "pf2_parent_abnormal_exit", evaluatorCalls: null };
  try {
    const value = decode(publicationSchema, frame);
    if (expectedRunnerToken !== undefined && value.runnerToken !== expectedRunnerToken)
      throw new Error("pf2_runner_token");
    validateTrial(value.result);
    if (!["PASS", "UNKNOWN"].includes(value.result.status) || !value.preservation ||
        value.preservation.before !== value.preservation.after ||
        !value.cleanup.childStarted || !value.cleanup.closeObserved || value.cleanup.stopRequested)
      throw new Error("pf2_publication_commit");
    return value.result;
  } catch {
    return { status: "FAIL", reason: "pf2_invalid_committed_publication", evaluatorCalls: null };
  }
}

export function boundedFrameReader(stream, capacity, onOverflow) {
  const buffer = Buffer.alloc(capacity);
  let size = 0;
  let exceeded = false;
  stream.on("readable", () => {
    if (exceeded) return;
    let chunk;
    while ((chunk = stream.read(Math.min(capacity - size + 1, capacity + 1))) !== null) {
      if (size + chunk.length > capacity) {
        exceeded = true;
        onOverflow();
        return;
      }
      chunk.copy(buffer, size);
      size += chunk.length;
    }
  });
  return () => {
    if (exceeded) throw new Error("pf2_protocol_overflow");
    return buffer.subarray(0, size);
  };
}

// Immediate bounded progress notices, not trial results. One-byte visible reads
// avoid an unbounded 'data' chunk and allow reporting before stream EOF.
export function boundedNoticeReader(stream, onNotice, onInvalid) {
  const buffer = Buffer.alloc(NOTICE_BYTES);
  let size = 0, total = 0, invalid = false, started = false, pending = false;
  let childPid = null;
  const fail = () => {
    if (!invalid) { invalid = true; onInvalid(); }
  };
  stream.on("readable", () => {
    if (invalid) return;
    let byte;
    while ((byte = stream.read(1)) !== null) {
      if (++total > NOTICE_TOTAL_BYTES || size >= NOTICE_BYTES) { fail(); return; }
      buffer[size++] = byte[0];
      if (byte[0] !== 10) continue;
      try {
        const notice = decodeNotice(buffer.subarray(0, size));
        if (notice.kind === "PF2_CHILD_STARTED") {
          if (started || pending) throw new Error("pf2_notice_order");
          started = true;
          childPid = notice.pid;
        } else {
          if (pending || (started && notice.pid !== childPid)) throw new Error("pf2_notice_order");
          pending = true;
          childPid = notice.pid;
        }
        size = 0;
        onNotice(notice);
      } catch { fail(); return; }
    }
  });
  return () => {
    if (invalid || size !== 0) throw new Error("pf2_notice_frame");
    return { childPid, pending };
  };
}
