import { CertifiedLimit } from "../certified/budget";
import { KIT_INDICES } from "../certified/game";
import type { WasmKernel } from "../certified/wasmBackend";
import { assertJointSourceModelBinding, certifyJointSourcePlan } from "./sourcePlan";
import type { JointSource, JointSourceEvent, JointSourcePlan } from "./types";
import { validate } from "../certified/validation";

type Exports = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  certified_input(length: number): number;
  certified_output_ptr(): number;
  certified_output_len(): number;
  certified_joint_version(): number;
  certified_joint_begin(): number;
  certified_joint_next(): number;
};
function assertJointExports(exports: WebAssembly.Exports): asserts exports is Exports {
  if (!(exports["memory"] instanceof WebAssembly.Memory) ||
    ["certified_input", "certified_output_ptr", "certified_output_len",
      "certified_joint_version", "certified_joint_begin", "certified_joint_next"]
      .some((name) => typeof exports[name] !== "function"))
    throw new Error("joint_source_stream_contract");
}
const NONE = 0xffffffff;
const MAX_CHUNK = 24 + 32 * 20 + 4096;
// Includes copied bytes, decoded UTF-16/JSON, rows and tuple object headroom.
// Kept charged until AFTER the consumer's nested FUSED call returns.
const CHUNK_WORKSPACE = MAX_CHUNK + 32 * 256 + 4096 * 16;
const LIMITS: Readonly<Record<string, true>> = {
  request_budget_exhausted: true, joint_source_work_limit: true, joint_source_memory_limit: true,
  joint_source_integer_limit: true, managed_payload_ceiling: true, certified_supply_support_limit: true, exact_support_limit: true,
};
const ERRORS: Readonly<Record<string, true>> = {
  joint_source_contract: true, joint_source_lifecycle: true, certified_law_raw_pieces_invalid: true,
};
export function isJointSourceLimitReason(reason: string): boolean {
  return Object.hasOwn(LIMITS, reason);
}
/** Only orderly resource stops can authenticate a committed prefix; traps cannot. */
export function isCertifiedPrefixStop(reason:string|null):boolean {
  return reason!==null && (isJointSourceLimitReason(reason) ||
    /^(rust_heap_payload_ceiling|wasm_linear_memory_ceiling|exact_memo_limit|response_payload_ceiling)$/.test(reason));
}
function contract(): never { throw new Error("joint_source_stream_contract"); }

/** Small owned chunks only. There is no date/15-day distribution in JS. The
 * native ABI call has returned before consume runs, and no WASM-backed view is
 * retained across that callback (which can grow memory and overwrite OUTPUT). */
