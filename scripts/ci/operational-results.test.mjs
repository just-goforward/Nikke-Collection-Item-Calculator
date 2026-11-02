import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CaptureLedger, publicResult, validateSuite } from './operational-results.mjs';

const inventory = Buffer.from(JSON.stringify({ schemaVersion: 1, suites: {
  'numerical-boundary': ['N01', 'N02'], 'production-policy': ['P01'], 'analytics-policy': ['A01']
} }));
const digest = createHash('sha256').update(inventory).digest('hex');
const base = () => ({ schemaVersion: 1, suiteId: 'numerical-boundary', inventoryDigest: digest,
  cases: ['N01', 'N02'].map(id => ({ id, status: 'passed', attempts: 1 })), complete: true });
const validate = report => validateSuite(Buffer.from(JSON.stringify(report)), inventory, digest, 'numerical-boundary');

test('accepts exactly the independently approved inventory', () => {
  assert.deepEqual(validate(base()), { suiteId: 'numerical-boundary', passed: 2 });
  assert.throws(() => validateSuite(Buffer.from('{}'), inventory, '0'.repeat(64), 'numerical-boundary'), /ADMISSION_BLOCKED/);
});
test('rejects malformed and incomplete results and inventory drift', () => {
  for (const mutate of [
    r => { r.title = 'private'; }, r => { r.cases[0].attempts = 2; },
    r => { r.cases.push(r.cases[0]); }, r => { r.cases[0].id = 'EXTRA'; }
  ]) {
    const r = base(); mutate(r); assert.throws(() => validate(r), /MALFORMED/);
  }
  for (const mutate of [r => { r.complete = false; }, r => { r.cases.pop(); },
    r => { r.cases[0].status = 'skipped'; }]) {
    const r = base(); mutate(r); assert.throws(() => validate(r), /INCOMPLETE/);
  }
});
test('timeout cancellation and test failures do not pass', () => {
  for (const [status, code] of [['timedOut', 'TIMEOUT'], ['interrupted', 'CANCELLED'], ['failed', 'TEST_FAILED']]) {
    const r = base(); r.cases[0].status = status;
    assert.throws(() => validate(r), new RegExp(code));
  }
});
test('capture is bounded and preserves first failure including source mutation', () => {
  const ledger = new CaptureLedger(); ledger.begin('S01');
  assert.equal(ledger.capture('S01', 'stdout', Buffer.alloc(2 * 1024 * 1024)), true);
  assert.equal(ledger.capture('S01', 'stdout', Buffer.from('secret')), false);
  assert.equal(ledger.reject('CANCELLED'), 'OVERFLOW');
  const mutated = new CaptureLedger();
  assert.equal(mutated.reject('SOURCE_MUTATION'), 'SOURCE_MUTATION');
  assert.equal(mutated.reject('TIMEOUT'), 'SOURCE_MUTATION');
  const aggregate = new CaptureLedger();
  for (let i = 0; i < 17; i++) {
    aggregate.begin(`S${i}`);
    aggregate.capture(`S${i}`, 'stderr', Buffer.alloc(2 * 1024 * 1024));
  }
  assert.equal(aggregate.failure, 'OVERFLOW');
});
test('public serialization refuses free text and incomplete success', () => {
  const args = { candidateDigest: digest, manifestDigest: digest, inventoryDigest: digest, failure: 'ADMISSION_BLOCKED',
    stages: [{ id: 'S01', durationMs: 0, passed: 0, status: 'incomplete' }] };
  const result = JSON.parse(publicResult(args));
  assert.equal(result.failure, 'ADMISSION_BLOCKED');
  assert.equal(result.status, 'failed');
  assert.throws(() => publicResult({ ...args, failure: null }), /INCOMPLETE/);
  assert.throws(() => publicResult({ ...args, stages: [{ ...args.stages[0], title: 'https://secret/' }] }), /MALFORMED/);
  assert.throws(() => publicResult({ ...args, failure: 'private error' }), /MALFORMED/);
  assert.throws(() => validateSuite(Buffer.alloc(256 * 1024 + 1), inventory, digest, 'numerical-boundary'), /OVERFLOW/);
});
test('first failure preserves a bounded cleanup allowance inside the total raw cap', () => {
  const ledger = new CaptureLedger({ reserveCleanup: true });
  ledger.reject('TEST_FAILED');
  for (let i = 0; i < 14; i++) {
    const id = `P${i}`; ledger.begin(id);
    assert.equal(ledger.capture(id, 'stdout', Buffer.alloc(2 * 1024 * 1024)), true);
  }
  ledger.begin('EXTRA');
  assert.equal(ledger.capture('EXTRA', 'stdout', Buffer.from('private')), false);
  ledger.begin('S15');
  assert.equal(ledger.capture('S15', 'stdout', Buffer.alloc(2 * 1024 * 1024)), true);
  assert.equal(ledger.capture('S15', 'stderr', Buffer.alloc(2 * 1024 * 1024)), true);
  assert.equal(ledger.capture('S15', 'stderr', Buffer.from('extra')), false);
  assert.equal(ledger.failure, 'TEST_FAILED');
});
