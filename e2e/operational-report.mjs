import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { approvedNames, suiteSources } from "./operational-case-map.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), "stack")?.get;
const statuses = new Set(["passed", "failed", "skipped", "timedOut", "interrupted"]);
const suites = ["numerical-boundary", "production-policy", "analytics-policy"];
const fail = () => { throw new Error("OPERATIONAL_REPORT_INVALID"); };
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export function privateRoot() {
  const value = process.env.OPERATIONAL_PRIVATE_RESULTS_DIR;
  if (!value || !isAbsolute(value) || resolve(value) !== value) fail();
  // Reject link traversal, including ancestor links and Windows junctions.
  for (let path = value; ; path = dirname(path)) {
    if (lstatSync(path).isSymbolicLink()) fail();
    if (dirname(path) === path) break;
  }
  const actual = realpathSync(value);
  const rel = relative(root, actual);
  if (!rel || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) fail();
  if (!lstatSync(actual).isDirectory()) fail();
  return actual;
}

export function privateDirectory(name) {
  if (!["numerical-boundary-cache", "production-policy-artifacts", "analytics-policy-artifacts",
    "production-policy-worker"].includes(name)) fail();
  const path = join(privateRoot(), name);
  mkdirSync(path, { recursive: true });
  if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) fail();
  return path;
}

export function validateObserved(ids, observed, finished) {
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length ||
      ids.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) ||
      !Array.isArray(observed) || typeof finished !== "boolean") fail();
  const seen = new Set();
  for (const item of observed) {
    if (!item || Object.keys(item).sort().join(",") !== "attempts,id,status" ||
        !ids.includes(item.id) || seen.has(item.id) || !statuses.has(item.status) ||
        !Number.isSafeInteger(item.attempts) || item.attempts < 0) fail();
    seen.add(item.id);
  }
  return {
    cases: observed,
    complete: finished && seen.size === ids.length &&
      observed.every(item => item.status === "passed" && item.attempts === 1),
  };
}

export function loadApproval(suiteId) {
  if (!suites.includes(suiteId)) fail();
  const bytes = readFileSync(join(root, "e2e/operational-inventory.json"));
  const inventory = JSON.parse(bytes);
  const bindings = JSON.parse(readFileSync(join(root, "e2e/operational-source-bindings.json"), "utf8"));
  if (inventory.schemaVersion !== 1 || bindings.schemaVersion !== 1 ||
      bindings.inventoryDigest !== sha256(bytes)) fail();
  for (const [file, digest] of Object.entries(bindings.sources)) {
    if (!/^[a-f0-9]{64}$/.test(digest) || sha256(readFileSync(join(root, file))) !== digest) fail();
  }
  const ids = inventory.suites[suiteId];
  if (approvedNames[suiteId].length !== ids.length ||
      new Set(approvedNames[suiteId]).size !== ids.length) fail();
  return { ids, digest: sha256(bytes), names: approvedNames[suiteId], source: suiteSources[suiteId] };
}

export function writeSuite(suiteId, approval, observed, finished) {
  const checked = validateObserved(approval.ids, observed, finished);
  const bytes = JSON.stringify({
    schemaVersion: 1, suiteId, inventoryDigest: approval.digest, ...checked,
  });
  if (Buffer.byteLength(bytes) > 256 * 1024) fail();
  writeFileSync(join(privateRoot(), `${suiteId}.json`), bytes, { flag: "wx", mode: 0o600 });
  return checked.complete;
}

export function writeDiagnostic(suiteId, entries) {
  if (!suites.includes(suiteId)) fail();
  const bytes = diagnosticJson({ schemaVersion: 1, entries });
  writeFileSync(join(privateRoot(), `${suiteId}-diagnostics.json`), bytes, { flag: "wx", mode: 0o600 });
}

export function diagnosticJson(value) {
  let remaining = 512 * 1024, nodes = 8192;
  const ancestors = new WeakSet();
  function text(value) {
    const bytes = Buffer.from(value);
    const limit = Math.max(0, Math.min(64 * 1024, remaining));
    const result = bytes.subarray(0, limit).toString("utf8");
    remaining -= Buffer.byteLength(result);
    return bytes.length > limit ? result + "[TRUNCATED]" : result;
  }
  function visit(value, depth) {
    remaining -= 16;
    if (--nodes < 0 || remaining < 0 || depth > 24) return "[TRUNCATED]";
    if (typeof value === "string") return text(value);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
    if (typeof value === "bigint") return { bigint: text(String(value)) };
    if (typeof value !== "object") return `[${typeof value}]`;
    if (ancestors.has(value)) return "[CYCLE]";
    ancestors.add(value);
    try {
      const result = Array.isArray(value) ? [] : Object.create(null);
      const keys = Reflect.ownKeys(value).filter(key => typeof key === "string" && key !== "length");
      for (const key of keys.slice(0, 128)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        // V8's own lazy stack accessor is not an arbitrary supplied getter.
        const item = descriptor && "value" in descriptor
          ? visit(descriptor.value, depth + 1)
          : key === "stack" && value instanceof Error && nativeStackGetter &&
            descriptor?.get === nativeStackGetter
            ? visit(nativeStackGetter.call(value), depth + 1) : "[ACCESSOR]";
        if (Array.isArray(result)) result.push(item);
        else result[text(key)] = item;
      }
      if (keys.length > 128) {
        if (Array.isArray(result)) result.push("[TRUNCATED]");
        else result.truncatedKeys = keys.length - 128;
      }
      return result;
    } finally { ancestors.delete(value); }
  }
  const bytes = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(bytes) > 1024 * 1024)
    return '{"schemaVersion":1,"truncated":true,"entries":[]}';
  return bytes;
}

export class DiagnosticStream {
  chunks = [];
  bytes = 0;
  overflow = false;
  push(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const remaining = 128 * 1024 - this.bytes;
    if (remaining > 0) this.chunks.push(bytes.subarray(0, remaining));
    this.bytes += Math.min(bytes.length, Math.max(0, remaining));
    this.overflow ||= bytes.length > remaining;
  }
  text() { return Buffer.concat(this.chunks, this.bytes).toString("utf8"); }
}

export function recordOutboundViolation() {
  writeFileSync(join(privateRoot(), "production-policy-outbound.json"),
    '{"schemaVersion":1,"prohibited":true}', { flag: "wx", mode: 0o600 });
}

export function hasOutboundViolation() {
  return existsSync(join(privateRoot(), "production-policy-outbound.json"));
}

export function approvedId(approval, file, name) {
  if (relative(root, resolve(file)).replaceAll("\\", "/") !== approval.source) fail();
  const index = approval.names.indexOf(name);
  if (index < 0) fail();
  return approval.ids[index];
}
