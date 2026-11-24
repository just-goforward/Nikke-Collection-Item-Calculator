// Offline: tests neither obtain credentials nor dispatch, deploy, POST a public report, or send a DM.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import receiver from '../../production-incidents/worker.ts';
import enrollment from '../../site-worker/production-root-release-v1.json' with {type:'json'};
import {serviceBuild} from '../../production-incidents/sealed-successor.ts';
import {original} from './incident-recovery-id.mjs';
import {db as database,digest,namespace} from './incident-provider.mjs';
import {checkedMain,checkedMobileMain,historicalEditor,publicHash} from './incident-owner-upload-only.mjs';
import {owner} from './incident-receipt.mjs';
import {checkApproval,checkRecoveryCheckout,newBuild,uploadScope} from './incident-mobile-successor.mjs';
import {readStageU,stageU} from './incident-stage-u-evidence.mjs';

test('layout review is one clean squash on #95 and exactly the combined product, receiver and release diff',()=>{
  const head='a'.repeat(40),parent='1b73c733283f3cecaaaee782fe897281493be631';
  const paths=['src/components/StockPanel.tsx','src/serviceH14/generated/build.ts','site-worker/production-root-release-v1.json',
    '.github/workflows/site-source-verify.yml','docs/root-rum-witness.md','production-incidents/RUNBOOK.ko.md',
    ...['incident-activation-control.mjs','incident-mobile-successor.mjs','incident-mobile-successor.test.mjs',
      'incident-owner-activate.mjs','incident-owner-activate.test.mjs','incident-owner-upload-only.mjs','incident-owner-upload-only.test.mjs',
      'incident-stage-u-evidence.mjs','root-promotion.test.mjs'].map(p=>'scripts/ci/'+p)];
  const commands={'rev-list --parents -n 1 HEAD':head+' '+parent,'status --porcelain --untracked-files=all':'',
    [`diff --no-renames --name-only ${parent} ${head}`]:paths.join('\n')};
  const verify=(changes={})=>checkRecoveryCheckout(head,(...args)=>({...commands,...changes})[args.join(' ')]);
  verify();
  const [ancestry,status,diff]=Object.keys(commands);
  for(const changed of [{[ancestry]:head+' '+head},{[ancestry]:head+' '+parent+' '+head},{[ancestry]:parent+' '+parent},
    {[status]:'?? local-file'},{[diff]:paths.slice(1).join('\n')},{[diff]:[...paths,'production-incidents/worker.ts'].join('\n')}])
    assert.throws(()=>verify(changed));
});

