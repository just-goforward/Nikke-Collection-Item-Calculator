import { HEX, exactKeys, fail, sha256, SUITE_STAGES } from './operational-policy.mjs';

export const RECEIPT_LIMIT = 256 * 1024;
export const FINALIZER_EXIT = Object.freeze({
  SOURCE_MUTATION: 73, MALFORMED: 74, INCOMPLETE: 75, TEST_FAILED: 76,
  TIMEOUT: 77, OVERFLOW: 78, ADMISSION_BLOCKED: 79, CANCELLED: 80,
});
const magic = Buffer.from('OPR1');
const fields = ['schemaVersion', 'nonce', 'candidateDigest', 'manifestDigest',
  'inventoryDigest', 'nodeInventoryDigest', 'sourceDigest', 'suites'];
export function receiptIdentity(a, manifestDigest, nonce) {
  return { nonce, candidateDigest: sha256(a.candidateSha), manifestDigest,
    inventoryDigest: a.inventoryDigest, nodeInventoryDigest: a.nodeInventoryDigest,
    sourceDigest: sha256(JSON.stringify(a.source)) };
}
function canonical(receipt) {
  exactKeys(receipt, fields);
  if (receipt.schemaVersion !== 1 ||
      fields.slice(1, -1).some(key => !HEX.test(receipt[key] ?? '')) ||
      !Array.isArray(receipt.suites)) fail('MALFORMED');
  const ids = Object.values(SUITE_STAGES);
  if (receipt.suites.length !== ids.length) fail('INCOMPLETE');
  const suites = receipt.suites.map((suite, index) => {
    exactKeys(suite, ['suiteId', 'passed']);
    if (suite.suiteId !== ids[index] || !Number.isSafeInteger(suite.passed) || suite.passed < 1) fail('MALFORMED');
    return { suiteId: suite.suiteId, passed: suite.passed };
  });
  return Object.fromEntries(fields.map(key => [key, key === 'suites' ? suites : receipt[key]]));
}
export function encodeReceipt(receipt) {
  const body = Buffer.from(JSON.stringify(canonical(receipt)));
  if (body.length + 8 > RECEIPT_LIMIT) fail('OVERFLOW');
  const header = Buffer.alloc(8);
  magic.copy(header); header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}
export function decodeReceipt(bytes, expected, expectedCounts) {
  if (!Buffer.isBuffer(bytes) || bytes.length > RECEIPT_LIMIT) fail('OVERFLOW');
  if (bytes.length < 8 || !bytes.subarray(0, 4).equals(magic) ||
      bytes.readUInt32BE(4) !== bytes.length - 8) fail('INCOMPLETE');
  let receipt;
  try { receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(8))); }
  catch { fail('MALFORMED'); }
  // The private protocol has one canonical encoding, prohibiting duplicate
  // keys, concatenated records, trailing whitespace and embedded free text.
  if (!encodeReceipt(receipt).equals(bytes)) fail('MALFORMED');
  for (const key of fields.slice(1, -1)) {
    if (receipt[key] !== expected[key]) fail('ADMISSION_BLOCKED');
  }
  for (const suite of receipt.suites) {
    if (suite.passed !== expectedCounts[suite.suiteId]) fail('INCOMPLETE');
  }
  return receipt;
}
