import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {isAbsolute, join, relative} from 'node:path';
import {inventory, inventoryDigest} from './hybrid-b-policy-inventory.mjs';
import {root, sha256} from './hybrid-b-policy-package.mjs';

export function harnessSource() {
  const git = (...args) => execFileSync('git', args, {cwd:root, encoding:'utf8'}).trim();
  assert.equal(git('status','--porcelain','--untracked-files=all'), '', 'clean committed test source required');
  const head = git('rev-parse','HEAD');
  for (const suite of ['product','analytics']) {
    const {config,spec} = inventory(suite);
    git('ls-files','--error-unmatch','--',config,spec);
  }
  return head;
}
export function evidenceDir() {
  const dir = process.env.ROOT_POLICY_EVIDENCE_DIR;
  assert(typeof dir === 'string' && isAbsolute(dir) && dir === realpathSync(dir));
  const stat = lstatSync(dir), rel = relative(root,dir);
  assert(stat.isDirectory() && (stat.mode & 0o077) === 0 && (rel === '..' || rel.startsWith('../')), 'private external evidence directory required');
  return dir;
}
function pathFor(dir,suite,kind) {
  if (suite === 'campaign' && kind === 'open') return join(dir,'hybrid-b-campaign.json');
  inventory(suite);
  assert(['claim','report','exit'].includes(kind));
  return join(dir,`hybrid-b-${suite}-${kind}.json`);
}
export function record(dir,suite,kind,value) {
  const bytes = JSON.stringify(value) + '\n';
  assert(Buffer.byteLength(bytes) <= 16*1024);
  writeFileSync(pathFor(dir,suite,kind), bytes, {flag:'wx',mode:0o600});
  return sha256(bytes);
}
export function load(dir,suite,kind) {
  const path = pathFor(dir,suite,kind), st = lstatSync(path);
  assert.equal(realpathSync(path),path);
  assert(st.isFile() && st.nlink === 1 && (st.mode & 0o077) === 0 && st.size > 0 && st.size <= 16*1024);
  const bytes = readFileSync(path);
  return {value:JSON.parse(bytes),digest:sha256(bytes)};
}
export function checkControl(value,source,packetSha256) {
  assert.deepEqual(value,{profile:'hybrid-b-supply-control-v1',source,packetSha256,policy:'adaptive-next-batch-balanced-v1',
    supplySha256:value.supplySha256,input:['R',14,800,0,0,30],expected:'wait',oracleSha256:value.oracleSha256,
    verifiedAt:value.verifiedAt,releaseAdmission:false});
  for(const p of [packetSha256,value.oracleSha256,value.supplySha256]) assert.match(p,/^[0-9a-f]{64}$/);
  assert(Number.isSafeInteger(value.verifiedAt) && value.verifiedAt>0 && value.verifiedAt<=Date.now());
  return value;
}
export function controlFromCustody(source,packetSha256) {
  const file=process.env.ROOT_POLICY_CONTROL_FILE;
  assert(file && isAbsolute(file) && realpathSync(file)===file);
  const st=lstatSync(file); assert(st.isFile() && st.size>0 && st.size<=16384);
  const bytes=readFileSync(file),digest=sha256(bytes); assert.equal(digest,process.env.ROOT_POLICY_CONTROL_SHA256);
  return {digest,value:checkControl(JSON.parse(bytes),source,packetSha256)};
}
export function supplyProjectionSha256({sequence,issuedAt,expiresAt,...supply}) {
  // Only the signed envelope clock rotates. Keep basis sequence, game day, laws, events,
  // status, omissions and every other field in original statement order.
  return sha256(JSON.stringify(supply));
}
const campaignFor = (id,packetSha256,harness,controlSha256) => {
  assert.match(controlSha256,/^[0-9a-f]{64}$/);
  return {profile:'hybrid-b-policy-campaign-v2',id,packetSha256,harness,controlSha256,releaseAdmission:false};
};
export function openCampaign(dir,packetSha256,harness,controlSha256) {
  assert.deepEqual(readdirSync(dir), [], 'campaign requires an empty custody directory');
  return record(dir,'campaign','open',campaignFor(randomUUID(),packetSha256,harness,controlSha256));
}
export function readCampaign(dir,packetSha256,harness,expected,controlSha256) {
  const {value,digest} = load(dir,'campaign','open');
  assert.equal(digest,expected,'previously retained campaign digest required');
  assert.match(value.id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(value,campaignFor(value.id,packetSha256,harness,controlSha256));
  return digest;
}
export const claimFor = (suite,packetSha256,harness,campaignSha256) => ({profile:'hybrid-b-policy-first-attempt-v1', suite,
  packetSha256, harness, campaignSha256, inventorySha256:inventoryDigest(suite), attempt:1, releaseAdmission:false});
export const knownStatus = status => ['passed','failed','skipped','timedOut','interrupted'].includes(status);
export function validateReport(value,suite,claimSha256) {
  const cases = inventory(suite).cases.map(({id}) => ({id, attemptCount:1, attempts:[{retry:0, status:'passed'}]}));
  assert.deepEqual(value, {profile:'hybrid-b-policy-observation-v1',suite,claimSha256, cases,
    frameworkStatus:'passed', complete:true, releaseAdmission:false}, 'incomplete, retried or foreign policy observation');
}
export const exitFor = (suite,claimSha256,reportSha256,verified) => ({profile:'hybrid-b-policy-process-exit-v1', suite,
  claimSha256, reportSha256, verified, releaseAdmission:false});
export function readFirstAttempt(dir,suite,identity,harness,campaignSha256) {
  const claim = load(dir,suite,'claim'), report = load(dir,suite,'report'), exit = load(dir,suite,'exit');
  assert.deepEqual(claim.value, claimFor(suite,identity.packetSha256,harness,campaignSha256));
  validateReport(report.value,suite,claim.digest);
  assert.deepEqual(exit.value,exitFor(suite,claim.digest,report.digest,true));
  return {suite,claimSha256:claim.digest,reportSha256:report.digest,exitSha256:exit.digest,passed:report.value.cases.length};
}
