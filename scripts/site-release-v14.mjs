// This is one frozen, independently reproduced historical module, not a generic prebuilt-module flag.
import assert from 'node:assert/strict';
import { hash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export const V14_MODULE = '17190d4c25d655580813944ae79821d898e4c6ed3b5774dbaee82ac87d4f916f';
const source = '0b08fd58e53b6ae9b581eb076d2576903e2a2b04';
const carrier = '210a964323e9483f123600c52ed95fca9d15de8d9758cce89135aeeb34af4da5';
const sha256 = bytes => hash('sha256', bytes);
const read = path => JSON.parse(readFileSync(path));

export function archivedProvenance(root, directory, files, currentWorkerSources) {
  // Pin every byte, including the npm lock, installed Worker dependencies, package manifests,
  // actual Wrangler metafile and historical release validator BEFORE interpreting any of them.
  const names = Object.keys(files).filter(p => p.startsWith('worker/') || p.startsWith('v14/')).sort();
  const tuples = names.map(p => [p, files[p].bytes, files[p].sha256]);
  assert.equal(sha256(JSON.stringify(tuples)), carrier, 'v14 custody inventory mismatch');
  assert.deepEqual(files['worker/worker.js'], { bytes: 857817, sha256: V14_MODULE });
  const receipt = read(join(directory, 'worker/capture.json'));
  assert.equal(receipt.tag, source); assert.equal(receipt.sha256, V14_MODULE);
  const prior = join(directory, 'v14');
  // Application shared inputs in the archive are from v14, not the new solver. The Site entry tree
  // and production configuration, by contrast, must still be exactly the reviewed baseline.
  const prefix = 'v14/site-worker/src/';
  const archivedSources = Object.fromEntries(names.filter(p => p.startsWith(prefix)).map(p => [p.slice(prefix.length),files[p]]));
  assert.deepEqual(currentWorkerSources, archivedSources, 'asset-only promotion cannot change the Site Worker source tree');
  assert.equal(sha256(readFileSync(join(root,'site-worker/production.wrangler.toml'))), files['v14/site-worker/production.wrangler.toml'].sha256);
  const validator = join(prior, 'scripts/site-release.mjs');
  assert.equal(sha256(readFileSync(validator)), 'd818052188fe34678c6f4e40af97aa75e639fdd3948c7e6e7b648c2f35ae8e69');
  const { workerProvenance } = createRequire(import.meta.url)(validator);
  const { dependencies } = workerProvenance(prior,directory); // original 4.156.1 physical npm/package-lock checks
  for (const p of dependencies) assert(files[`v14/${p}`], `missing v14 dependency ${p}`);
  assert.equal(read(join(prior,'node_modules/wrangler/package.json')).version,'4.156.1');
  return { profile: 'archived-site-v14-v1', source, siteVersion: receipt.version, deployment: receipt.deployment,
    moduleSha256: V14_MODULE, carrierSha256: carrier, originalWrangler: '4.156.1', dependencies };
}
