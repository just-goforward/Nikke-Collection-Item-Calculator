import { pathToFileURL } from 'node:url';
import { assertImmutableRuntime, loadApproval, finalSource } from './operational-container.mjs';
import { readTrustedFile, collectSuite, verifySource } from './operational-files.mjs';
import { verifyStorage, verifyWorkspace, PRIVATE_ROOT } from './operational-storage.mjs';
import { requireContainmentEvidence, assertOperationalExecutionAllowed } from './operational-admission.mjs';
import { validateSuite } from './operational-results.mjs';
import { validateNodeSuite } from './operational-node-reporter.mjs';
import { sha256, SUITE_STAGES, fail } from './operational-policy.mjs';
import { encodeReceipt, receiptIdentity, FINALIZER_EXIT } from './operational-receipt.mjs';

export async function finalize() {
  assertOperationalExecutionAllowed();
  assertImmutableRuntime(import.meta.url, 'operational-finalizer.mjs');
  if (process.argv.length !== 2) fail();
  // Only the host pair adapter can launch this fixed command in the RO
  // collector. It requires the producer's trusted wait/reap event chain first.
  // No report field, proc listing or caller boolean can supply that authority.
  const { a, bytes } = await loadApproval();
  await verifyStorage(a, 'collector');
  const source = Buffer.from(JSON.stringify(a.source));
  await verifySource('/source', source, sha256(source));
  await finalSource(a);
  await verifyWorkspace(a, true);
  const evidence = JSON.parse(await readTrustedFile(PRIVATE_ROOT, 'containment.json', 65536));
  requireContainmentEvidence(evidence, process.env.OPERATIONAL_NONCE);
  const browserInventory = await readTrustedFile('/source', 'e2e/operational-inventory.json', 256 * 1024);
  const nodeInventory = await readTrustedFile('/source', 'scripts/ci/operational-node-inventory.json', 256 * 1024);
  const suites = [];
  for (const suite of Object.values(SUITE_STAGES)) {
    const report = await collectSuite(PRIVATE_ROOT, suite);
    suites.push(['profile-policy', 'node-runtime'].includes(suite)
      ? validateNodeSuite(report, nodeInventory, a.nodeInventoryDigest, suite)
      : validateSuite(report, browserInventory, a.inventoryDigest, suite));
  }
  const frame = encodeReceipt({ schemaVersion: 1,
    ...receiptIdentity(a, sha256(bytes), process.env.OPERATIONAL_NONCE), suites });
  await new Promise((resolve, reject) => process.stdout.write(frame, error => error ? reject(error) : resolve()));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  finalize().catch(error => { process.exitCode = FINALIZER_EXIT[error.message] ?? 75; });
}
