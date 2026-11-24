import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { operations, paths, readTransition, sha256, verifyHandoff } from './root-promotion-custody.mjs';
import { assertExactRoutes, checkFresh, versionMessage } from './root-promotion-live.mjs';
import { rootGet } from './root-promotion-get.mjs';
import {stageU} from './incident-stage-u-evidence.mjs';
import { transition as publishTransition, confirmTransition, confirmBridgeExit, readWriteCheckpoint } from './promote-root-pair.mjs';

// Test only sequencing below custody, with in-memory counters. No credentials, approved production SHA, environment grant or remotely consumable receipt.
const after='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const incident={version:stageU.version,build:stageU.build,deployment:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeef'};
const transition=async(g,c,io)=>confirmTransition(g,c,await publishTransition(g,c,io),io,async()=>{});
test('without a verified layout receiver receipt no Site grant is read, in either direction',()=>{
  for(const op of [...Object.keys(operations),'root-reconcile'])
    assert.throws(()=>readTransition({ROOT_OPERATION:op}),/no verified receiver for this candidate build/);
});
function fixture(op){
  const g={source:'test-only',operation:op,minimumProducerSequence:7,fromVersion:'before',fromDeployment:'old',controlSha256:'control',rumConfigSha256:sha256('config'),previewSha256:sha256('[]'),bridge:op==='root-install-bridge'?null:{}};
  const role=operations[op],h={directions:{rollback:{manifestSha256:'R'},forward:{manifestSha256:'F'}}},c={role,h,manifest:h.directions[role].manifestSha256,expiresAt:Date.now()+60000,pair:{files:{headersSha256:'paired-headers'}}};
  const from=op==='root-restore-rollback'?'forward':'rollback',prior={'workers/tag':g.source,'workers/message':versionMessage(from,h.directions[from].manifestSha256)};
  const before={version:'before',deployment:'old',controlSha256:'control',incident,annotations:prior,headersSha256:op==='root-install-bridge'?'0c713a5d956b36052396b0bdf21034caa04ad14bf11fce83a5240f032b208407':'paired-headers'};
  let message;const calls=[];
  const io={observe(){calls.push('observe');return message?{version:after,deployment:'new',controlSha256:'control',incident,headersSha256:'paired-headers',annotations:{'workers/tag':g.source,'workers/message':message}}:before;},
    head(){calls.push('head');return {sequence:7,expiresAt:c.expiresAt};},main(){calls.push('main');},checkRestored(){calls.push('restored');},
    lineage(){calls.push('lineage');},rum(){calls.push('rum');return {config:{lite:true},configSha256:g.rumConfigSha256};},
    served(r,docs){calls.push(`get:${r}:${docs}`);},browser(r,mode){assert.equal(mode,op==='root-restore-rollback' && !message?'restore-preflight':'full');calls.push(`ui:${r}:${mode}`);return [{egress:'non-EU',egressId:'fixture',runnerSha256:'fixture',previews:[]}];},publish(m){calls.push('write');message=m;return after;}};
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
test('separate EU and non-EU browser capabilities must match the independently enrolled endpoints',async()=>{
  const {regionalBrowsers}=await import('./root-promotion-browser.mjs');
  const eu='wss://eu.example/test',non='wss://non.example/test';
  const grant={euAssurance:'two-region-v1',regionalBrowsers:{EU:sha256(eu),'non-EU':sha256(non)}};
  const sub={euAssurance:'config-substitute-v1',regionalBrowsers:{'non-EU':sha256(non)}};
  assert.deepEqual(regionalBrowsers(sub,{ROOT_BROWSER_NON_EU:non}).map(r=>r.egress),['non-EU']);
  assert.throws(()=>regionalBrowsers(sub,{})); assert.throws(()=>regionalBrowsers({...grant,euAssurance:undefined},{}));
  assert.deepEqual(regionalBrowsers(grant,{ROOT_BROWSER_EU:eu,ROOT_BROWSER_NON_EU:non}).map(b=>b.egress),['EU','non-EU']);
  for(const bad of [undefined,eu,'ws://other.example/test','wss://eu.example/other','wss://other.example/test'])
    assert.throws(()=>regionalBrowsers(grant,{ROOT_BROWSER_EU:eu,ROOT_BROWSER_NON_EU:bad}));
});
for(const [operation,expected,pre] of [['root-install-bridge','BRIDGE_READY','get:rollback:true'],['root-activate-forward','FORWARD_ACTIVE','get:rollback:false'],['root-restore-rollback','ROLLBACK_ACTIVE',null]]){
  test(`${operation}: verify head/control/bytes, one write, check actual target before ${expected}`,async()=>{
    const f=fixture(operation),r=await transition(f.g,f.c,f.io);assert.equal(r.state,expected);
    const i=f.calls.indexOf('write');assert.equal(f.calls.filter(x=>x==='write').length,1);assert(f.calls.slice(0,i).includes('restored'));
    assert(f.calls.slice(0,i).includes(`ui:${pre?'rollback:full':'forward:restore-preflight'}`));
    assert.deepEqual(f.calls.filter(x=>x==='rum'||x==='write'),['rum','write','rum']);
    assert(f.calls.slice(0,i).includes('main')&&f.calls.slice(0,i).includes('head'));if(pre)assert(f.calls.slice(0,i).includes(pre));else assert(!f.calls.slice(0,i).some(x=>x.startsWith('get:')));
    assert(f.calls.slice(i).includes(`get:${f.c.role}:false`));assert(f.calls.slice(i).includes(`ui:${f.c.role}:full`));assert.equal(r.end.deployment,'new');
  });
}
test('each Site write and terminal readback needs the same verified active incident identity',async()=>{
  for(const op of ['root-install-bridge','root-activate-forward','root-restore-rollback','root-abandon-bridge']){
    for(const side of ['pre','post'])for(const patch of [{version:'00323557-9e9f-470f-b491-3906316f5d69'},{build:sha256('other build')}]){
      const f=fixture(op),observe=f.io.observe;let n=0;
      f.io.observe=()=>{const live=observe();++n;
        const change=side==='pre'?n===1:op==='root-abandon-bridge'?n===2:f.calls.includes('write');
        return change?{...live,incident:{...incident,...patch}}:live;};
      if(op==='root-abandon-bridge')await assert.rejects(confirmBridgeExit(f.g,f.c,f.io));
      else await assert.rejects(transition(f.g,f.c,f.io));
      assert.equal(f.calls.filter(s=>s==='write').length,side==='post' && op!=='root-abandon-bridge'?1:0);
    }
  }
});
test('forward refuses a missing bridge, wrong role or seal marker, drifted live version, expiry, stale signed floor or altered assets without writing',async()=>{
  for(const change of [f=>{f.g.bridge=null;},f=>{f.c.role='rollback';},f=>{f.before.annotations['workers/message']='unrelated';},f=>{f.g.fromVersion='other';},
    f=>{f.before.headersSha256='substituted';},
    f=>{f.before.controlSha256='drift';},f=>{f.c.expiresAt=0;},f=>{f.g.minimumProducerSequence=8;},f=>{f.io.checkRestored=()=>{throw Error('tamper');};},
    f=>{f.g.previewSha256=sha256('changed CSP');},
    f=>{f.io.browser=()=>{throw Error('regional preflight failed');};},
    f=>{f.io.rum=()=>{throw Error('missing provider check');};},
    f=>{f.io.main=()=>{throw Error('revoked run');};},f=>{f.io.served=()=>{throw Error('missing coexistence asset');};}]){
    const f=fixture('root-activate-forward');change(f);await assert.rejects(transition(f.g,f.c,f.io));assert(!f.calls.includes('write'));
  }
});
test('a failed public readback is not READY and does not retry a write',async()=>{
  for(const fail of ['browser','served','observe','rum']){const f=fixture('root-install-bridge'),original=f.io[fail];f.io[fail]=(...args)=>{if(f.calls.includes('write'))throw Error('post-readback mismatch');return original(...args);};
    await assert.rejects(transition(f.g,f.c,f.io),/post-readback mismatch/);assert.equal(f.calls.filter(x=>x==='write').length,1);}
});
test('post-switch config, runner or preview drift prevents READY without another write',async()=>{
  for(const kind of ['rum','browser']) {const f=fixture('root-restore-rollback'),normal=f.io[kind];
    f.io[kind]=(...args)=>f.calls.includes('write')?(kind==='rum'?{config:{lite:false}}:[{egressId:'changed'}]):normal(...args);
    await assert.rejects(transition(f.g,f.c,f.io));assert.equal(f.calls.filter(s=>s==='write').length,1);}
});
test('failed health check keeps the ACK, not a READY receipt; subsequent invocation has only reads',async t=>{
  const f=fixture('root-restore-rollback'),written=await publishTransition(f.g,f.c,f.io),dir=mkdtempSync(join(tmpdir(),'ack-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const identity={run:'12',attempt:'1',handoffSha256:sha256('test pair'),operation:f.g.operation},file=join(dir,'write.json');
  const bytes=JSON.stringify({identity,ack:written});writeFileSync(file,bytes);
  const ack=readWriteCheckpoint(file,identity,sha256(bytes));
  for(const change of [{run:'13'},{attempt:'2'},{handoffSha256:sha256('other')},{operation:'root-activate-forward'}])
    assert.throws(()=>readWriteCheckpoint(file,{...identity,...change},sha256(bytes)));
  assert.throws(()=>readWriteCheckpoint(file,identity,sha256(bytes+' ')));
  const {publish, ...read}=f.io, noDelay=async()=>{}; let reads=0;
  await assert.rejects(confirmTransition(f.g,f.c,ack,{...read,browser(){reads++;throw Error('unreviewed HTML drift');}},noDelay),/HTML drift/);assert.equal(reads,1);
  const g={...f.g,reconcile:{deployment:'new'}};
  for(const [change,grant] of [[{version:'different'},g],[{}, {...g,reconcile:{deployment:'other'}}]])
    await assert.rejects(confirmTransition(grant,f.c,{...ack,...change},read,noDelay));
  await assert.rejects(confirmTransition(g,f.c,ack,{...read,lineage(){throw Error('intervening deployment');}},noDelay),/intervening/);
  let count=0;const pauses=[];
  const result=await confirmTransition(g,f.c,ack,{...read,observe:()=>++count<=2?f.before:read.observe()},async ms=>pauses.push(ms));
  assert.deepEqual(pauses,[1000,3000]);assert.equal(result.state,'ROLLBACK_ACTIVE');assert.equal(f.calls.filter(s=>s==='write').length,1);
  const stale=[];await assert.rejects(confirmTransition(g,f.c,ack,{...read,observe:()=>f.before},async ms=>stale.push(ms)),/write ACK/);assert.deepEqual(stale,[1000,3000]);
});
test('explicit bridge abandonment confirms the still-owned exact rollback seal; no write and no invented restore IDs',async()=>{
  for(const fault of ['none','foreign','replaced headers','broken rollback','drifted preview']){
    const f=fixture('root-abandon-bridge'),{publish,...read}=f.io;
    if(fault==='foreign')f.g.fromDeployment='other';if(fault==='replaced headers')f.before.headersSha256='other';
    if(fault==='broken rollback')read.browser=()=>{throw Error('unhealthy');};if(fault==='drifted preview')f.g.previewSha256=sha256('other');
    await assert.rejects(publishTransition(f.g,f.c,f.io),/read-only/);
    if(fault==='none'){const r=await confirmBridgeExit(f.g,f.c,read);assert.equal(r.state,'BRIDGE_ABANDONED');assert.deepEqual(r.end,f.before);}
    else await assert.rejects(confirmBridgeExit(f.g,f.c,read));assert(!f.calls.includes('write'));
  }
});
test('acknowledged bridge without BRIDGE_READY can only be abandoned after proving the original write and full rollback health',async()=>{
  const f=fixture('root-install-bridge'),ack=await publishTransition(f.g,f.c,f.io),post=f.io.observe();
  const g={...f.g,operation:'root-abandon-bridge',bridge:null,bridgeWrite:{deployment:post.deployment},fromDeployment:post.deployment,fromVersion:post.version};
  const c={...f.c,enrolled:{priorSiteVersion:f.before.version}}, {publish,...read}=f.io;
  const r=await confirmBridgeExit(g,c,read,ack);assert.equal(r.state,'BRIDGE_ABANDONED');assert.deepEqual(r.end,post);
  for(const bad of [undefined,{...ack,version:'other'},{...ack,before:{...ack.before,version:'other'}},{...ack,preflight:[]},{...ack,preConfig:{config:{lite:false}}}])
    await assert.rejects(confirmBridgeExit(g,c,read,bad));
  await assert.rejects(confirmBridgeExit(g,c,{...read,lineage(){throw Error('overtaken');}},ack),/overtaken/);
  assert.equal(f.calls.filter(x=>x==='write').length,1);
});
test('bounded GET retry covers network/temporary status; denials and complete mismatches are not retried',async()=>{
  for(const statuses of [[0,503,200],[503,503,503],[403],[200]]){
    const seen=[],delays=[];const r=await rootGet('https://example.invalid/',{},async(_,opts)=>{assert.equal(opts.method,'GET');const s=statuses[seen.length];seen.push(s);if(!s)throw Error('network');return new Response(null,{status:s});},async ms=>delays.push(ms));
    assert.deepEqual(seen,statuses);assert.equal(r.status,statuses.at(-1));assert.deepEqual(delays,statuses.length===1?[]:[250,1000]);
  }
});
test('cross-run handoff rejects substitution and missing genuine bridge evidence before restore',t=>{
  const tmp=mkdtempSync(join(tmpdir(),'pair-custody-test-'));t.after(()=>rmSync(tmp,{recursive:true,force:true}));const env={RUNNER_TEMP:tmp,REVIEW_RUN:'1',REVIEW_ARTIFACT:'2',ROOT_PAIR_REVIEW_SHA256:sha256('private-test')};
  const p=paths(env);mkdirSync(p.receipt,{recursive:true});const role=(k,id)=>({artifactId:id,manifestSha256:sha256(k),artifactSha256:sha256(k+k)});
  const receipt={profile:'production-root-pair-handoff-v1',deployed:false,repository:'fixture/only',sha:'test',run:'3',attempt:'1',reviewRun:'1',reviewArtifact:'2',reviewSha256:env.ROOT_PAIR_REVIEW_SHA256,directions:{rollback:role('r','4'),forward:role('f','5')}};
  const bytes=JSON.stringify(receipt);writeFileSync(join(p.receipt,'handoff.json'),bytes);
  const g={operation:'root-activate-forward',repository:receipt.repository,source:'test',prepareRun:'3',prepareAttempt:'1',handoffSha256:sha256(bytes),bridge:{stateSha256:sha256('none')}};
  assert.throws(()=>verifyHandoff(env,g),{code:'ENOENT'});assert.throws(()=>verifyHandoff(env,{...g,handoffSha256:sha256('swapped')}),/promotion bytes differ/);
  assert.throws(()=>verifyHandoff(env,{...g,prepareAttempt:'2'}));
  mkdirSync(join(p.base,'bridge'));const v='11111111-2222-3333-4444-555555555555',d='11111111-2222-3333-4444-555555555556';
  const b=JSON.stringify({profile:'production-root-state-v1',state:'BRIDGE_READY',operation:'root-install-bridge',run:'6',attempt:'1',source:g.source,handoffSha256:g.handoffSha256,manifestSha256:receipt.directions.rollback.manifestSha256,version:v,deployment:d,controlSha256:'pinned',sequence:7});writeFileSync(p.bridge,b);
  const exit={...g,operation:'root-abandon-bridge',fromDeployment:d,fromVersion:v,bridge:{run:'6',attempt:'1',stateSha256:sha256(b)},controlSha256:'pinned',minimumProducerSequence:7};
  assert.deepEqual(verifyHandoff(env,exit),receipt);
  for(const change of [{fromDeployment:v},{fromVersion:d},{minimumProducerSequence:6},{controlSha256:'other'}])assert.throws(()=>verifyHandoff(env,{...exit,...change}));
  receipt.directions.forward.artifactId=receipt.directions.rollback.artifactId;const changed=JSON.stringify(receipt);writeFileSync(join(p.receipt,'handoff.json'),changed);
  assert.throws(()=>verifyHandoff(env,{...g,handoffSha256:sha256(changed)}),{code:'ERR_ASSERTION'});
});
test('manual public operations are explicit, all artifacts ID-selected, only the guarded final step receives the Site credential',()=>{
  const path=resolve(import.meta.dirname,'../../.github/workflows/site-worker-promote.yml');const w=JSON.parse(execFileSync('ruby',['-rjson','-ryaml','-e','print JSON.generate(YAML.safe_load(STDIN.read))'],{input:readFileSync(path)}));
  const j=w.jobs['publish-root-pair'];assert.equal(j.environment,'cloudflare-site-production');assert.equal(w.concurrency.group,'cloudflare-site-production');assert.equal(w.concurrency['cancel-in-progress'],false);
  assert.match(j.if,/github.ref_protected/);assert.match(j.if,/inputs.deploy_sha == github.sha/);for(const k of Object.keys(operations))assert(j.if.includes(k));
  assert.deepEqual(j.permissions,{contents:'read',actions:'read'});assert.equal(j.needs,undefined);assert.deepEqual(Object.keys((w.on??w.true).workflow_dispatch.inputs).sort(),['deploy_sha','operation']);
  const dl=j.steps.filter(s=>s.uses?.startsWith('actions/download-artifact@'));assert.equal(dl.length,6);assert(dl.every(s=>s.with['artifact-ids']&&s.with['run-id']&&!s.with.name));
  const [write]=j.steps.filter(s=>s.env?.CLOUDFLARE_API_TOKEN);assert.equal(write.run,'node scripts/deploy-site.ts production-root-sealed "$GITHUB_SHA"');
  assert.equal(j.steps.filter(s=>JSON.stringify(s).includes('secrets.CLOUDFLARE_SITE_API_TOKEN')).length,1);assert.equal(j.steps.at(-1).if,undefined);assert(j.steps.at(-1).uses.startsWith('actions/upload-artifact@'));
  assert(j.steps.findIndex(s=>s.run?.endsWith('custody.mjs restore'))<j.steps.indexOf(write));
  const ack=j.steps.findIndex(s=>s.name==='Retain acknowledged root write before health checks'),confirm=j.steps.findIndex(s=>s.run?.endsWith('promote-root-pair.mjs confirm'));
  assert.equal(write.if,"inputs.operation != 'root-reconcile' && inputs.operation != 'root-abandon-bridge'");assert.equal(j.steps[ack].if,write.if);assert(j.steps.indexOf(write)<ack && ack<confirm && confirm<j.steps.length-1);
  const attest=w.jobs['attest-root-state'];assert.equal(attest.needs,'publish-root-pair');assert.equal(attest.permissions['id-token'],'write');
  assert(!JSON.stringify(attest).includes('secrets.'));assert.equal(attest.steps[0].with['artifact-ids'],'${{ needs.publish-root-pair.outputs.state_id }}');
});
const capture=process.env.ROOT_PROMOTION_SIGNED_CAPTURE;
test('archived genuine signed producer wires pass at their actual capture time; alteration or lease expiry fails', {skip:capture?false:'requires original retained public capture (no synthetic signer)'},()=>{
  const read=p=>JSON.parse(readFileSync(p));const enrolled=read(resolve(import.meta.dirname,'../../site-worker/production-root-release-v1.json'));
  const wires=['joint','calendar','version'].map(k=>read(join(capture,k+'.body'))),sent=Math.min(...['joint','calendar','version'].map(k=>read(join(capture,k+'.response.json')).sent));
  const at=read(join(capture,'verified.json')).at;assert.equal(checkFresh(enrolled,wires,sent,at).sequence,read(join(capture,'verified.json')).slot);
  assert.throws(()=>checkFresh(enrolled,wires,sent,sent+60001),/expired/);wires[0].statement+=' ';assert.throws(()=>checkFresh(enrolled,wires,sent,at),/bad producer signature/);
});
