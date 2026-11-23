import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { operations, paths, sha256, verifyHandoff } from './root-promotion-custody.mjs';
import { assertExactRoutes, checkFresh, versionMessage } from './root-promotion-live.mjs';
import { transition } from './promote-root-pair.mjs';

// Test only sequencing below custody, with in-memory counters. No credentials, approved production SHA, environment grant or remotely consumable receipt.
function fixture(op){
  const g={source:'test-only',operation:op,minimumProducerSequence:7,fromVersion:'before',fromDeployment:'old',controlSha256:'control',bridge:op==='root-install-bridge'?null:{}};
  const role=operations[op],h={directions:{rollback:{manifestSha256:'R'},forward:{manifestSha256:'F'}}},c={role,h,manifest:h.directions[role].manifestSha256,expiresAt:Date.now()+60000,pair:{files:{headersSha256:'paired-headers'}}};
  const from=op==='root-restore-rollback'?'forward':'rollback',prior={'workers/tag':g.source,'workers/message':versionMessage(from,h.directions[from].manifestSha256)};
  const before={version:'before',deployment:'old',controlSha256:'control',annotations:prior,headersSha256:op==='root-install-bridge'?'0c713a5d956b36052396b0bdf21034caa04ad14bf11fce83a5240f032b208407':'paired-headers'};
  let message;const calls=[];
  const io={observe(){calls.push('observe');return message?{version:'after',deployment:'new',controlSha256:'control',headersSha256:'paired-headers',annotations:{'workers/tag':g.source,'workers/message':message}}:before;},
    head(){calls.push('head');return {sequence:7,expiresAt:c.expiresAt};},main(){calls.push('main');},checkRestored(){calls.push('restored');},
    served(r,docs){calls.push(`get:${r}:${docs}`);},browser(r){calls.push(`ui:${r}`);},publish(m){calls.push('write');message=m;}};
  return {g,c,io,calls,before};
}
test('all four authorized routes are exact; missing canary-gated ingress, wildcard, replacement, extra or fail-open route blocks promotion',()=>{
  const enrolled={read:'/api/joint-supply/v2',publisherWorker:'collection-kit-conditional-production'};
  const routes=[
    ['863270c636c945b8b788c329c9762f50','/preview/*','collection-kit-site-preview-k1r2'],
    ['483199a1890b4fb696b38d53b6d63e3c','/api/calendar',enrolled.publisherWorker],
    ['85e95eb76fd94eeba4531b7b26caa11c',enrolled.read,enrolled.publisherWorker],
    ['a'.repeat(32),'/api/recalculation-incident','collection-kit-production-incidents'],
  ].map(([id,p,script])=>({id,pattern:`nikkecollection.com${p}`,script,request_limit_fail_open:false}));
  assert.doesNotThrow(()=>assertExactRoutes(routes.toReversed(),enrolled));
  for(const altered of [routes.slice(0,-1),[...routes,{...routes[3],id:'d'.repeat(32)}],
    routes.with(3,{...routes[3],pattern:routes[3].pattern+'*'}),routes.with(3,{...routes[3],script:enrolled.publisherWorker}),
    routes.with(1,{...routes[1],id:'c'.repeat(32)}),routes.with(3,{...routes[3],request_limit_fail_open:true})])
    assert.throws(()=>assertExactRoutes(altered,enrolled));
});
for(const [operation,expected,pre] of [['root-install-bridge','BRIDGE_READY','get:rollback:true'],['root-activate-forward','FORWARD_ACTIVE','get:rollback:false'],['root-restore-rollback','ROLLBACK_ACTIVE',null]]){
  test(`${operation}: verify head/control/bytes, one write, check actual target before ${expected}`,async()=>{
    const f=fixture(operation),r=await transition(f.g,f.c,f.io);assert.equal(r.state,expected);
    const i=f.calls.indexOf('write');assert.equal(f.calls.filter(x=>x==='write').length,1);assert(f.calls.slice(0,i).includes('restored'));
    assert(f.calls.slice(0,i).includes('main')&&f.calls.slice(0,i).includes('head'));if(pre)assert(f.calls.slice(0,i).includes(pre));else assert(!f.calls.slice(0,i).some(x=>x.startsWith('get:')));
    assert(f.calls.slice(i).includes(`get:${f.c.role}:false`));assert(f.calls.slice(i).includes(`ui:${f.c.role}`));assert.equal(r.end.deployment,'new');
  });
}
test('forward refuses a missing bridge, wrong role or seal marker, drifted live version, expiry, stale signed floor or altered assets without writing',async()=>{
  for(const change of [f=>{f.g.bridge=null;},f=>{f.c.role='rollback';},f=>{f.before.annotations['workers/message']='unrelated';},f=>{f.g.fromVersion='other';},
    f=>{f.before.headersSha256='substituted';},
    f=>{f.before.controlSha256='drift';},f=>{f.c.expiresAt=0;},f=>{f.g.minimumProducerSequence=8;},f=>{f.io.checkRestored=()=>{throw Error('tamper');};},
    f=>{f.io.main=()=>{throw Error('revoked run');};},f=>{f.io.served=()=>{throw Error('missing coexistence asset');};}]){
    const f=fixture('root-activate-forward');change(f);await assert.rejects(transition(f.g,f.c,f.io));assert(!f.calls.includes('write'));
  }
});
test('a failed public readback is not READY and does not retry a write',async()=>{
  for(const fail of ['browser','served','observe']){const f=fixture('root-install-bridge'),original=f.io[fail];f.io[fail]=(...args)=>{if(f.calls.includes('write'))throw Error('post-readback mismatch');return original(...args);};
    await assert.rejects(transition(f.g,f.c,f.io),/post-readback mismatch/);assert.equal(f.calls.filter(x=>x==='write').length,1);}
});
test('cross-run handoff rejects substitution and missing genuine bridge evidence before restore',t=>{
  const tmp=mkdtempSync(join(tmpdir(),'pair-custody-test-'));t.after(()=>rmSync(tmp,{recursive:true,force:true}));const env={RUNNER_TEMP:tmp,REVIEW_RUN:'1',REVIEW_ARTIFACT:'2',ROOT_PAIR_REVIEW_SHA256:sha256('private-test')};
  const p=paths(env);mkdirSync(p.receipt,{recursive:true});const role=(k,id)=>({artifactId:id,manifestSha256:sha256(k),artifactSha256:sha256(k+k)});
  const receipt={profile:'production-root-pair-handoff-v1',deployed:false,repository:'fixture/only',sha:'test',run:'3',attempt:'1',reviewRun:'1',reviewArtifact:'2',reviewSha256:env.ROOT_PAIR_REVIEW_SHA256,directions:{rollback:role('r','4'),forward:role('f','5')}};
  const bytes=JSON.stringify(receipt);writeFileSync(join(p.receipt,'handoff.json'),bytes);
  const g={operation:'root-activate-forward',repository:receipt.repository,source:'test',prepareRun:'3',prepareAttempt:'1',handoffSha256:sha256(bytes),bridge:{stateSha256:sha256('none')}};
  assert.throws(()=>verifyHandoff(env,g),{code:'ENOENT'});assert.throws(()=>verifyHandoff(env,{...g,handoffSha256:sha256('swapped')}),/promotion bytes differ/);
  assert.throws(()=>verifyHandoff(env,{...g,prepareAttempt:'2'}));
  receipt.directions.forward.artifactId=receipt.directions.rollback.artifactId;const changed=JSON.stringify(receipt);writeFileSync(join(p.receipt,'handoff.json'),changed);
  assert.throws(()=>verifyHandoff(env,{...g,handoffSha256:sha256(changed)}),{code:'ERR_ASSERTION'});
});
test('manual public operations are explicit, all artifacts ID-selected, only the guarded final step receives the Site credential',()=>{
  const path=resolve(import.meta.dirname,'../../.github/workflows/site-worker-promote.yml');const w=JSON.parse(execFileSync('ruby',['-rjson','-ryaml','-e','print JSON.generate(YAML.safe_load(STDIN.read))'],{input:readFileSync(path)}));
  const j=w.jobs['publish-root-pair'];assert.equal(j.environment,'cloudflare-site-production');assert.equal(w.concurrency.group,'cloudflare-site-production');assert.equal(w.concurrency['cancel-in-progress'],false);
  assert.match(j.if,/github.ref_protected/);assert.match(j.if,/inputs.deploy_sha == github.sha/);for(const k of Object.keys(operations))assert(j.if.includes(k));
  assert.deepEqual(j.permissions,{contents:'read',actions:'read'});assert.equal(j.needs,undefined);assert.deepEqual(Object.keys((w.on??w.true).workflow_dispatch.inputs).sort(),['deploy_sha','operation']);
  const dl=j.steps.filter(s=>s.uses?.startsWith('actions/download-artifact@'));assert.equal(dl.length,5);assert(dl.every(s=>s.with['artifact-ids']&&s.with['run-id']&&!s.with.name));
  const [write]=j.steps.filter(s=>s.env?.CLOUDFLARE_API_TOKEN);assert.equal(write.run,'node scripts/deploy-site.ts production-root-sealed "$GITHUB_SHA"');
  assert.equal(j.steps.filter(s=>JSON.stringify(s).includes('secrets.CLOUDFLARE_SITE_API_TOKEN')).length,1);assert.equal(j.steps.at(-1).if,undefined);assert(j.steps.at(-1).uses.startsWith('actions/upload-artifact@'));
  assert(j.steps.findIndex(s=>s.run?.endsWith('custody.mjs restore'))<j.steps.indexOf(write));
});
const capture=process.env.ROOT_PROMOTION_SIGNED_CAPTURE;
test('archived genuine signed producer wires pass at their actual capture time; alteration or lease expiry fails', {skip:capture?false:'requires original retained public capture (no synthetic signer)'},()=>{
  const read=p=>JSON.parse(readFileSync(p));const enrolled=read(resolve(import.meta.dirname,'../../site-worker/production-root-release-v1.json'));
  const wires=['joint','calendar','version'].map(k=>read(join(capture,k+'.body'))),sent=Math.min(...['joint','calendar','version'].map(k=>read(join(capture,k+'.response.json')).sent));
  const at=read(join(capture,'verified.json')).at;assert.equal(checkFresh(enrolled,wires,sent,at).sequence,read(join(capture,'verified.json')).slot);
  assert.throws(()=>checkFresh(enrolled,wires,sent,sent+60001),/expired/);wires[0].statement+=' ';assert.throws(()=>checkFresh(enrolled,wires,sent,at),/bad producer signature/);
});
