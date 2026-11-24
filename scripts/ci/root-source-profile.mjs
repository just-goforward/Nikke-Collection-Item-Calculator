import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { hash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertProductionKey } from '../root-release-custody.mjs';
import target from '../root-conditional-target.json' with { type: 'json' };

const root = resolve(import.meta.dirname, '../..'), record = 'site-worker/production-root-release-v1.json';
const hex = /^[0-9a-f]{64}$/;
export function checkEnrolledBuild(bytes, identity) {
  const r = JSON.parse(bytes);
  assert.deepEqual(Object.keys(r).sort(), ['profile', 'siteWorker', 'origin', 'publisherWorker', 'publisherVersion', 'priorSiteVersion',
    'read', 'keyId', 'domain', 'publicKeyBase64', 'enrollmentEvidenceSha256', 'serviceCodeHash', 'nativeWasmSha256', 'nativeSourceHash'].sort());
  assert.equal(r.profile, 'private-production-root-v1'); assert.equal(r.siteWorker, 'collection-kit-site-production');
  assert.equal(r.origin, 'https://nikkecollection.com'); assert.equal(r.publisherWorker, 'collection-kit-conditional-production');
  assert.match(r.publisherVersion, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/); assert.equal(r.priorSiteVersion, '741e68d9-cd5c-400a-83ce-21757315bcc8');
  for (const key of ['domain', 'keyId', 'read']) assert.equal(r[key], target[key]);
  assertProductionKey(r.publicKeyBase64); assert.match(r.enrollmentEvidenceSha256, hex);
  assert.equal(identity.policy, 'adaptive-next-batch-balanced-v1');
  for (const [field, expected] of [['serviceCodeHash', identity.codeHash], ['nativeWasmSha256', identity.exactWasmHash], ['nativeSourceHash', identity.nativeSourceHash]]) {
    assert.match(r[field], hex); assert.equal(r[field], expected, `root source identity mismatch: ${field}`);
  }
}
export function requireReviewedBytes(bytes, env) {
  const scope = JSON.stringify(['production-root-source-review-v1', env.GITHUB_REPOSITORY, env.GITHUB_SHA, hash('sha256', bytes)]);
  assert.equal(hash('sha256', scope), env.ROOT_PAIR_SOURCE_APPROVAL_SHA256, 'independent exact-main root source review required');
}
export function requireSourceReview(bytes, env) {
  assert(['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME));
  assert.equal(env.GITHUB_REF, 'refs/heads/main'); assert.equal(env.GITHUB_REF_PROTECTED, 'true');
  assert.match(env.GITHUB_SHA, /^[0-9a-f]{40}$/); assert.equal(env.GITHUB_WORKFLOW_SHA, env.GITHUB_SHA);
  assert.equal(env.GITHUB_WORKFLOW_REF, `${env.GITHUB_REPOSITORY}/.github/workflows/site-source-verify.yml@refs/heads/main`);
  requireReviewedBytes(bytes, env);
}
export function sourceLane(bytes, env) {
  if (bytes === null) {
    assert.notEqual(env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'manual verification requires enrolled root source');
    return 'legacy';
  }
  if (env.GITHUB_EVENT_NAME === 'pull_request') {
    assert.equal(env.GITHUB_BASE_REF, 'main'); assert.match(env.GITHUB_REF, /^refs\/pull\/[1-9][0-9]*\/merge$/);
    return 'root-review-only';
  }
  if (env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === 'refs/heads/ci/site-source-transition') return 'root-review-only';
  requireSourceReview(bytes, env); return 'root';
}
async function select() {
  const env = process.env, git = (...args) => execFileSync('git', args, { cwd: root });
  assert.equal(git('rev-parse', 'HEAD').toString().trim(), env.GITHUB_SHA);
  assert.equal(git('status', '--porcelain', '--untracked-files=all').length, 0, 'clean source required');
  const entry = git('ls-tree', 'HEAD', '--', record).toString().trim(), path = join(root, record);
  if (!entry) { assert(!existsSync(path)); return sourceLane(null, env); }
  assert.match(entry, /^100644 blob [0-9a-f]{40}\t/); assert.equal(realpathSync(path), path);
  const bytes = git('show', `HEAD:${record}`); assert.deepEqual(bytes, readFileSync(path));
  const lane = sourceLane(bytes, env); // Never promote a PR's isolated build or skip an invalid enrolled identity.
  const { assertServiceH14Build } = await import('../service-h14-integrity.ts');
  checkEnrolledBuild(bytes, await assertServiceH14Build()); return lane;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(await select());
