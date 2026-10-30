import { writeFile } from 'node:fs/promises';
import { resolve, relative, join, isAbsolute } from 'node:path';
import { readTrustedFile } from './operational-files.mjs';
import { CaptureLedger } from './operational-results.mjs';
import { HEX, sha256, fail, exactKeys, safePath } from './operational-policy.mjs';

export function nodeInventory(bytes, expectedDigest) {
  if (!HEX.test(expectedDigest ?? '') || sha256(bytes) !== expectedDigest) fail();
  const inventory = JSON.parse(bytes);
  exactKeys(inventory, ['schemaVersion', 'suites']);
  exactKeys(inventory.suites, ['profile-policy', 'node-runtime']);
  if (inventory.schemaVersion !== 1) fail();
  const ids = new Set(), bindings = new Set();
  for (const suite of Object.values(inventory.suites)) {
    if (!Array.isArray(suite) || !suite.length) fail();
    for (const row of suite) {
      if (!Array.isArray(row) || row.length !== 3 || !/^[FR][0-9]{3}$/.test(row[0]) ||
          !safePath(row[1]) || typeof row[2] !== 'string' || !row[2] ||
          ids.has(row[0]) || bindings.has(JSON.stringify(row.slice(1)))) fail();
      ids.add(row[0]); bindings.add(JSON.stringify(row.slice(1)));
    }
  }
  return inventory;
}
export async function nodeReport(events, rows, { root, suiteId, digest, capture = () => {} }) {
  const seen = new Map(), ledger = new CaptureLedger();
  ledger.begin('N01');
  let complete = false, invalid = false;
  for await (const event of events) {
    const data = event.data ?? {};
    if (['test:stdout', 'test:stderr'].includes(event.type)) {
      const stream = event.type.slice(5), bytes = Buffer.from(data.message ?? '');
      capture(stream, bytes);
      if (!ledger.capture('N01', stream, bytes)) invalid = true;
    } else if (event.type === 'test:summary' && data.file === undefined) {
      complete = data.success === true && data.counts?.tests === rows.length &&
        ['failed', 'cancelled', 'skipped', 'todo'].every(key => data.counts[key] === 0);
    } else if (['test:pass', 'test:fail'].includes(event.type)) {
      const path = typeof data.file === 'string' ? relative(root, resolve(data.file)).replaceAll('\\', '/') : '';
      const row = rows.find(([, file, name]) => file === path && name === data.name);
      if (!row || data.details?.type === 'suite' || data.nesting !== 0 ||
          data.details?.attempt !== undefined || data.details?.passed_on_attempt !== undefined) {
        invalid = true; continue;
      }
      const prior = seen.get(row[0]);
      seen.set(row[0], { id: row[0], status: data.skip || data.todo ? 'skipped' :
        event.type === 'test:pass' ? 'passed' : 'failed', attempts: (prior?.attempts ?? 0) + 1 });
    }
  }
  return { schemaVersion: 1, suiteId, inventoryDigest: digest, cases: [...seen.values()],
    complete: complete && !invalid && seen.size === rows.length && !ledger.failure };
}
export function validateNodeSuite(bytes, inventoryBytes, digest, suiteId) {
  const inventory = nodeInventory(inventoryBytes, digest);
  const wanted = new Set(inventory.suites[suiteId]?.map(row => row[0]));
  if (!wanted.size || bytes.length > 256 * 1024) fail('MALFORMED');
  const report = JSON.parse(bytes);
  exactKeys(report, ['schemaVersion', 'suiteId', 'inventoryDigest', 'cases', 'complete']);
  if (report.schemaVersion !== 1 || report.suiteId !== suiteId ||
      report.inventoryDigest !== digest || !Array.isArray(report.cases)) fail('MALFORMED');
  let count = 0;
  for (const item of report.cases) {
    exactKeys(item, ['id', 'status', 'attempts']);
    if (!wanted.delete(item.id) || item.attempts !== 1) fail('MALFORMED');
    if (item.status !== 'passed') fail(item.status === 'failed' ? 'TEST_FAILED' : 'INCOMPLETE');
    count++;
  }
  if (report.complete !== true || wanted.size) fail('INCOMPLETE');
  return { suiteId, passed: count };
}
export default async function* reporter(events) {
  const root = resolve(import.meta.dirname, '../..');
  const suiteId = process.env.OPERATIONAL_NODE_SUITE;
  const digest = process.env.OPERATIONAL_NODE_INVENTORY_DIGEST;
  const bytes = await readTrustedFile(root, 'scripts/ci/operational-node-inventory.json', 256 * 1024);
  const rows = nodeInventory(bytes, digest).suites[suiteId];
  const directory = process.env.OPERATIONAL_PRIVATE_RESULTS_DIR;
  if (!rows || !isAbsolute(directory ?? '')) fail();
  const report = await nodeReport(events, rows, { root, suiteId, digest,
    capture: (stream, chunk) => process[stream].write(chunk) });
  const output = Buffer.from(JSON.stringify(report));
  if (output.length > 256 * 1024) fail('OVERFLOW');
  await writeFile(join(directory, `${suiteId}.json`), output, { flag: 'wx', mode: 0o600 });
  // Raw test streams go only to the enclosing capture ledger; titles and
  // diagnostics never become a reporter output or public artifact.
}
