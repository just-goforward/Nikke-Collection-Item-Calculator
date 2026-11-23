// Manual, protected-main preparation only. No Wrangler credentials and no deployment operation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { hash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadApproval, validateObserved } from '../../e2e/operational-report.mjs';
import { assertSiteUploadApproved } from '../deploy-site.ts';
import { assertContext, seal } from '../site-release.mjs';
import { requireReviewedBytes } from './root-source-profile.mjs';

const root = resolve(import.meta.dirname, '../..');
const roles = ['rollback', 'forward'];
const suites = ['numerical-boundary', 'production-policy', 'analytics-policy'];
const sha256 = bytes => hash('sha256', bytes);
const hex = /^[0-9a-f]{64}$/;
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const node = (...args) => execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
function pinned(file, digest) {
  assert(typeof digest === 'string' && hex.test(digest), 'independent review digest required');
  assert.equal(realpathSync(file), file); const st = lstatSync(file);
  assert(st.isFile() && st.size > 0 && st.size <= 8 * 1024 * 1024, 'invalid review input');
  const bytes = readFileSync(file); assert.equal(sha256(bytes), digest, `unreviewed ${file}`); return bytes;
}

// Hash URL, length AND bytes, not object insertion order or the runner-local packet pathname.
export const servedDigest = files => sha256(JSON.stringify(Object.keys(files).sort().map(p => [p, files[p].bytes, files[p].sha256])));
export function checkReview(input, digest, sha, repository, enrollment) {
  const a = JSON.parse(pinned(join(input, 'public-review.json'), digest));
  assert.equal(a.profile, 'production-root-pair-release-v1', 'independent public pair review required');
  assert.deepEqual(Object.keys(a).sort(), ['profile', 'source', 'repository', 'origin', 'siteWorker', 'enrollmentContractSha256',
    'expiresAt', 'sourceRun', 'sourceAttempt', 'headersSha256', 'directions', 'evidence'].sort());
  assert(hex.test(a.headersSha256) && [a.sourceRun, a.sourceAttempt].every(v => typeof v === 'string' && /^[1-9][0-9]*$/.test(v)));
  assert.equal(a.source, sha); assert.equal(a.repository, repository); assert.equal(a.origin, 'https://nikkecollection.com');
  assert.equal(a.siteWorker, 'collection-kit-site-production'); assert.equal(a.enrollmentContractSha256, sha256(enrollment));
  assert(Number.isSafeInteger(a.expiresAt) && Date.now() < a.expiresAt, 'expired public pair review');
  assert.deepEqual(Object.keys(a.directions).sort(), [...roles].sort());
  for (const role of roles) {
    assert.deepEqual(Object.keys(a.directions[role]).sort(), ['operationalSha256', 'servedSha256', 'serviceSha256']);
    assert(Object.values(a.directions[role]).every(v => typeof v === 'string' && hex.test(v)));
  }
  assert.notEqual(a.directions.forward.servedSha256, a.directions.rollback.servedSha256);
  assert.deepEqual(Object.keys(a.evidence).sort(), ['root-numerical', 'root-product', ...suites].sort());
  for (const name of ['root-numerical', 'root-product', ...suites]) {
    const bytes = pinned(join(input, `${name}.json`), a.evidence[name]);
    if (!suites.includes(name)) continue; // Root-specific evidence is independently adjudicated, not a suite self-approval.
    const approval = loadApproval(name), report = JSON.parse(bytes);
    assert.equal(report.schemaVersion, 1); assert.equal(report.suiteId, name); assert.equal(report.inventoryDigest, approval.digest);
    assert.equal(report.complete, true); assert(validateObserved(approval.ids, report.cases, report.complete).complete);
  }
  return a;
}

export function checkPair(review, pair) {
  assert.equal(pair.profile, 'private-production-root-v1'); assert.equal(pair.productionDeployable, false); assert.equal(pair.publicationApproved, false);
  assert.equal(pair.review.source, review.source); assert.equal(pair.review.contractSha256, review.enrollmentContractSha256);
  assert.equal(pair.files.headersSha256, review.headersSha256);
  for (const role of roles) assert.equal(servedDigest(pair.files[role]), review.directions[role].servedSha256, `unreviewed ${role} tree`);
  const paths = Object.keys(pair.files.forward).sort(); assert.deepEqual(paths, Object.keys(pair.files.rollback).sort());
  assert.deepEqual(paths.filter(p => pair.files.forward[p].sha256 !== pair.files.rollback[p].sha256),
    ['/en/index.html', '/index.html', '/ja/index.html'], 'only the three localized app documents may differ');
}

