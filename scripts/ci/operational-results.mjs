import { createHash } from 'node:crypto';

const SUITES = new Set(['numerical-boundary', 'production-policy', 'analytics-policy']);
const HEX = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const CODES = new Set(['MALFORMED', 'TIMEOUT', 'OVERFLOW', 'CANCELLED', 'INCOMPLETE',
  'TEST_FAILED', 'SOURCE_MUTATION', 'ADMISSION_BLOCKED']);
const LIMIT = 256 * 1024;
function fail(code) { throw new Error(code); }
function keys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) fail('MALFORMED');
}
function parse(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > LIMIT) fail('OVERFLOW');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('MALFORMED'); }
}

// expectedDigest must come from the detached approval, never a framework result.
export function validateSuite(bytes, approvedInventoryBytes, expectedDigest, suiteId) {
  if (!HEX.test(expectedDigest) || !SUITES.has(suiteId)) fail('MALFORMED');
  if (createHash('sha256').update(approvedInventoryBytes).digest('hex') !== expectedDigest) fail('ADMISSION_BLOCKED');
  const inventory = parse(approvedInventoryBytes);
  keys(inventory, ['schemaVersion', 'suites']);
  if (inventory.schemaVersion !== 1) fail('MALFORMED');
  keys(inventory.suites, [...SUITES]);
  for (const ids of Object.values(inventory.suites)) {
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !ID.test(id)) ||
        new Set(ids).size !== ids.length) fail('MALFORMED');
  }
  const report = parse(bytes);
  keys(report, ['schemaVersion', 'suiteId', 'inventoryDigest', 'cases', 'complete']);
  if (report.schemaVersion !== 1 || report.suiteId !== suiteId ||
      report.inventoryDigest !== expectedDigest || !Array.isArray(report.cases) ||
      typeof report.complete !== 'boolean') fail('MALFORMED');
  const wanted = new Set(inventory.suites[suiteId]);
  const seen = new Set();
  let firstFailure = null;
  for (const item of report.cases) {
    keys(item, ['id', 'status', 'attempts']);
    if (!wanted.has(item.id) || seen.has(item.id) ||
        !Number.isSafeInteger(item.attempts) || item.attempts !== 1 ||
        !['passed', 'failed', 'skipped', 'timedOut', 'interrupted'].includes(item.status)) fail('MALFORMED');
    seen.add(item.id);
    if (item.status !== 'passed') firstFailure ??= ({
      failed: 'TEST_FAILED', skipped: 'INCOMPLETE', timedOut: 'TIMEOUT', interrupted: 'CANCELLED'
    })[item.status];
  }
  if (!report.complete || seen.size !== wanted.size) fail('INCOMPLETE');
  if (firstFailure) fail(firstFailure);
  return { suiteId, passed: seen.size };
}

// This ledger only accounts capture; the host supervisor must terminate the
// owned namespace on a rejected write. No child bytes are retained or emitted.
export class CaptureLedger {
  #total = 0;
  #producerTotal = 0;
  #reserveCleanup;
  #stages = new Map();
  #failure = null;
  constructor({ reserveCleanup = false } = {}) {
    if (typeof reserveCleanup !== 'boolean') fail('MALFORMED');
    this.#reserveCleanup = reserveCleanup;
  }
  get failure() { return this.#failure; }
  reject(code) {
    if (!CODES.has(code)) fail('MALFORMED');
    this.#failure ??= code;
    return this.#failure;
  }
  begin(id) {
    if (!ID.test(id) || this.#stages.has(id)) fail('MALFORMED');
    this.#stages.set(id, { stdout: 0, stderr: 0 });
  }
  capture(id, stream, bytes) {
    const stage = this.#stages.get(id);
    if (!stage || !['stdout', 'stderr'].includes(stream) || !Buffer.isBuffer(bytes)) fail('MALFORMED');
    const producer = !this.#reserveCleanup || id !== 'S15';
    if (stage[stream] + bytes.length > 2 * 1024 * 1024 ||
        this.#total + bytes.length > 32 * 1024 * 1024 ||
        (this.#reserveCleanup && producer && this.#producerTotal + bytes.length > 28 * 1024 * 1024)) {
      this.reject('OVERFLOW');
      return false;
    }
    stage[stream] += bytes.length;
    this.#total += bytes.length;
    if (producer) this.#producerTotal += bytes.length;
    // A previous test failure must not disable bounded cleanup control reads.
    return true;
  }
}

export function publicResult({ candidateDigest, manifestDigest, inventoryDigest, failure, stages }) {
  if (![candidateDigest, manifestDigest, inventoryDigest].every(v => typeof v === 'string' && HEX.test(v)) ||
      (failure !== null && !CODES.has(failure)) || !Array.isArray(stages)) fail('MALFORMED');
  const seen = new Set();
  const safeStages = stages.map(stage => {
    keys(stage, ['id', 'durationMs', 'passed', 'status']);
    if (typeof stage.id !== 'string' || !ID.test(stage.id) || seen.has(stage.id) ||
        !Number.isSafeInteger(stage.durationMs) || stage.durationMs < 0 ||
        !Number.isSafeInteger(stage.passed) || stage.passed < 0 ||
        !['passed', 'failed', 'incomplete'].includes(stage.status)) fail('MALFORMED');
    seen.add(stage.id);
    return { ...stage };
  });
  if (!safeStages.length || (failure === null && safeStages.some(s => s.status !== 'passed'))) fail('INCOMPLETE');
  const bytes = Buffer.from(JSON.stringify({
    schemaVersion: 1, candidateDigest, manifestDigest, inventoryDigest,
    status: failure === null ? 'passed' : 'failed', failure, stages: safeStages
  }));
  if (bytes.length > LIMIT) fail('OVERFLOW');
  return bytes;
}