export function openJointSource(kernel: WasmKernel, plan: JointSourcePlan): JointSource {
  assertJointSourceModelBinding(plan, kernel.getPreparedSourceInput(), kernel.budget);
  certifyJointSourcePlan(plan, validate(kernel.getPreparedSourceInput(), () => kernel.budget.checkNumerical()), kernel.budget);
  let started = false, disposed = false, reading = false, done = false;
  let phase: "init" | "date" | "mixture" | "rows" | "end" | "ack" | "done" = "init";
  let day = 1, lastAcked = 0, expectedRows = 0, seenRows = 0;

  function decode(bytes: Uint8Array, status: number): JointSourceEvent {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 24 || view.getUint32(0, true) !== 0x3253514a) contract();
    const kind = view.getUint32(4, true), d = view.getUint32(8, true), c = view.getUint32(12, true);
    const rows = view.getUint32(16, true), metadataBytes = view.getUint32(20, true);
    if (rows > 32 || metadataBytes > 4096 || 24 + rows * 20 + metadataBytes !== bytes.length ||
      (kind !== 3 && rows !== 0) || ![0, 1, 2].includes(status)) contract();
    let metadata: unknown = null;
    if (metadataBytes) {
      try { metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(24 + rows * 20))); }
      catch { contract(); }
    }
    if (kind === 7) {
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
        Object.keys(metadata).length !== 2 || !Object.hasOwn(metadata, "reason") || !Object.hasOwn(metadata, "lastAckedDay")) contract();
      const reason: unknown = Reflect.get(metadata, "reason"), ack: unknown = Reflect.get(metadata, "lastAckedDay");
      if (typeof reason !== "string" || ack !== lastAcked || d !== lastAcked || c !== NONE ||
        !(status === 1 ? isJointSourceLimitReason(reason) : status === 2 && Object.hasOwn(ERRORS, reason))) contract();
      done = true;
      return { kind: "error", reason, lastAckedDay: lastAcked };
    }
    if (status !== 0 || (kind !== 2 && metadataBytes !== 0)) contract();
    if (kind === 0) {
      if (phase !== "init" || d !== 0 || c !== NONE) contract();
      phase = "date";
      return { kind: "init", streamKind: "prior-mixture" };
    }
    if (kind === 6) {
      if (phase !== "done" || d !== 14 || c !== NONE || lastAcked !== 14) contract();
      done = true;
      return { kind: "done" };
    }
    if (d !== day || day > 14) contract();
    if (kind === 1) {
      if (phase !== "date" || c !== NONE) contract();
      phase = "mixture";
      return { kind: "date_begin", day };
    }
    if (kind === 5) {
      if (phase !== "end" || c !== NONE) contract();
      phase = "ack";
      return { kind: "date_end", day };
    }
    if (c !== NONE) contract();
    const bounds = plan.dates[day];
    if (!bounds) contract();
    if (kind === 2) {
      if (phase !== "mixture" || !metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
        Object.keys(metadata).length !== 1 || !Object.hasOwn(metadata, "rowCount")) contract();
      const count: unknown = Reflect.get(metadata, "rowCount");
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > 1_000_000) contract();
      expectedRows = count;
      seenRows = 0;
      phase = "rows";
      return { kind: "mixture_begin", day, rowCount: count };
    }
    if (kind === 3) {
      if (phase !== "rows" || rows === 0 || seenRows + rows > expectedRows) contract();
      const decoded: { units: [number, number, number]; mass: number }[] = [];
      for (let i = 0; i < rows; i++) {
        const offset = 24 + i * 20;
        const units: [number, number, number] = [view.getUint32(offset, true), view.getUint32(offset + 4, true), view.getUint32(offset + 8, true)];
        const mass = view.getFloat64(offset + 12, true);
        if (!Number.isFinite(mass) || mass <= 0 || mass > 1 ||
          KIT_INDICES.some((k) => units[k] < bounds.minUnits[k] || units[k] > bounds.maxUnits[k])) contract();
        decoded.push({ units, mass });
      }
      seenRows += rows;
      return { kind: "rows", day, rows: decoded };
    }
    if (kind === 4) {
      if (phase !== "rows" || seenRows !== expectedRows) contract();
      phase = "end";
      return { kind: "mixture_end", day };
    }
    return contract();
  }

  return {
    read(consume) {
      if (disposed || reading) contract();
      if (done) return "done";
      if (phase === "ack") contract();
      reading = true;
      let inputWorkspace = 0;
      try {
        kernel.budget.reserve(CHUNK_WORKSPACE);
        kernel.budget.check();
        // Identities, projection and independently certified windows/errors;
        // never producer-supplied evaluated probability laws.
        const command = started ? null : JSON.stringify({ algorithm: plan.algorithm, sourceIdentity: plan.sourceIdentity,
          sourceKey: plan.sourceKey, projectionKey: plan.projectionKey, sid: plan.sid, stock: plan.stock,
          windows: plan.dates.slice(1).map(date => date.window),
          sourceErrorBounds: plan.dates.slice(1).map(date => date.sourceL1Upper),
          hostPerformedWork: plan.hostPerformedWork });
        inputWorkspace = command === null ? 0 : command.length * 5 + 256;
        kernel.budget.reserve(inputWorkspace);
        const event = kernel.withBinaryRequest((raw) => {
          assertJointExports(raw);
          const exports = raw;
          if (exports.certified_joint_version() !== 2) contract();
          let status: number;
          if (command !== null) {
            const input = new TextEncoder().encode(command);
            if (input.length > 4096) contract();
            const pointer = exports.certified_input(input.length);
            if (!pointer) throw new CertifiedLimit("managed_payload_ceiling");
            new Uint8Array(exports.memory.buffer, pointer, input.length).set(input);
            status = exports.certified_joint_begin();
            started = true;
          } else status = exports.certified_joint_next();
          const length = exports.certified_output_len(), pointer = exports.certified_output_ptr();
          if (!Number.isInteger(length) || length < 24 || length > MAX_CHUNK || !Number.isInteger(pointer) ||
            pointer < 0 || pointer + length > exports.memory.buffer.byteLength) contract();
          // This allocation is covered by CHUNK_WORKSPACE before WASM entry.
          const copied = new Uint8Array(exports.memory.buffer, pointer, length).slice();
          return decode(copied, status);
        });
        consume(event);
        return "event";
      } finally {
        kernel.budget.release(inputWorkspace);
        kernel.budget.release(CHUNK_WORKSPACE);
        reading = false;
      }
    },
    ackDate(value) {
      if (disposed || done || phase !== "ack" || value !== day) contract();
      const status = kernel.ackSourceDate(value);
      if (status === 1) throw new CertifiedLimit("request_budget_exhausted");
      if (status !== 0) contract();
      lastAcked = day;
      day++;
      phase = lastAcked === 14 ? "done" : "date";
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // Cleanup only: no renewed clock and no source-owner/Engine teardown.
      kernel.cleanupSourcePart("joint");
    },
  };
}