export function publicMetadata(role, input, roleDist, pair, review) {
  const meta = join(roleDist, '.vite'); mkdirSync(meta); // Never overlay or relabel a private build receipt.
  const grant = review.directions[role];
  for (const [file, pin] of [['local-operational-profile.json', grant.operationalSha256], ['service-h14.json', grant.serviceSha256]]) {
    const bytes = pinned(join(input, role, file), pin), original = JSON.parse(bytes);
    assert.equal(original.profile, 'production-root-pair-release-v1'); assert.equal(original.role, role);
    assert.equal(original.source, review.source); assert.equal(original.servedSha256, grant.servedSha256);
    const keys = ['profile', 'role', 'source', 'servedSha256', ...(file === 'service-h14.json'
      ? ['status', 'publicationApproved'] : ['solverApproval', 'deploymentApproved'])];
    assert.deepEqual(Object.keys(original).sort(), keys.sort(), 'unexpected or contradictory public receipt');
    if (file === 'service-h14.json') { assert.equal(original.status, 'APPROVED_PRODUCTION_ROOT_PAIR'); assert.equal(original.publicationApproved, true); }
    else { assert.equal(original.solverApproval, 'APPROVED_PRODUCTION_ROOT_PAIR'); assert.equal(original.deploymentApproved, true); }
    writeFileSync(join(meta, file), bytes, { flag: 'wx' });
  }
  assertSiteUploadApproved(roleDist);
  // Keep real bundler/runtime metadata: do not transplant K1R2 authorization or invent a legacy manifest.
  if (role === 'forward') {
    const build = join(dirname(pair.output), 'root-build', '.vite');
    for (const name of ['manifest.json', 'forecast-runtime.json']) copyFileSync(join(build, name), join(meta, name));
  } else {
    const legacy = JSON.parse(pinned(join(input, 'v14-site-production.json'), read(join(input, 'archive/capture.json')).sourceReceipt));
    for (const name of ['manifest.json', 'forecast-runtime.json']) writeFileSync(join(meta, name),
      pinned(join(input, `v14-${name}`), legacy.files[`.vite/${name}`]), { flag: 'wx' });
  }
  save(join(meta, 'site-production.json'), { profile: review.profile, role, source: review.source, servedSha256: grant.servedSha256,
    files: pair.files[role], headersSha256: pair.files.headersSha256, enrollmentContractSha256: pair.review.contractSha256,
    publicReviewSha256: sha256(readFileSync(join(input, 'public-review.json'))) });
}

async function prepare() {
  const env = process.env, sha = env.GITHUB_SHA;
  assertContext(env, sha); assert.equal(env.GITHUB_REF_PROTECTED, 'true'); assert(!env.CLOUDFLARE_API_TOKEN && !env.CLOUDFLARE_ACCOUNT_ID);
  assert.equal(process.cwd(), root); node('scripts/site-release.mjs', 'context', 'unused', sha);
  const tmp = realpathSync(env.RUNNER_TEMP), input = join(tmp, 'root-input'), out = join(tmp, 'root-pair');
  const contract = join(root, 'site-worker/production-root-release-v1.json'), enrollment = readFileSync(contract);
  requireReviewedBytes(enrollment, env);
  const review = checkReview(input, env.ROOT_PAIR_REVIEW_SHA256, sha, env.GITHUB_REPOSITORY, enrollment);
  mkdirSync(out); mkdirSync(join(root, '.artifacts'), { recursive: true });
  // No dispatcher-supplied URL, authentication, redirects or stale wire fallback.
  const r = await fetch('https://nikkecollection.com/api/joint-supply/v2', { redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'cache-control': 'no-cache' } });
  assert.equal(r.status, 200); const body = [];
  let size = 0; for await (const chunk of r.body) { size += chunk.length; assert(size <= 524288); body.push(chunk); }
  const wire = join(out, 'joint.body'); writeFileSync(wire, Buffer.concat(body), { flag: 'wx' });
  node('scripts/build-root-candidate.mjs', '--private-production-v1', out, contract, sha, wire, join(input, 'enrollment'), join(input, 'archive'));
  const packet = join(out, 'private-root-pair.json'), canary = join(out, 'private-canary.json'), pair = read(packet);
  checkPair(review, pair); node('scripts/root-release-canary.mjs', packet, canary);
  const dist = join(root, 'dist'), bundle = join(out, 'bundle'); assert(!existsSync(dist), 'fresh runner required');
  const digests = {};
  for (const role of roles) {
    const src = role === 'forward' ? pair.output : pair.rollback, release = join(out, role);
    cpSync(src, dist, { recursive: true, force: false, errorOnExist: true });
    try {
      publicMetadata(role, input, dist, pair, review); mkdirSync(join(release, 'worker'), { recursive: true });
      if (role === 'rollback') node('node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', 'site-worker/production.wrangler.toml', '--env', '', '--dry-run', '--outdir', bundle, '--metafile', join(out, 'meta.json'));
      copyFileSync(join(bundle, 'worker.js'), join(release, 'worker/worker.js')); copyFileSync(join(out, 'meta.json'), join(release, 'worker/meta.json'));
      digests[role] = seal(root, release, sha, env);
      node('scripts/root-release-sealed-check.mjs', role, packet, canary, release, sha, digests[role], env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT);
    } finally { rmSync(dist, { recursive: true }); } // Only our newly created CI staging tree.
  }
  assert.notEqual(digests.rollback, digests.forward); assert(Date.now() < review.expiresAt, 'public pair review expired during preparation');
  save(join(out, 'digests.json'), digests);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await prepare();
