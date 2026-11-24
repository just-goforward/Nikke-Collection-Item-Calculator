import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {capabilities,checkedTarget,incidentUrl,operate,probeIngress,reconcile,replay,routePath,siteWitness} from './incident-activation-control.mjs';
import {predecessor} from './incident-mobile-successor.mjs';
import {stageU,readStageU,observeIncident} from './incident-stage-u-evidence.mjs';
import {authorizeTokens,checkedSource,custody,restoredControl,retainedRestore,rootProof,routePolicy} from './incident-owner-activate.mjs';
import {beforeIds,checkedMain,history,publicBindings,publicHash} from './incident-owner-upload-only.mjs';
import {baseline,schedule,script,target} from './incident-canary-control.mjs';
import {account,bindings,db,digest,name,namespace,registry,root,workers,zone} from './incident-provider.mjs';
import {original} from './incident-recovery-id.mjs';
import {successorSummary} from '../../production-incidents/sealed-successor.ts';
import enrolled from '../../site-worker/production-root-release-v1.json' with {type:'json'};
import {graphEnv,owner,repo} from './incident-receipt.mjs';

const candidate=stageU.version;
const tmp=mkdtempSync(join(tmpdir(),'incident-activation-')),cwd=fileURLToPath(new URL('../../production-incidents/',import.meta.url));
const modules={};before(()=>{
  const env={PATH:process.env.PATH,HOME:tmp,WRANGLER_SEND_METRICS:'false',CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:'false'};
  for(const [phase,hash] of [['inert',baseline.module],['public',publicHash]]) {
    const cfg=join(cwd,`.activate-test-${process.pid}-${phase}.json`),out=join(tmp,phase);
    try {writeFileSync(cfg,execFileSync(process.execPath,['config.mjs',phase,db,namespace,phase==='public'?stageU.build:baseline.build],{cwd,env}),{flag:'wx'});
      execFileSync(process.execPath,['../node_modules/wrangler/bin/wrangler.js','deploy','--dry-run','--config',cfg,'--outdir',out],{cwd,env,stdio:'pipe'});
      const b=readFileSync(join(out,'worker.js'));assert.equal(digest(b),hash);modules[phase]=b.toString('base64');
    } finally {rmSync(cfg,{force:true});}
  }
});after(()=>rmSync(tmp,{recursive:true,force:true}));
const routeId='c'.repeat(32),active='11111111-2222-3333-4444-555555555555',restored='11111111-2222-3333-4444-555555555556',head='d'.repeat(40);
const stamp='2026-11-24T00:00:00Z', cron={cron:schedule,created_on:stamp,modified_on:stamp};
const route={id:routeId,pattern:'nikkecollection.com/api/recalculation-incident',script:name,request_limit_fail_open:false};
const goodBox={incidents:1,notifications:2,sealed:1,state:'sent',attempts:1};
const pair={run:'123',attempt:'1',handoff:'a'.repeat(64),rollback:'b'.repeat(64),forward:'f'.repeat(64),packet:'1'.repeat(64),rehearsal:'2'.repeat(64)};
function setup(){
  const live={jobs:structuredClone(history),crons:[],routes:[
    ['863270c636c945b8b788c329c9762f50','/preview/*','collection-kit-site-preview-k1r2'],['483199a1890b4fb696b38d53b6d63e3c','/api/calendar','collection-kit-conditional-production'],
    ['85e95eb76fd94eeba4531b7b26caa11c','/api/joint-supply/v2','collection-kit-conditional-production']
  ].map(([id,path,script])=>({id,pattern:'nikkecollection.com'+path,script,request_limit_fail_open:false})),ids:[...beforeIds,predecessor,candidate],body:'html',box:{...goodBox},graph:'graph',http:301};
  const calls=[],dir=join(mkdtempSync(join(tmp,'run-')),'custody'),journal=custody(dir);
  const targetWorker={id:original.workerId,name,created_on:original.createdOn,deployed_on:stamp,tags:[original.tag],tail_consumers:[],logpush:false,observability:{enabled:false},subdomain:{enabled:false,previews_enabled:false},references:{workers:[],domains:[],dispatch_namespace_outbounds:[],durable_objects:[],queues:[]}};
  const read=async p=>{
    if(p===`${target}/versions?per_page=100`)return live.ids.map(id=>({id}));
    for(const [id,phase] of [[candidate,'public'],[predecessor,'public'],[baseline.version,'inert']]) if(p===`${target}/versions/${id}?include=modules`) {
      const b=phase==='inert'?bindings(baseline.build):[...publicBindings(id===candidate?(live.candidateBuild??stageU.build):baseline.build),...['ADMIN_ID','BOT_TOKEN'].map(name=>({name,type:'secret_text'}))];
      return {id,main_module:'worker.js',usage_model:'standard',compatibility_date:'2026-08-14',urls:[],bindings:b,
        modules:[{name:'worker.js',content_type:'application/javascript+module',content_base64:modules[phase]}],...(id===candidate?live.versionChange:{})};
    }
    if(p===`${target}/previews?per_page=1` || p===`${workers}/domains?service=${name}`)return [];
    if(p===routePath)return live.routes;
    if(p===`${script}/schedules`)return {schedules:live.crons};
    if(p===`${script}/deployments?per_page=100`)return {deployments:live.jobs};
    if(p===`${script}/deployments?per_page=1`)return {deployments:[live.jobs[0]]};
    if(p===target || p===`${registry}/${name}`)return targetWorker;
    if(p===`${script}/subdomain`)return targetWorker.subdomain;
    if(p===`${workers}/domains?service=collection-kit-site-production`)return [{service:'collection-kit-site-production',environment:'production',hostname:'nikkecollection.com',zone_id:zone,id:'e'.repeat(32),enabled:true}];
    if(p===`${workers}/scripts/collection-kit-site-production/deployments?per_page=1`)return {deployments:[{id:live.rootDeployment??history[0].id,versions:[{percentage:100,version_id:live.rootVersion??enrolled.priorSiteVersion}]}]};
    if(p===`${workers}/scripts/collection-kit-site-preview-k1r2/deployments?per_page=1`)return {deployments:[{...history[0],id:live.previewDeployment??history[0].id}]};
    assert.fail('unexpected read '+p);
  };
  const send=async(url,o)=>{
    if(!url.startsWith('https://api.cloudflare.com/client/v4')){
      assert.equal(o.method,'GET');assert.equal(o.credentials,'omit');assert.equal(o.headers,undefined);
      if(url==='http://nikkecollection.com/api/recalculation-incident')return new Response(null,{status:live.http,headers:{location:incidentUrl}});
      if(url===incidentUrl)return new Response(null,{status:live.routes.length===4?405:404,headers:{'cache-control':'no-store'}});
      assert.ok(['https://nikkecollection.com/','https://nikkecollection.com/preview/'].includes(url));
      return new Response(live.body+url,{headers:{'content-type':'text/html; charset=utf-8'}});
    }
    const p=url.split('/client/v4')[1], b=o.body===undefined?undefined:JSON.parse(o.body), ok=result=>Response.json({result,success:true,errors:[],messages:[]});
    assert.equal(o.redirect,'error');
    if(p===`${root}/d1/database/${db}/query`){assert.equal(o.method,'POST');assert.equal(o.headers.authorization,'Bearer reader');assert.deepEqual(b,{sql:successorSummary,params:Array(4).fill('1795448388')});return ok([{success:true,meta:{served_by_primary:true,changed_db:false,rows_written:0},results:[live.box]}]);}
    assert.equal(o.headers.authorization,p.startsWith(routePath)?'Bearer zone':'Bearer editor');let op,ack;
    if(p===`${script}/deployments` && o.method==='POST') {
      const v=b.versions[0].version_id;assert.ok([candidate,baseline.version].includes(v));assert.deepEqual(b,{strategy:'percentage',versions:[{version_id:v,percentage:100}]});op=v===candidate?'deploy':'restore';ack={id:v===candidate?active:restored,versions:b.versions};live.jobs.unshift(ack);
    } else if(p===`${script}/schedules` && o.method==='PUT') {
      op=b.length?'arm':'disarm';assert.deepEqual(b,op==='arm'?[{cron:'*/5 * * * *'}]:[]);live.crons=op==='arm'?[{...cron}]:[];ack={schedules:live.crons};
    } else if(p===routePath && o.method==='POST') {
      op='expose';assert.deepEqual(b,{pattern:route.pattern,script:name});
      if(live.denied){calls.push(op);return Response.json({success:false,result:null,errors:[{code:10000}],messages:[]},{status:403});}
      live.routes.push({...route});ack=route;
    } else {assert.equal(p,routePath+'/'+routeId);assert.equal(o.method,'DELETE');assert.equal(b,undefined);op='withdraw';live.routes.pop();ack={id:routeId};}
    assert.ok(existsSync(join(dir,`${calls.length}.intent`)),'durable pre-request marker');calls.push(op);
    if(live.lost===op)throw Error('connection lost after applying request');
    if(live.after===op)live.body='changed';return ok(ack);
  };
  const io={journal,head,authority:async()=>{if(live.revoked)throw Error('revoked');},initialGraph:async()=>live.graph,
    windowOpen:()=>{},approveChange:()=>{},pairProof:()=>pair,pause:async()=>{},
    inspect:s=>checkedTarget(read,s),witness:()=>siteWitness(read,send),ingress:b=>probeIngress(send,b),...capabilities('editor','zone','reader',send)};
  return {live,calls,io,dir,read,run:(mode='activate')=>operate(mode,io)};
}
test('root observer distinguishes inactive U, old active UUID, same-module stale binding, wrong share and cron',async()=>{
  const f=setup(),observe=()=>observeIncident(f.read,enrolled.serviceCodeHash);
  await assert.rejects(observe(),/sole active/); // Candidate bytes are already in the inventory.
  f.live.jobs.unshift({id:active,versions:[{version_id:candidate,percentage:100}]});
  await assert.rejects(observe());f.live.crons=[cron];
  assert.deepEqual(await observe(),{deployment:active,version:candidate,build:stageU.build});
  await assert.rejects(observeIncident(f.read,baseline.build),/not enrolled/);
  f.live.candidateBuild=baseline.build;await assert.rejects(observe(),/unexpected bindings/);
  f.live.candidateBuild=stageU.build;f.live.jobs[0].versions[0].version_id=predecessor;await assert.rejects(observe(),/sole active/);
  f.live.jobs[0].versions=[{version_id:candidate,percentage:90},{version_id:predecessor,percentage:10}];await assert.rejects(observe(),/ambiguous active/);
  assert.deepEqual(f.calls,[]);
});
const originalReceiptDir=process.env.INCIDENT_U_ORIGINAL_RECEIPT_DIR;
test('original Stage U bytes required: predecessor alone, missing ACK, substituted ID or altered verified bytes cannot pass',
  {skip:!originalReceiptDir && 'requires original owner receipts; never synthesize successful proof'},()=>{
  assert.equal(readStageU(originalReceiptDir),stageU);
  const copy=mkdtempSync(join(realpathSync(tmp),'stage-u-')),slot='successor-of-'+predecessor;
  const originalCopy=file=>writeFileSync(join(copy,file),readFileSync(join(originalReceiptDir,file)),{mode:0o600});
  for(const suffix of ['.json','.json.ack'])originalCopy(original.workerId+suffix);
  assert.throws(()=>readStageU(copy),{code:'ENOENT'});
  mkdirSync(join(copy,slot),{mode:0o700});originalCopy(join(slot,'intent.json'));
  const ack=join(slot,'ack.json'),verified=join(slot,'verified.json');originalCopy(verified);
  assert.throws(()=>readStageU(copy),{code:'ENOENT'});writeFileSync(join(copy,ack),JSON.stringify({candidate:predecessor}),{mode:0o600});
  assert.throws(()=>readStageU(copy),/wrong Stage U ack.json/);originalCopy(ack);
  writeFileSync(join(copy,verified),JSON.stringify({id:candidate,activationAuthorized:true}),{mode:0o600});
  assert.throws(()=>readStageU(copy),/wrong Stage U verified.json/);originalCopy(verified);assert.equal(readStageU(copy),stageU);
});
test('unsigned incident activation and rollback cannot spend even one more intent',async()=>{
  for(const reverse of [false,true]) {const f=setup();if(reverse)await f.run();const count=f.calls.length;
    f.io.approveChange=()=>{throw Error('missing owner decision');}; await assert.rejects(f.run(reverse?'rollback':'activate'),/missing owner decision/);assert.equal(f.calls.length,count);}
});
test('actual verified bytes; isolated credentials, exact create then reverse-order rollback; both directions compare public documents',async()=>{
  const f=setup();const on=await f.run();assert.equal(on.phase,'exact-incident-active');assert.equal(on.version,candidate);assert.equal(on.unaffected.sites.length,2);
  await assert.rejects(f.run());const off=await f.run('rollback');assert.equal(off.version,baseline.version);assert.deepEqual(off.unaffected,on.unaffected);
  await assert.rejects(f.run('rollback'));await assert.rejects(f.run());assert.deepEqual(f.calls,['deploy','arm','expose','withdraw','disarm','restore']);
});
for(const [label,alter] of Object.entries({
  'occupied exact route':x=>x.routes.push({...route,script:'other'}),'wildcard collision':x=>x.routes.push({...route,pattern:'*.nikkecollection.com/*'}),
  'preview route drift':x=>x.routes[0].request_limit_fail_open=true,'other cron':x=>x.crons.push({...cron,cron:'* * * * *'}),
  'pre-existing deployment':x=>x.jobs[0].id=active,'split deployment':x=>x.jobs[0].versions[0].percentage=50,'inactive ID substitution':x=>x.ids.pop(),
  'predecessor absent':x=>x.ids.splice(x.ids.indexOf(predecessor),1),'stale candidate build':x=>x.candidateBuild=baseline.build,
  'wrong module':x=>x.versionChange={modules:[]},'unexpected env':x=>x.versionChange={env:{}},'version preview':x=>x.versionChange={urls:['other']},
  'unsealed outbox':x=>x.box.sealed=0,'pending or claimed canary':x=>x.box.state='claimed','extra sendable row':x=>x.box.notifications=3,
  'insecure HTTP':x=>x.http=200,'revoked source':x=>x.revoked=true,
})) test('no mutation: '+label,async()=>{const f=setup();alter(f.live);await assert.rejects(f.run());assert.deepEqual(f.calls,[]);});
for(const op of ['deploy','arm','expose','withdraw','disarm','restore']) test('lost '+op+' ACK is never inferred or replayed',async()=>{
  const f=setup();if(['withdraw','disarm','restore'].includes(op))await f.run();f.live.lost=op;
  await assert.rejects(f.run(f.calls.length?'rollback':'activate'));const prior=f.calls.slice();await assert.rejects(f.run());await assert.rejects(f.run('rollback'));assert.deepEqual(f.calls,prior);
});
for(const [label,change] of Object.entries({'route replaced':x=>x.routes.at(-1).id='d'.repeat(32),'route rebound':x=>x.routes.at(-1).script='other','deployment replaced':x=>x.jobs[0].id=restored,'same cron recreated':x=>x.crons[0].created_on='2026-11-24T00:00:01Z','foreign cron':x=>x.crons.push({...cron})}))test('rollback refuses '+label,async()=>{const f=setup();await f.run();change(f.live);await assert.rejects(f.run('rollback'));assert.equal(f.calls.length,3);});
test('deliberately denied route write is consumed; only earlier acknowledged controls can be restored',async()=>{const f=setup();f.live.denied=true;await assert.rejects(f.run());await assert.rejects(f.run());await f.run('rollback');assert.deepEqual(f.calls,['deploy','arm','expose','disarm','restore']);});
test('changed document blocks rollback until the sealed Site is proven again',async()=>{
  const f=setup();f.live.after='expose';await assert.rejects(f.run(),/Site\/preview/);
  await assert.rejects(f.run('rollback'),/restore and prove/);assert.equal(f.calls.length,3);
  f.live.body='html';await f.run('rollback');assert.equal(f.calls.at(-1),'restore');
});
test('bridge/forward, unavailable Site, same-version redeploy and changed preview never lose their route',async()=>{
  for(const change of [f=>f.live.rootDeployment=active,f=>{f.live.rootDeployment=active;f.live.rootVersion=restored;},
    f=>f.live.previewDeployment=active,f=>{f.io.witness=()=>{throw Error('unavailable');};}]) {
    const f=setup();await f.run();change(f);await assert.rejects(f.run('rollback'));assert.equal(f.calls.length,3);
  }
});
test('terminal restore to new Site IDs is bound to protected run and original rendered bytes',async()=>{
  for(const fault of ['none','abandoned','bridge','false abandon','wrong version','different preview','different controls']) {
    const f=setup();await f.run();f.live.rootDeployment=active;f.live.rootVersion=restored;
    if(fault==='different preview')f.live.previewDeployment=active;
    f.io.restoreProof=enrolledPair=>{assert.deepEqual(enrolledPair,pair);if(['abandoned','false abandon'].includes(fault))return {state:'BRIDGE_ABANDONED',operation:'root-abandon-bridge',noSiteWrite:true,version:restored,fromVersion:restored,deployment:active,fromDeployment:fault==='abandoned'?active:restored};
      return {state:fault==='bridge'?'BRIDGE_READY':'ROLLBACK_ACTIVE',
      operation:'root-restore-rollback',deployment:active,version:fault==='wrong version'?active:restored};};
    f.io.restoredControl=()=>assert.notEqual(fault,'different controls');
    if(['none','abandoned'].includes(fault)){const r=await f.run('rollback');assert.equal(r.unaffected.sites[0].deployment,active);}
    else {await assert.rejects(f.run('rollback'));assert.equal(f.calls.length,3);}
  }
});
test('expiry during pre-send reads does not consume an unsubmitted next slot',async()=>{
  const f=setup();f.io.windowOpen=()=>{if(f.calls.length===1)throw Error('expired');};
  await assert.rejects(f.run(),/expired/);assert.equal(existsSync(join(f.dir,'1.intent')),false);
  f.io.windowOpen=()=>{};await f.run('rollback');assert.deepEqual(f.calls,['deploy','restore']);
});
test('post-write observations converge with bounded reads; no mutation is retried',async()=>{
  for(const persistent of [false,true]) {
    const f=setup(),inspect=f.io.inspect,ingress=f.io.ingress,pauses=[];let observations=0,end=0;
    f.io.pause=async ms=>pauses.push(ms);
    f.io.inspect=async s=>{if(s.active && ++observations<=2)throw Error('old control');await inspect(s);};
    f.io.ingress=async open=>{if(open && (++end<3 || persistent))throw Error('edge still closed');await ingress(open);};
    if(persistent)await assert.rejects(f.run(),/edge still closed/);else await f.run();
    assert.deepEqual(f.calls,['deploy','arm','expose']);assert.equal(end,persistent?4:3);
    assert.deepEqual(pauses,persistent?[1000,3000,1000,3000,7000]:[1000,3000,1000,3000]);
  }
});
test('read-only reconciliation after propagation never needs a writer or manufactures an ACK',async()=>{
  for(const ambiguous of [false,true]) {
    const f=setup();f.live.lost=ambiguous?'expose':null;
    if(ambiguous)await assert.rejects(f.run());else await f.run();
    const {inspect,witness,ingress,pause}=f.io,check=()=>reconcile({inspect,witness,ingress,pause,load:()=>f.io.journal.load(head)});
    if(ambiguous)await assert.rejects(check(),/incomplete/);else assert.equal((await check()).route,routeId);
    assert.deepEqual(f.calls,['deploy','arm','expose']);
  }
});
test('protected pair and root-restore artifacts bind the whole source tree, job, archive and exact handoff',async()=>{
  const run='123',attempt='1',suffix=`${head}-${run}-${attempt}`,sha='f'.repeat(64),rh=pair.rollback;
  function artifact(pair,change=()=>{},archived=false) {
    const prefix=pair?'root-state-root-restore-rollback':'root-pair-receipt',name=`${prefix}-${suffix}`,repository={id:1229775730};
    const r={id:123,run_attempt:1,head_sha:head,path:'.github/workflows/site-worker-promote.yml',event:'workflow_dispatch',
      actor:{id:owner},triggering_actor:{id:owner},head_branch:'main',repository,head_repository:repository,status:'completed',conclusion:'success'};
    const approvals=[{state:'approved',user:{id:owner},environments:[{id:8,name:graphEnv}]}];
    const job={name:pair?'publish-root-pair':'prepare-root-pair',conclusion:'success'};
    const a={id:19,name,expired:false,digest:'sha256:'+sha,workflow_run:{id:123,head_sha:head}};
    const v=pair?{profile:'production-root-state-v1',state:'ROLLBACK_ACTIVE',operation:'root-restore-rollback',source:head,run,attempt,handoffSha256:pair.handoff,
      manifestSha256:rh,moduleSha256:sha,controlSha256:sha,deployment:active,version:restored,producerVersion:enrolled.publisherVersion,incident:{deployment:active,version:candidate,build:stageU.build}}:
      {profile:'production-root-pair-handoff-v1',repository:repo,sha:head,run,attempt,deployed:false,rehearsalSha256:sha,packetSha256:sha,directions:{rollback:{manifestSha256:rh},forward:{manifestSha256:sha}}};
    change({r,a,job,v,approvals});
    return rootProof(head,run,pair,{gate:()=>8,archived:archived?(h,r,t)=>{assert.deepEqual([h,r,t],[head,run,attempt]);return Buffer.from(JSON.stringify(v));}:undefined,query:p=>{
      if(p===`actions/runs/${run}`)return r;
      if(p.endsWith('/approvals'))return approvals;
      if(p.endsWith('/jobs?per_page=100'))return archived?{total_count:2,jobs:[job,{name:'attest-root-state',conclusion:'success'}]}:{total_count:1,jobs:[job]};
      assert.equal(archived,false,'retained proof must work with the original artifact unavailable');
      assert.equal(p,`actions/runs/${run}/artifacts?per_page=100`);return {total_count:1,artifacts:[a]};
    },member:(actual,k)=>{assert.equal(actual,a);assert.equal(k,pair?'state.json':'handoff.json');return Buffer.from(JSON.stringify(v));}});
  }
  const intended=artifact(null),receipt=artifact(intended);
  assert.deepEqual(artifact(intended,x=>{x.a.expired=true;},true),receipt);assert.throws(()=>artifact(intended,x=>{x.v.manifestSha256=sha;},true));
  const live={...receipt,annotations:{'workers/tag':head,'workers/message':'root-rollback:'+rh}};
  restoredControl(receipt,live);assert.throws(()=>restoredControl(receipt,{...live,controlSha256:rh}));
  for(const fault of [x=>x.r.head_sha='b'.repeat(40),x=>x.job.name='other',x=>x.a.expired=true,x=>x.v.attempt='2',x=>x.approvals.length=0]) {
    const f=setup();f.io.pairProof=()=>artifact(null,fault);await assert.rejects(f.run());assert.equal(f.calls.length,0);assert.equal(existsSync(f.dir),false);
    assert.throws(()=>artifact(intended,fault));
  }
  for(const fault of [x=>x.v.incident.version=predecessor,x=>x.v.incident.build=baseline.build,x=>x.v.state='BRIDGE_READY',x=>x.a.workflow_run.head_sha='a'.repeat(40),x=>x.v.handoffSha256=sha,x=>x.v.manifestSha256=sha])
    assert.throws(()=>artifact(intended,fault));
});
test('retained bytes and bundle still require the authenticated exact GitHub signer, source, repository and invocation',()=>{
  const dir=mkdtempSync(join(tmp,'archive-'));writeFileSync(join(dir,'state.json'),'state-bytes',{mode:0o600});writeFileSync(join(dir,'state.sigstore.jsonl'),'bundle',{mode:0o600});
  const cert={runInvocationURI:`https://github.com/${repo}/actions/runs/123/attempts/2`,sourceRepositoryIdentifier:'1229775730',sourceRepositoryOwnerIdentifier:String(owner),buildTrigger:'workflow_dispatch'};
  const verify=(...args)=>{
    assert.equal(readFileSync(args[2],'utf8'),'state-bytes');assert.equal(readFileSync(args[4],'utf8'),'bundle');
    assert.deepEqual(args.slice(5),['--repo',repo,'--signer-workflow',repo+'/.github/workflows/site-worker-promote.yml','--signer-digest',head,'--source-digest',head,'--source-ref','refs/heads/main','--deny-self-hosted-runners','--format','json']);
    return JSON.stringify([{verificationResult:{signature:{certificate:cert}}}]);
  };
  assert.equal(retainedRestore(dir,head,'123','2',verify).toString(),'state-bytes');
  assert.throws(()=>retainedRestore(dir,head,'123','1',verify));assert.throws(()=>retainedRestore(dir,head,'321','2',verify));
  assert.throws(()=>retainedRestore(dir,head,'123','2',()=>{throw Error('signature rejected');}),/signature rejected/);
  cert.sourceRepositoryIdentifier='0';assert.throws(()=>retainedRestore(dir,head,'123','2',verify));
});
test('concurrent invocations by the sole owner spend each fixed mutation slot at most once',async()=>{const f=setup();const r=await Promise.allSettled([f.run(),f.run()]);assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.deepEqual(f.calls,['deploy','arm','expose']);});
test('rollback wins or loses an in-flight next slot, never interleaves an exposure after withdrawal',async()=>{
  const f=setup();let resume,ready;const started=new Promise(r=>ready=r),hold=new Promise(r=>resume=r),inspect=f.io.inspect;let once=true;
  f.io.inspect=async s=>{await inspect(s);if(once&&s.active&&!s.cron){once=false;ready();await hold;}};
  const forward=f.run();await started;try{await f.run('rollback');}finally{resume();}await assert.rejects(forward);assert.deepEqual(f.calls,['deploy','restore']);
});
test('fresh exact-zone permission and exactly one UUID Editor; management, graph and route token are independent',async()=>{
  const ids=['1','2','3','4'].map(k=>k.repeat(32)),names=['Account API Tokens Read','Workers Scripts Read','D1 Read','Pages Read','Zone Read','Workers Routes Read','Individual Workers Editor','Workers Routes Write'];
  const groups=names.map((name,i)=>({id:(i+10).toString(16).padStart(32,'0'),name})),roles=new Map(groups.map(g=>[g.id,g.name]));
  const acc=`com.cloudflare.api.account.${account}`,z=`com.cloudflare.api.account.zone.${zone}`;
  const grant=(ns,resources)=>({effect:'allow',permission_groups:ns.map(n=>({id:groups[n].id})),resources});
  const ms=Date.now(),until=Math.floor(ms/1000)+600;
  const details=ids.map((id,i)=>({id,status:'active',issued_on:new Date(ms-1000).toISOString(),expires_on:new Date(ms+1800000).toISOString(),policies:[
    [grant([0],{[acc]:'*'})],[grant([1,2,3],{[acc]:'*'}),grant([4],{[acc]:{'com.cloudflare.api.account.zone.*':'*'}}),grant([5],{[z]:'*'})],
    [grant([6],{[acc]:{[`com.cloudflare.edge.worker.script.${original.workerId}`]:'*'}})],[grant([7],{[z]:'*'})],
  ][i]}));
  const readers=ids.map(id=>async p=>{if(p===`${root}/tokens/verify`)return {status:'active',id};assert.equal(id,ids[0]);if(p.endsWith('/permission_groups'))return groups;return details.find(d=>p===`${root}/tokens/${d.id}`);});
  const [management,reader,editor,routeRead]=readers,args={management,reader,editor,route:routeRead,registered:ids[1],retired:'0'.repeat(32),until};await authorizeTokens(args);
  for(const change of [p=>p.resources={[acc]:'*'},p=>p.resources={'com.cloudflare.api.account.zone.*':'*'},p=>p.permission_groups.push({id:groups[6].id}),p=>p.effect='deny']) {
    const d=structuredClone(details[3]);change(d.policies[0]);assert.throws(()=>routePolicy(d,ids[3],roles));
  }
  for(const changes of [{editor:routeRead},{registered:ids[2]},{retired:ids[2]},{until:until+86400}])await assert.rejects(authorizeTokens({...args,...changes}));
});
test('exact clean source gate and historical rollback ancestry do not authorize a stale activation',()=>{
  const parent='b84443033056b28a5f23594f90c4171863015e57',files=[
  '.github/workflows/site-source-verify.yml',
  '.github/workflows/site-worker-promote.yml',
  'docs/candidate-toolchain.md',
  'docs/root-rum-witness.md',
  'production-incidents/RUNBOOK.ko.md',
  'scripts/ci/incident-activation-control.mjs',
  'scripts/ci/incident-mobile-successor.test.mjs',
  'scripts/ci/incident-owner-activate.mjs',
  'scripts/ci/incident-owner-activate.test.mjs',
  'scripts/ci/incident-owner-upload-only.mjs',
  'scripts/ci/incident-provider.mjs',
  'scripts/ci/incident-stage-u-evidence.mjs',
  'scripts/ci/promote-root-pair.mjs',
  'scripts/ci/root-pair-handoff.mjs',
  'scripts/ci/root-promotion-browser.mjs',
  'scripts/ci/root-promotion-custody.mjs',
  'scripts/ci/root-promotion-get.mjs',
  'scripts/ci/root-promotion-live.mjs',
  'scripts/ci/root-promotion.test.mjs',
  'scripts/ci/root-rum-bytes.mjs',
  'scripts/ci/root-rum-bytes.test.mjs',
  'scripts/ci/root-rum-policy.mjs',
  'scripts/ci/root-rum-witness.mjs',
  'scripts/ci/root-switch-policy.mjs',
  'scripts/ci/root-switch-policy.test.mjs',
    'scripts/root-release-canary.mjs',
  ];
  const git=cmd=>cmd==='rev-list'?`${head} ${parent}`:cmd==='status'?'':files.join('\n');checkedSource(git,head);
  for(const [which,out] of [['status','?? unexpected'],['diff',[...files,'other'].join('\n')],['rev-list',`${head} ${parent} ${head}`],['rev-list',`${head} ca2904054baf83ddc2a59166f9436776966a01d8`]])assert.throws(()=>checkedSource((c,...a)=>c===which?out:git(c,...a),head));
  const tip='e'.repeat(40),repo={id:1229775730},step='Verify exact existing incident activation and rollback (offline)';
  const query=p=>{if(p==='branches/main')return {protected:true,commit:{sha:tip}};if(p===`commits/${head}`)return {commit:{verification:{verified:true}}};if(p.startsWith('compare/'))return {status:'ahead',merge_base_commit:{sha:head}};if(p.endsWith('/pulls'))return [{merged_at:stamp,merge_commit_sha:head,base:{ref:'main',repo}}];if(p.includes('/runs?'))return {workflow_runs:[{id:1,run_attempt:1,head_sha:head,head_branch:'main',event:'push',path:'.github/workflows/site-source-verify.yml',repository:repo,head_repository:repo,status:'completed',conclusion:'success'}]};return {total_count:1,jobs:[{name:'Site source prerequisites',conclusion:'success',steps:[{name:step,conclusion:'success'}]}]};};
  checkedMain(head,query,step,true);assert.throws(()=>checkedMain(head,query,step));assert.throws(()=>checkedMain(head,p=>p.startsWith('compare/')?{status:'diverged'}:query(p),step,true));assert.throws(()=>checkedMain(head,query,'other',true));
  assert.throws(()=>replay([{op:'withdraw',ack:{id:routeId}}]));
});
