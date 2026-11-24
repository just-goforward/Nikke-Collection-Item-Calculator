// Verification only. Neither signer nor any approval-producing operation belongs in release code.
import assert from 'node:assert/strict';
import { createPublicKey, hash, verify } from 'node:crypto';

import {restoreBeacon} from './root-rum-bytes.mjs';

const digest = /^[0-9a-f]{64}$/;
const text = v => assert(typeof v === 'string' && v.trim().length > 0 && v.length <= 8192);
const sha = bytes => hash('sha256', bytes);
const repo = 'just-goforward/Nikke-Collection-Item-Calculator';
function signed(envelope, key) {
  const { statement, signature } = JSON.parse(envelope);
  assert(typeof statement === 'string' && statement.length <= 32768);
  const pub = createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:key},format:'jwk'});
  assert.match(signature,/^[A-Za-z0-9+/]{86}==$/);
  assert(verify(null,Buffer.from(statement),pub,Buffer.from(signature,'base64')), 'release record signature rejected');
  return JSON.parse(statement);
}
// Scope is produced from the live consumer inputs, never copied out of the approval.
export function checkSwitchAuthority(env, source, operation, scope, now = Date.now()) {
  const keys = JSON.parse(env.ROOT_SWITCH_SIGNERS);
  for (const k of [keys.owner, keys.review]) { assert.match(k,/^[A-Za-z0-9_-]{43}$/); assert.equal(Buffer.from(k,'base64url').toString('base64url'),k); }
  assert.notEqual(keys.owner,keys.review,'separate technical review custody required');
  assert.match(source,/^[0-9a-f]{40}$/);
  const review = signed(env.ROOT_TECHNICAL_REVIEW,keys.review);
  assert.equal(review.kind,'independent-technical-review-v1'); assert.equal(review.repository,repo); assert.equal(review.source,source);
  const pair=scope.pair; for(const name of ['packet','rehearsal','forward','rollback']) assert.match(pair[name],digest);
  assert.notEqual(pair.forward,pair.rollback); assert.deepEqual(review.pair,pair,'technical review of this rehearsed pair required');
  for(const f of ['reviewer','method','diff','controls','failures','exposure','rollback','disposition']) text(review[f]);
  assert.equal(review.openBlockers,0); assert.equal(review.releaseAuthorization,false);
  if(['root-restore-rollback','root-abandon-bridge'].includes(operation))assert(scope.restoreRum,'rollback-specific independent review required');
  if(scope.restoreRum) {
    assert(['root-restore-rollback','root-abandon-bridge','root-reconcile'].includes(operation));
    assert.deepEqual(review.restoreRum,scope.restoreRum,'independent review of rollback tag and effective config required');
    restoreBeacon(scope.restoreRum);
    assert(scope.restoreRum.observedAt<=review.reviewedAt && now-scope.restoreRum.observedAt<=3600000,'fresh independently observed restore evidence required');
  } else assert.equal(review.restoreRum,undefined,'restore review cannot authorize other operations');
  const decision = signed(env.ROOT_OWNER_DECISION,keys.owner);
  assert.equal(decision.kind,'single-owner-switch-v1'); assert.equal(decision.ownerId,281915448); assert.equal(decision.repository,repo);
  assert.equal(decision.source,source); assert.equal(decision.operation,operation); assert.equal(decision.decision,'APPROVE_THIS_OPERATION');
  assert.equal(decision.reviewSha256,sha(env.ROOT_TECHNICAL_REVIEW)); assert.equal(decision.scopeSha256,sha(JSON.stringify(scope)));
  text(decision.risks); assert.equal(decision.otherGatesWaived,false);
  assert(Number.isSafeInteger(review.reviewedAt) && review.reviewedAt > 0 && review.reviewedAt <= decision.issuedAt);
  assert(Number.isSafeInteger(decision.issuedAt) && Number.isSafeInteger(decision.expiresAt) && decision.issuedAt <= now && now < decision.expiresAt && decision.expiresAt - decision.issuedAt <= 3600000,'owner window absent or expired');
  return {reviewSha256:decision.reviewSha256,ownerDecisionSha256:sha(env.ROOT_OWNER_DECISION),expiresAt:Math.min(decision.expiresAt,scope.restoreRum?scope.restoreRum.observedAt+3600000:Infinity)};
}
export function siteScope(env,g,h) {
  for(const value of [h.packetSha256,h.rehearsalSha256,h.directions.forward.manifestSha256,h.directions.rollback.manifestSha256]) assert.match(value,digest);
  const restore=['root-restore-rollback','root-abandon-bridge'].includes(g.operation);
  if(restore){restoreBeacon(g.restoreRum);assert.equal(g.restoreRum.configSha256,g.rumConfigSha256);}
  else assert.equal(g.restoreRum,undefined,'rollback exception outside restore');
  return {...(restore && {restoreRum:g.restoreRum}),run:env.GITHUB_RUN_ID,attempt:env.GITHUB_RUN_ATTEMPT,grantSha256:sha(env.ROOT_SITE_TRANSITION),handoff:g.handoffSha256,
    pair:{packet:h.packetSha256,rehearsal:h.rehearsalSha256,forward:h.directions.forward.manifestSha256,rollback:h.directions.rollback.manifestSha256}};
}
function checkDirectionProof(proof,pair,packetSha256,source,now) {
  assert.equal(proof.source,source);assert.equal(proof.packetSha256,packetSha256);
  assert.equal(proof.publicTrafficSwitched,false);assert(Number.isSafeInteger(proof.startedAt) && Number.isSafeInteger(proof.finishedAt) && proof.startedAt>0 && proof.startedAt<=proof.finishedAt && proof.finishedAt<=now);
  assert.deepEqual(proof.results.map(r=>[r.before,r.after]),[['rollback','forward'],['forward','rollback']]);
  for(const r of proof.results) {
    assert.equal(Object.keys(r.documents).length,12);
    for(const prefix of ['/','/en/','/ja/']) for(const name of ['index','privacy','terms','licenses']) {const path=prefix+name+'.html';assert.equal(r.documents[path],pair.files[r.after][path].sha256);}
    const expected=new Map();
    function legacy(role,tree,key,locale) {
      const sha256=pair.files.rollback[key].sha256;assert.equal(pair.files[tree][key].sha256,sha256);
      expected.set(`${role}:${key}`,{row:{role,tree,key,sha256,method:'GET',path:`legacy-cdn-stylesheet-${locale}`,blocked:true,requestfailed:true},count:0});
    }
    if(r.before==='rollback')legacy('old','rollback','/index.html','ko');
    for(const [prefix,locale] of [['/','ko'],['/en/','en'],['/ja/','ja']])for(const name of ['index','privacy','terms','licenses']){
      if(name!=='index'||r.after==='rollback')legacy('new',r.after,prefix+name+'.html',locale);
    }
    assert(Array.isArray(r.blockedFonts) && r.blockedFonts.length<=15);
    for(const row of r.blockedFonts){
      const target=expected.get(`${row.role}:${row.key}`);assert(target);assert.deepEqual(row,target.row);
      assert(++target.count<=(row.key.endsWith('/index.html')?2:1));
    }
    for(const t of expected.values())assert(t.count>0,'missing historical font block');
    const lazy=r.before==='rollback'?['/assets/browserWorker-EkFyhckN.js','/wasm/certified_solver.88553a72d8503d2c7c78366e3d85bbee0cd9dfd738ac94d588fb09bd9d5942ae.wasm']:['/'+pair.worker,'/wasm/service-fused-h14-'+pair.review.nativeWasmSha256+'.wasm'];
    assert(r.gets.some(g=>g.active===r.before && g.switched===false && g.p==='/' && g.sha256===pair.files[r.before]['/index.html'].sha256));
    for(const path of lazy) assert(r.gets.some(g=>g.active===r.after && g.switched===true && g.p===path && g.sha256===pair.files[r.before][path].sha256),'old tab did not fetch its retained lazy bytes');
  }
}
export function checkRehearsal(proof,pair,packetSha256,source,now=Date.now()) {
  assert.equal(proof.profile,'sealed-root-rehearsal-v2');checkDirectionProof(proof,pair,packetSha256,source,now);
}
export function checkTabCanary(proof,pair,packetSha256,source,now=Date.now()) {
  assert.equal(proof.profile,'private-root-tab-canary-v2');checkDirectionProof(proof,pair,packetSha256,source,now);
}
