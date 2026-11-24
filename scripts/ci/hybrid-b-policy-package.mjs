// Read-only, source-review lane. Nothing here authorizes a public release.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { hash } from 'node:crypto';
import { lstat, opendir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '../..');
export const sha256 = bytes => hash('sha256', bytes);
const sha = /^[a-f0-9]{64}$/;
const pin = value => typeof value === 'string' && sha.test(value);
const contract = 'site-worker/production-root-release-v1.json';
const digestTree = files => sha256(JSON.stringify(Object.keys(files).sort().map(url => [url, files[url].bytes, files[url].sha256])));
const keys = (obj, names) => assert.deepEqual(Object.keys(obj).sort(), [...names].sort());

async function ordinary(path, max) {
  assert.equal(await realpath(path), path, 'noncanonical or linked input');
  const stat = await lstat(path);
  assert(stat.isFile() && stat.size > 0 && stat.size <= max, 'invalid input size or type');
  return readFile(path);
}

export async function verifyPolicyTree(dir, files, headersSha256) {
  assert(isAbsolute(dir) && await realpath(dir) === dir && (await lstat(dir)).isDirectory());
  const wanted = new Map(Object.entries(files));
  assert(wanted.size > 0 && wanted.size <= 2048);
  for (const [url, desc] of wanted) {
    assert(/^\/(?:[\w-][\w.-]*\/)*[\w-][\w.-]*$/.test(url) && !/^\/(?:api|preview)(?:\/|$)/.test(url));
    keys(desc, ['bytes', 'sha256']);
    assert(pin(desc.sha256) && Number.isSafeInteger(desc.bytes) && desc.bytes > 0 && desc.bytes <= 64 * 1024 * 1024);
  }
  for (const name of ['/_headers', '/.assetsignore']) assert(!wanted.has(name));
  wanted.set('/_headers', {sha256: headersSha256});
  wanted.set('/.assetsignore', {sha256: sha256('/.vite/\n')});
  async function visit(prefix) {
    for await (const entry of await opendir(join(dir, prefix))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { await visit(path); continue; }
      const desc = wanted.get('/' + path);
      assert(entry.isFile() && desc, 'extra or linked package asset');
      const bytes = await ordinary(join(dir, path), desc.bytes ?? 64 * 1024);
      if (desc.bytes !== undefined) assert.equal(bytes.length, desc.bytes);
      assert.equal(sha256(bytes), desc.sha256, 'package asset mismatch');
      wanted.delete('/' + path);
    }
  }
  await visit('');
  assert.equal(wanted.size, 0, 'missing package asset');
}

export async function readPolicyPackage(dir) {
  // Caller supplies the owner-precommitted service digest, not a digest derived from this directory.
  const expected = process.env.ROOT_POLICY_PACKET_SHA256;
  assert(pin(expected), 'precommitted ROOT_POLICY_PACKET_SHA256 required');
  assert(typeof dir === 'string' && isAbsolute(dir) && await realpath(dir) === dir);
  const bytes = await ordinary(join(dir, 'private-root-pair.json'), 2 * 1024 * 1024);
  const receiptSha256 = sha256(bytes);
  assert.equal(receiptSha256, expected, 'private packet custody mismatch');
  const receipt = JSON.parse(bytes);
  keys(receipt, ['profile','publicationApproved','productionDeployable','review','worker','output','rollback','files']);
  assert.equal(receipt.profile, 'private-production-root-v1');
  assert.equal(receipt.publicationApproved, false);
  assert.equal(receipt.productionDeployable, false);
  // This lane runs the harness checked into the actual reviewed release, not a grafted
  // QA patch. The service-observed packet and its claim must both match that commit.
  const packageSource = execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  const enrolled = execFileSync('git', ['show', `${packageSource}:${contract}`], {cwd:root});
  const {statementSha256} = receipt.review;
  assert(pin(statementSha256));
  assert.deepEqual(receipt.review, {...JSON.parse(enrolled), source:packageSource, contractSha256:sha256(enrolled), statementSha256});
  const {output:forward, rollback, files, worker, review} = receipt;
  assert.equal(basename(forward), 'production-forward');
  assert.equal(rollback, join(dirname(forward), 'production-rollback'));
  keys(files, ['forward','rollback','retained','headersSha256']);
  assert.equal(files.retained, 66);
  assert(pin(files.headersSha256));
  const paths = Object.keys(files.forward).sort();
  assert.deepEqual(paths, Object.keys(files.rollback).sort());
  assert.deepEqual(paths.filter(p => files.forward[p].sha256 !== files.rollback[p].sha256), ['/en/index.html','/index.html','/ja/index.html']);
  assert(/^assets\/[\w-]+-[\w-]{8}\.js$/.test(worker) && Object.hasOwn(files.forward, '/'+worker));
  const wasm = '/wasm/service-fused-h14-' + review.nativeWasmSha256 + '.wasm';
  assert.equal(files.forward[wasm]?.sha256, review.nativeWasmSha256);
  await verifyPolicyTree(forward, files.forward, files.headersSha256);
  await verifyPolicyTree(rollback, files.rollback, files.headersSha256);
  const identity = {source:packageSource, packetSha256:receiptSha256, enrollmentSha256:review.contractSha256,
    serviceCodeHash:review.serviceCodeHash, nativeWasmSha256:review.nativeWasmSha256, nativeSourceHash:review.nativeSourceHash,
    workerSha256:files.forward['/'+worker].sha256, forwardSha256:digestTree(files.forward), rollbackSha256:digestTree(files.rollback), headersSha256:files.headersSha256};
  return {receipt, forward, receiptSha256, identity};
}