test('U requires all original jobs from one exact protected main attempt; only an absent push permits manual evidence',()=>{
  const head='a'.repeat(40),repository={id:1229775730},workflow='.github/workflows/site-source-verify.yml';
  const run={id:10,run_attempt:2,head_sha:head,head_branch:'main',path:workflow,repository,head_repository:repository,status:'completed',conclusion:'success'};
  const job=(name,...steps)=>({name,status:'completed',conclusion:'success',steps:steps.map(s=>({name:s,conclusion:'success'}))});
  const jobs=[job('Site source prerequisites','Authenticate the signed protected main tip','Verify post-successor inactive upload only (offline)',
    'Verify single inactive layout successor (offline)','Verify exact existing incident activation and rollback (offline)','Select the source profile from exact bytes, never a dispatch flag'),
    job('Production root source (no publication)','Verify formal source bindings and the two-direction preparation contract',
      'Build source-only root with the isolated pin, never the enrolled key'),job('Site source verification','Require the complete applicable source lane')];
  const branch='branches/main',commit=`commits/${head}`,pulls=commit+'/pulls',attempt='actions/runs/10/attempts/2/jobs?per_page=100';
  const list=event=>`actions/workflows/site-source-verify.yml/runs?branch=main&event=${event}&head_sha=${head}&per_page=1`;
  const response=(event,overrides={})=>({total_count:1,workflow_runs:[{...run,event,...overrides}]});
  const push=list('push'),manual=list('workflow_dispatch');
  const proof={[branch]:{protected:true,commit:{sha:head}},[commit]:{commit:{verification:{verified:true}}},
    [pulls]:[{merged_at:'2026-11-24',merge_commit_sha:head,base:{ref:'main',repo:repository}}],
    [push]:{total_count:0,workflow_runs:[]},[manual]:response('workflow_dispatch'),[attempt]:{total_count:3,jobs}};
  const verify=(changes={},gate=checkedMobileMain)=>gate(head,path=>{
    const value=({...proof,...changes})[path]; assert.ok(value,`unexpected API request: ${path}`);return value;
  });
  verify(); verify({[push]:response('push'),[manual]:null});
  assert.throws(()=>verify({},checkedMain)); // Historical upload remains push-only.
  for(const changes of [{[push]:response('push',{conclusion:'failure'})},{[push]:response('push',{status:'queued'})},
    {[branch]:{protected:false,commit:{sha:head}}},{[branch]:{protected:true,commit:{sha:'b'.repeat(40)}}},
    {[commit]:{commit:{verification:{verified:false}}}},{[pulls]:[]},{[attempt]:{total_count:4,jobs}},
    {[attempt]:{total_count:3,jobs:[jobs[0],jobs[0],jobs[2]]}}]) assert.throws(()=>verify(changes));
  for(const mutation of [{event:'pull_request'},{head_sha:'b'.repeat(40)},{head_branch:'topic'},{path:'other.yml'},
    {run_attempt:3},{head_repository:{id:1}},{repository:{id:1}},{conclusion:'cancelled'}])
    assert.throws(()=>verify({[manual]:response('workflow_dispatch',mutation)}));
  for(const [i,j] of jobs.entries()){
    for(const remove of [true,false]){
      const changed=remove?jobs.filter((_,n)=>i!==n):jobs.map((v,n)=>i===n?{...v,conclusion:'skipped'}:v);
      assert.throws(()=>verify({[attempt]:{total_count:changed.length,jobs:changed}}));
    }
    for(const [k] of j.steps.entries()){
      const changed=structuredClone(jobs);changed[i].steps[k].conclusion='skipped';
      assert.throws(()=>verify({[attempt]:{total_count:changed.length,jobs:changed}}));
    }
  }
});

