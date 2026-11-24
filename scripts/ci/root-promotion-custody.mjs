import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { hash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertContext } from '../site-release.mjs';
import { requireReviewedBytes } from './root-source-profile.mjs';
import { checkPair, checkReview } from './prepare-root-pair.mjs';
import { childEnvironment } from './run-checked-command.mjs';
import enrolled from '../../site-worker/production-root-release-v1.json' with {type:'json'};
import {serviceBuild as predecessorBuild} from '../../production-incidents/sealed-successor.ts';

export const root = resolve(import.meta.dirname, '../..');
export const roles = ['rollback', 'forward'];
export const operations = { 'root-install-bridge': 'rollback', 'root-activate-forward': 'forward', 'root-restore-rollback': 'rollback' };
export const json = path => JSON.parse(readFileSync(path));
export const sha256 = bytes => hash('sha256', bytes);
const digest = /^[0-9a-f]{64}$/, uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/, id = /^[1-9][0-9]*$/;
const strings = (re, ...vals) => vals.every(x => typeof x === 'string' && re.test(x));
const parsePinned = (path, pin) => { assert.match(pin, digest); const b = readFileSync(path); assert.equal(sha256(b), pin, 'promotion bytes differ from independent pin'); return JSON.parse(b); };
export function readTransition(env) {
  // Stage U holds every root direction. Only the earlier receiver binding has an enrolled version.
  assert.equal(enrolled.serviceCodeHash,predecessorBuild,'no activated incident receiver for this candidate build');
  assertContext(env, env.GITHUB_SHA); assert.equal(env.GITHUB_REF_PROTECTED, 'true');
  const op = env.ROOT_OPERATION, event = json(env.GITHUB_EVENT_PATH);
  assert(Object.hasOwn(operations, op)); assert.equal(event.inputs.operation, op); assert.equal(event.inputs.deploy_sha, env.GITHUB_SHA);
  // Independent environment owner grants one direction from one observed deployment; no artifact selector in dispatch inputs.
  const g = JSON.parse(env.ROOT_SITE_TRANSITION);
  assert.equal(g.profile, 'production-root-transition-v1'); assert.equal(g.operation, op); assert.equal(g.repository, env.GITHUB_REPOSITORY); assert.equal(g.source, env.GITHUB_SHA);
  assert.equal(g.worker, 'collection-kit-site-production'); assert.equal(g.hostname, 'nikkecollection.com');
  assert.ok(Number.isSafeInteger(g.expiresAt) && g.expiresAt > Date.now(), 'expired exclusive change window');
  assert(strings(uuid, g.fromVersion, g.fromDeployment)); assert(strings(digest, g.controlSha256, g.handoffSha256, g.receiptArchiveSha256));
  assert(Number.isSafeInteger(g.minimumProducerSequence) && g.minimumProducerSequence > 0, 'fresh producer floor required');
  assert(strings(id, g.prepareRun, g.prepareAttempt, g.receiptId));
  if (op === 'root-install-bridge') { assert.equal(g.bridge, null); assert.equal(g.fromVersion, '741e68d9-cd5c-400a-83ce-21757315bcc8'); }
  else { assert(g.bridge, 'verified BRIDGE_READY artifact required'); assert(strings(id, g.bridge.run, g.bridge.attempt, g.bridge.artifactId)); assert(strings(digest, g.bridge.archiveSha256, g.bridge.stateSha256)); }
  return g;
}
export function paths(env) {
  const base = join(env.RUNNER_TEMP, 'root-promotion'); return { base, receipt: join(base, 'receipt'), input: join(base, 'review'), bridge: join(base, 'bridge/state.json'), state: join(base, 'state.json') };
}
export function verifyHandoff(env, g) {
  const p = paths(env), h = parsePinned(join(p.receipt, 'handoff.json'), g.handoffSha256);
  assert.equal(h.profile, 'production-root-pair-handoff-v1'); assert.equal(h.deployed, false); assert.equal(h.repository, g.repository);
  assert.equal(h.sha, g.source); assert.equal(h.run, g.prepareRun); assert.equal(h.attempt, g.prepareAttempt);
  assert.equal(h.reviewRun, env.REVIEW_RUN); assert.equal(h.reviewArtifact, env.REVIEW_ARTIFACT); assert.equal(h.reviewSha256, env.ROOT_PAIR_REVIEW_SHA256);
  assert(strings(id, h.reviewRun, h.reviewArtifact)); assert.deepEqual(Object.keys(h.directions).sort(), ['forward','rollback']);
  for (const r of roles) { const d = h.directions[r]; assert(strings(id, d.artifactId)); assert(strings(digest, d.manifestSha256, d.artifactSha256)); }
  for (const field of ['artifactId','manifestSha256','artifactSha256']) assert.notEqual(h.directions.rollback[field], h.directions.forward[field]);
  if (g.bridge) {
    const b = parsePinned(p.bridge, g.bridge.stateSha256);
    assert.equal(b.profile,'production-root-state-v1'); assert.equal(b.state,'BRIDGE_READY'); assert.equal(b.operation,'root-install-bridge');
    assert.equal(b.handoffSha256,g.handoffSha256); assert.equal(b.source,g.source); assert.equal(b.run,g.bridge.run); assert.equal(b.attempt,g.bridge.attempt);
    assert.equal(b.manifestSha256,h.directions.rollback.manifestSha256); assert(strings(uuid,b.deployment,b.version));
    assert.equal(b.controlSha256,g.controlSha256); assert(Number.isSafeInteger(b.sequence) && g.minimumProducerSequence >= b.sequence, 'producer floor below bridge');
    if (g.operation === 'root-activate-forward') { assert.equal(g.fromVersion,b.version); assert.equal(g.fromDeployment,b.deployment); }
  }
  return h;
}
async function github(env, path) {
  assert.match(env.GITHUB_REPOSITORY,/^[\w.-]+\/[\w.-]+$/); assert(env.GH_TOKEN);
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/${path}`, { headers:{authorization:`Bearer ${env.GH_TOKEN}`,accept:'application/vnd.github+json'},redirect:'error',signal:AbortSignal.timeout(12000) });
  assert.equal(r.status,200,`GitHub read denied: ${path}`); return r.json();
}
export async function requireMain(env) {
  const main = await github(env,'branches/main'); assert.equal(main.protected,true); assert.equal(main.commit.sha,env.GITHUB_SHA,'protected main moved');
}
async function requireRun(env, run, attempt, job) {
  const path = `actions/runs/${run}`; const r = await github(env,path);
  assert.equal(r.event,'workflow_dispatch'); assert.equal(r.path,'.github/workflows/site-worker-promote.yml'); assert.equal(r.head_branch,'main'); assert.equal(r.head_sha,env.GITHUB_SHA);
  assert.equal(r.head_repository.full_name,env.GITHUB_REPOSITORY); assert.equal(String(r.run_attempt),attempt); assert.equal(r.conclusion,'success');
  const list = await github(env,`${path}/attempts/${attempt}/jobs?per_page=100`);
  assert.equal(list.jobs.filter(j => j.name === job && j.conclusion === 'success').length,1,`no successful ${job}`);
}
async function requireArtifact(env, artifact, run, name, pin) {
  const a = await github(env,`actions/artifacts/${artifact}`);
  assert.equal(String(a.id),artifact); assert.equal(a.expired,false); assert.equal(a.name,name); assert.equal(a.digest,`sha256:${pin}`);
  assert.equal(String(a.workflow_run.id),run); assert.equal(a.workflow_run.head_sha,env.GITHUB_SHA);
}
function output(env, fields) { for (const [k,v] of Object.entries(fields)) { assert(strings(id,v)); appendFileSync(env.GITHUB_OUTPUT,`${k}=${v}\n`); } }
export function verifyPackages(env, g, restore) {
  const p = paths(env), h = verifyHandoff(env,g), enrolled = readFileSync(join(root,'site-worker/production-root-release-v1.json'));
  requireReviewedBytes(enrolled, env); const review = checkReview(p.input,h.reviewSha256,g.source,g.repository,enrolled);
  const receiptReview = parsePinned(join(p.receipt,'public-review.json'), h.reviewSha256); assert.deepEqual(receiptReview,review);
  const packet = join(p.receipt,'private-root-pair.json'), canary = join(p.receipt,'private-canary.json');
  const pair = parsePinned(packet,h.packetSha256); assert.equal(parsePinned(canary,h.canarySha256).packetSha256,h.packetSha256); checkPair(review,pair);
  // Exact git context is checked outside the credentialled process. Child processes receive no provider credentials.
  const node = (...args) => execFileSync(process.execPath,args,{cwd:root,env:childEnvironment(env,g.source),stdio:'inherit'});
  for (const role of roles) {
    const release = join(p.base,role), d = h.directions[role], meta = join(release,'dist/.vite');
    const m = parsePinned(join(meta,'local-operational-profile.json'),review.directions[role].operationalSha256);
    const s = parsePinned(join(meta,'service-h14.json'),review.directions[role].serviceSha256);
    for (const v of [m,s]) { assert.equal(v.profile,review.profile); assert.equal(v.role,role); assert.equal(v.source,g.source); assert.equal(v.servedSha256,review.directions[role].servedSha256); }
    assert.equal(m.solverApproval,'APPROVED_PRODUCTION_ROOT_PAIR'); assert.equal(s.status,'APPROVED_PRODUCTION_ROOT_PAIR');
    node('scripts/root-release-sealed-check.mjs',role,packet,canary,release,g.source,d.manifestSha256,h.run,h.attempt);
  }
  const role = operations[g.operation], release = join(p.base,role), manifest = h.directions[role].manifestSha256;
  if (restore) assert(!existsSync(join(root,'dist')));
  node('scripts/site-release.mjs',restore?'restore-root':'verify-root',release,g.source,manifest,h.run,h.attempt);
  return { h,pair,enrolled:JSON.parse(enrolled),role,release,manifest,expiresAt:Math.min(g.expiresAt,review.expiresAt) };
}
async function receiptArtifacts(env,g) {
  await requireRun(env,g.prepareRun,g.prepareAttempt,'prepare-root-pair');
  await requireArtifact(env,g.receiptId,g.prepareRun,`root-pair-receipt-${g.source}-${g.prepareRun}-${g.prepareAttempt}`,g.receiptArchiveSha256);
  const fields={run:g.prepareRun,receipt:g.receiptId};
  if (g.bridge) { const b=g.bridge; await requireRun(env,b.run,b.attempt,'publish-root-pair');
    await requireArtifact(env,b.artifactId,b.run,`root-state-root-install-bridge-${g.source}-${b.run}-${b.attempt}`,b.archiveSha256);
    Object.assign(fields,{bridge_run:b.run,bridge_id:b.artifactId}); }
  return fields;
}
async function sealArtifacts(env,h) {
  const fields={}; for(const role of roles) { const d=h.directions[role];
    await requireArtifact(env,d.artifactId,h.run,`root-${role}-${h.sha}-${h.run}-${h.attempt}`,d.artifactSha256); fields[role]=d.artifactId; }
  return fields;
}
export async function requireLiveCustody(env,g,h) {
  await Promise.all([requireMain(env),receiptArtifacts(env,g),sealArtifacts(env,h)]);
  const run=await github(env,`actions/runs/${env.GITHUB_RUN_ID}`);
  assert.equal(run.event,'workflow_dispatch');assert.equal(run.path,'.github/workflows/site-worker-promote.yml');
  assert.equal(run.head_sha,g.source);assert.equal(run.head_branch,'main');assert.equal(run.status,'in_progress');
  assert.equal(String(run.run_attempt),env.GITHUB_RUN_ATTEMPT);
}
async function main(env, mode) {
  const g = readTransition(env); await requireMain(env);
  if (mode === 'receipt') output(env,await receiptArtifacts(env,g));
  else if (mode === 'seals') output(env,await sealArtifacts(env,verifyHandoff(env,g)));
  else { assert.equal(mode,'restore'); verifyPackages(env,g,true); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.env,process.argv[2]);