test('frozen real public bundle for the successor binding reproduces the unchanged module SHA',t=>{
  const cwd=fileURLToPath(new URL('../../production-incidents/',import.meta.url)),temp=mkdtempSync(join(realpathSync(tmpdir()),'u-bundle-'));
  const path=join(cwd,'.mobile-successor-test-'+process.pid+'.json');t.after(()=>{rmSync(temp,{recursive:true,force:true});rmSync(path,{force:true});});
  const env={HOME:temp,PATH:process.env.PATH,WRANGLER_SEND_METRICS:'false',WRANGLER_SEND_ERROR_REPORTS:'false',CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:'false'};
  const b=execFileSync(process.execPath,['config.mjs','public',database,namespace,newBuild],{cwd,env});
  assert.deepEqual(JSON.parse(b).vars,{PUBLIC_INGRESS:'1',INCIDENT_BUILD:newBuild});writeFileSync(path,b,{flag:'wx'});
  execFileSync(process.execPath,['../node_modules/wrangler/bin/wrangler.js','deploy','--dry-run','--config',path,'--outdir',join(temp,'bundle')],{cwd,env,stdio:'pipe'});
  assert.equal(digest(readFileSync(join(temp,'bundle/worker.js'))),publicHash);
});
test('same receiver JS with old vs new version binding accepts exactly its one service build',async t=>{
  const builds=[serviceBuild,stageU.build,newBuild];assert.equal(enrollment.serviceCodeHash,newBuild);assert.equal(new Set(builds).size,3);
  for(const bound of builds) {
    const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(readFileSync(new URL('../../production-incidents/schema.sql',import.meta.url),'utf8'));
    const prepare=(sql,args=[])=>({bind:(...a)=>prepare(sql,a),run:()=>({meta:db.prepare(sql).run(...args)}),first:()=>db.prepare(sql).get(...args)});
    const env={PUBLIC_INGRESS:'1',INCIDENT_BUILD:bound,INGRESS:{limit:async()=>({success:true})},INCIDENT_DB:{prepare}};
    const origin='https://nikkecollection.com',post=build=>receiver.fetch(new Request(origin+'/api/recalculation-incident',{method:'POST',headers:{origin,'sec-fetch-site':'same-origin','content-type':'application/json'},body:JSON.stringify({v:1,attempt:crypto.randomUUID(),reason:'capacity',stage:'outcome',build})}),env);
    for(const other of builds.filter(b=>b!==bound))assert.equal((await post(other)).status,400);
    assert.equal(db.prepare('select count(*) n from incidents').get().n,0);
    assert.equal((await post(bound)).status,202);assert.equal(db.prepare('select build from incidents').get().build,bound);
  }
  // Stage A tests exercise the common live Site pre/post observer: neither an inactive upload nor the old active build admits a root transition.
});
test('substituted predecessor bytes never authorize a new slot',t=>{
  const dir=mkdtempSync(join(realpathSync(tmpdir()),'invalid-u-predecessor-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  writeFileSync(join(dir,original.workerId+'.json'),'{}',{mode:0o600});assert.throws(()=>readStageU(dir),/wrong original/);
});
test('corrupt retained proof fails without falling back to a new artifact',t=>{
  const dir=mkdtempSync(join(tmpdir(),'invalid-attestation-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  writeFileSync(join(dir,'installed.json'),'{}');assert.throws(()=>historicalEditor(dir),/retained provenance digest mismatch/);
});
test('owner decision and signed independent review bind this exact merged SHA, editor, graph, build and expiry',()=>{
  const now=Date.now(),head='f'.repeat(40),scope=uploadScope(head,Math.floor(now/1000)+300,'c'.repeat(64),'1'.repeat(32),'2'.repeat(32));
  assert.equal(scope.predecessor,'3ffefebc-3a91-424c-b8d0-b4d5aa0a0218');assert.deepEqual(scope.predecessorReceipt,stageU);
  assert.equal(scope.bindingsSha256,'8db7effc4f4f7f0bf97c536e4960f642692806689c83a871dd4f1b870ef383bd');
  const keys=generateKeyPairSync('ed25519'),key=keys.publicKey.export({format:'jwk'}).x,scopeSha256=digest(JSON.stringify(scope));
  const review={kind:'technical-review-only-v1',source:head,scopeSha256,reviewer:'offline fixture',method:'source + local transport',findings:'no open fixture findings',disposition:'fixture only',openBlockers:0,publicationApproved:false};
  const signed=r=>{const statement=JSON.stringify(r);return JSON.stringify({statement,signature:sign(null,Buffer.from(statement),keys.privateKey).toString('base64')});};
  const envelope=signed(review),stamp=new Date(now-2000).toISOString(),comment={id:1,commit_id:head,user:{id:owner},author_association:'OWNER',created_at:stamp,updated_at:stamp,body:'APPROVE INACTIVE UPLOAD ONLY '+scopeSha256+' '+digest(envelope)};
  const check=(s=scope,c=comment,e=envelope,k=key,n=now)=>checkApproval(s,c,e,k,n);
  assert.equal(check().scopeSha256,scopeSha256);
  for(const update of [{operation:'mobile-successor-inactive-upload-v1'},{build:stageU.build},{predecessorReceipt:{...stageU,verifiedSha256:'f'.repeat(64)}},{bindingsSha256:'0'.repeat(64)},{editorId:'3'.repeat(32)},{topology:'x'},{source:'e'.repeat(40)},{until:scope.until+1}])assert.throws(()=>check({...scope,...update}));
  for(const update of [{commit_id:'e'.repeat(40)},{body:'looks good'},{user:{id:0}},{updated_at:new Date(now).toISOString()}]) assert.throws(()=>check(scope,{...comment,...update}));
  assert.throws(()=>check(scope,comment,envelope,key,scope.until*1000));assert.throws(()=>check(scope,comment,envelope,generateKeyPairSync('ed25519').publicKey.export({format:'jwk'}).x));
  for(const mutation of [{openBlockers:1},{publicationApproved:true},{source:'e'.repeat(40)},{method:''}]){const e=signed({...review,...mutation});assert.throws(()=>check(scope,{...comment,body:'APPROVE INACTIVE UPLOAD ONLY '+scopeSha256+' '+digest(e)},e));}
});
