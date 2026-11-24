// Generated fixtures and keys exist only in this process. No browser, service, credential or signed release file.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync, hash, sign} from 'node:crypto';
import {mkdtempSync,writeFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadApproval} from '../../e2e/operational-report.mjs';
import test from 'node:test';
import {qualify,policyAuthority,profile,checkObligations} from './hybrid-b-release.mjs';
import {coverage} from './hybrid-b-policy-coverage.mjs';
import {claimFor,exitFor} from './hybrid-b-policy-evidence.mjs';
import {inventory} from './hybrid-b-policy-inventory.mjs';
import {checkPair,checkReview,servedDigest} from './prepare-root-pair.mjs';
const sha = b => hash('sha256',b), repository='unit/never-authorized', source='1'.repeat(40), packetLabel=sha('unit');
const runSignature = (key,bytes) => sign(null,Buffer.from(bytes),key.privateKey).toString('base64');
const testKey=()=>generateKeyPairSync('ed25519'), owner=testKey(), reviewer=testKey();
const signerConfig={owner:owner.publicKey.export({format:'jwk'}).x,review:reviewer.publicKey.export({format:'jwk'}).x};
function signatures(pin,reviewAt,ownerAt) {
  const scope=['approve-preparation-policy-only-v3',profile,repository,source,pin];
  const review={signedAt:reviewAt,signature:runSignature(reviewer,JSON.stringify([...scope,'review',reviewAt,null]))};
  return {review,owner:{signedAt:ownerAt,signature:runSignature(owner,JSON.stringify([...scope,'owner',ownerAt,review.signature]))}};
}
test('role, subject and review-before-owner ordering are signed',()=>{
  const sig=signatures(packetLabel,1,2);
  const use=(k=signerConfig,s=sig,p=packetLabel,r=repository,h=source)=>policyAuthority(JSON.stringify(k),s,p,r,h,5,3);
  use(); for(const fail of [()=>use({...signerConfig,owner:signerConfig.review}),()=>use(signerConfig,{...sig,review:sig.owner}),()=>use(signerConfig,sig,sha('other')),()=>use(signerConfig,sig,packetLabel,'other'),()=>use(signerConfig,sig,packetLabel,repository,'2'.repeat(40)),()=>use(signerConfig,signatures(packetLabel,2,1)),()=>use(signerConfig,signatures(packetLabel,1,4))])assert.throws(fail);
});
function zip(entries) {
  return execFileSync('python3',['-IB','-c',`import io,json,sys,zipfile,base64
buf=io.BytesIO()
with zipfile.ZipFile(buf,'w') as z:
 for name,body in json.load(sys.stdin).items(): z.writestr(name,base64.b64decode(body))
sys.stdout.buffer.write(buf.getvalue())`],{input:JSON.stringify(Object.fromEntries(Object.entries(entries).map(([k,b])=>[k,b.toString('base64')])))});
}
function fixture(){
  const store=new Map(), put=(name,obj)=>{const bytes=Buffer.isBuffer(obj)?obj:Buffer.from(JSON.stringify(obj));store.set(name,bytes);return sha(bytes);};
  const read=(name,pin)=>{assert.equal(sha(store.get(name)),pin,`pin ${name}`);return store.get(name);};
  const q={profile:'hybrid-b-exact-campaign-qualification-v2',source};
  const enrollment=Buffer.from(JSON.stringify({serviceCodeHash:sha('service'),nativeWasmSha256:sha('wasm'),publicKeyBase64:Buffer.alloc(32,7).toString('base64')}));
  const tree=s=>Object.fromEntries(['/en/index.html','/index.html','/ja/index.html'].map(p=>[p,{bytes:1,sha256:sha(s+p)}]));
  const files={forward:tree('f'),rollback:tree('r'),headersSha256:sha('headers')};
  const review={source,repository,enrollmentContractSha256:sha(enrollment),headersSha256:files.headersSha256,directions:{},evidence:{'numerical-boundary':sha('test numerical-boundary')}};
  for(const role of ['forward','rollback'])review.directions[role]={servedSha256:servedDigest(files[role])};
  const packet={profile:'private-production-root-v1',productionDeployable:false,publicationApproved:false,review:{...JSON.parse(enrollment),source,contractSha256:sha(enrollment),statementSha256:sha('wire')},files};
  q.packet=put('qa/private-root-pair.json',packet);
  const numbers=loadApproval('numerical-boundary');
  q.numerical=put('numerical-boundary.json',{schemaVersion:1,suiteId:'numerical-boundary',inventoryDigest:numbers.digest,complete:true,cases:numbers.ids.map(id=>({id,status:'passed',attempts:1}))});
  const oracle=Buffer.from('unit oracle');
  q.control=put('qa/supply-readiness.json',{profile:'hybrid-b-supply-control-v1',policy:'adaptive-next-batch-balanced-v1',source,packetSha256:q.packet,supplySha256:sha('projection'),input:['R',14,800,0,0,30],expected:'wait',oracleSha256:put(`proofs/${sha(oracle)}.bin`,oracle),verifiedAt:Date.UTC(2024,0,1,6),releaseAdmission:false});
  q.campaign=put('qa/hybrid-b-campaign.json',{profile:'hybrid-b-policy-campaign-v2',id:'f0000000-0000-4000-8000-000000000000',harness:source,controlSha256:q.control,packetSha256:q.packet,releaseAdmission:false});
  for(const suite of ['product','analytics']){
    const putCase=(k,v)=>put(`qa/hybrid-b-${suite}-${k}.json`,v);
    const claim=putCase('claim',claimFor(suite,q.packet,source,q.campaign));
    const report=putCase('report',{profile:'hybrid-b-policy-observation-v1',suite,claimSha256:claim,cases:inventory(suite).cases.map(({id})=>({id,attemptCount:1,attempts:[{retry:0,status:'passed'}]})),frameworkStatus:'passed',complete:true,releaseAdmission:false});
    q[suite]={claim,report,exit:putCase('exit',exitFor(suite,claim,report,true))};
  }
  const actual=new Map(), phases=['build','open','suites','supplement'],ownerId=12;
  const config={repositoryId:1234,builderPath:'fixture-build',campaignPath:'fixture-observe',supplementPath:'fixture-supplement',
    builderSource:'2'.repeat(40),campaignSource:'2'.repeat(40),ownerId,
    technicalPublicKeyBase64:Buffer.from(signerConfig.review,'base64url').toString('base64'),jobs:{},
    artifactPrefixes:{builder:'b',open:'o',product:'p',analytics:'a',supplement:'s'}};
  const technicalKeySha256=sha(Buffer.from(config.technicalPublicKeyBase64,'base64'));
  const custody={profile:'owner-precommit-with-technical-review-v2',independentCustody:false,releaseAdmission:false,repositoryId:1234,source,packet:q.packet,campaign:q.campaign,workflowAttempt:1,product:q.product,analytics:q.analytics,operatorId:ownerId,builderId:ownerId,archives:{}};
  const repo={id:config.repositoryId,private:true,owner:{id:ownerId}}; actual.set('',repo);
  for(const [i,k] of phases.entries()){
    const loc=custody[k]={run:10+i,workflow:[20,21,21,22][i],attempt:1,ordinal:i+1,qaSource:'2'.repeat(40),createdAt:`2024-01-0${i+1}T00:00:00Z`};
    const actor={id:ownerId};
    actual.set(`actions/runs/${loc.run}/attempts/1`,{id:loc.run,path:k==='build'?config.builderPath:k==='supplement'?config.supplementPath:config.campaignPath,workflow_id:loc.workflow,run_attempt:1,repository:repo,head_repository:repo,head_branch:'main',head_sha:loc.qaSource,run_number:loc.ordinal,event:'workflow_dispatch',status:'completed',conclusion:'success',actor,triggering_actor:actor,created_at:loc.createdAt});
    loc.completedAt=loc.createdAt.replace('00:00:00','01:00:00');
    config.jobs[k]={name:k,requiredSteps:['Test upload']};
    const job={id:i+100,name:k,steps:[{name:'Test upload',conclusion:'success'}],run_id:loc.run,run_attempt:1,head_sha:loc.qaSource,status:'completed',conclusion:'success',completed_at:loc.completedAt,started_at:loc.createdAt};
    loc.jobSha256=put(`qa/${k}-job.json`,job);actual.set(`actions/runs/${loc.run}/attempts/1/jobs?per_page=100`,{total_count:1,jobs:[job]});
  }
  const specSha256=orig(Buffer.from('in-memory unit spec fixture'));
  function orig(bytes){return put(`proofs/${sha(bytes)}.bin`,bytes);}
  const evidence={source,repository,packet:q.packet,method:'unit contract fixture only',releaseAdmission:false};
  const file='residual.spec.ts',project='chromium',all=coverage().map(r=>r.id);
  const reportSha256=orig(Buffer.from(JSON.stringify({errors:[],config:{workers:1,projects:[{name:project,retries:0,repeatEach:1}]},stats:{startTime:'2024-01-04T00:01:00Z',duration:1000,expected:all.length,skipped:0,unexpected:0,flaky:0},suites:[{specs:all.map(id=>({title:'B-'+id,file,ok:true,tests:[{projectName:project,expectedStatus:'passed',status:'expected',results:[{retry:0,status:'passed',errors:[]}]}]}))}]})));
  config.supplement={file,project,specSha256,reportSha256};
  for(const [i,k] of ['builder','open','product','analytics','supplement'].entries()){
    const l=[custody.build,custody.open,custody.suites,custody.suites,custody.supplement][i],name=`${config.artifactPrefixes[k]}-${l.run}-1`;
    const members=k==='supplement'?{'report.json':store.get(`proofs/${reportSha256}.bin`),'supplemental.status':Buffer.from('0\n')}:k==='open'?{'hybrid-b-campaign.json':store.get('qa/hybrid-b-campaign.json')}:Object.fromEntries([...['claim','report','exit'].map(s=>[`hybrid-b-${k}-${s}.json`,store.get(`qa/hybrid-b-${k}-${s}.json`)]),[`${k}.status`,Buffer.from('0\n')]]);
    const zipSha256=i===0?sha('private builder archive'):put(`qa/${k}.zip`,zip(members));
    const a=custody.archives[k]={id:30+i,run:l.run,name,zipSha256};
    const m={id:a.id,name,created_at:l.completedAt,digest:'sha256:'+zipSha256,workflow_run:{id:l.run,head_sha:l.qaSource,repository_id:custody.repositoryId,head_repository_id:custody.repositoryId}};
    a.metadataSha256=put(`qa/${k}-artifact.json`,m);actual.set(`actions/artifacts/${a.id}`,m);
  }
  const base={repositoryId:custody.repositoryId,source,packet:q.packet,campaign:q.campaign,qaSource:custody.open.qaSource,controlSha256:q.control,supplementSpecSha256:specSha256,attempt:1,operatorId:ownerId,technicalKeySha256,independentCustody:false,openRun:custody.open.run,releaseAdmission:false};
  const allocation={...base,profile:'hybrid-b-first-use-allocation-v2',workflow:custody.suites.workflow,ordinal:custody.suites.ordinal,openArchiveSha256:custody.archives.open.zipSha256,allocatedAt:'2024-01-02T09:00:00Z'};
  const supplementAllocation={...base,profile:'hybrid-b-supplement-allocation-v1',workflow:custody.supplement.workflow,ordinal:custody.supplement.ordinal,suitesRun:custody.suites.run,productArtifactId:custody.archives.product.id,productArchiveSha256:custody.archives.product.zipSha256,analyticsArtifactId:custody.archives.analytics.id,analyticsArchiveSha256:custody.archives.analytics.zipSha256,allocatedAt:'2024-01-03T09:00:00Z'};
  const opened={campaign:q.campaign,uuid:JSON.parse(store.get('qa/hybrid-b-campaign.json')).id,run:custody.open.run,artifact:custody.archives.open.id,zip:custody.archives.open.zipSha256,allocation};
  const control=JSON.parse(store.get('qa/supply-readiness.json'));
  const advisory={profile:'automated-advisory-supply-review-v1',source,packetSha256:q.packet,controlSha256:q.control,oracleSha256:control.oracleSha256,technicalKeySha256,reviewedAt:control.verifiedAt,independentCustody:false,releaseAdmission:false};
  const material={control,review:{...advisory,signature:runSignature(reviewer,JSON.stringify(advisory,Object.keys(advisory).sort()))}};
  const build={packetSha256:q.packet,source,buildRun:custody.build.run,buildAttempt:1,qaBuildSha:custody.build.qaSource,artifactId:custody.archives.builder.id,
    zipSha256:custody.archives.builder.zipSha256,formalWorkflow:custody.open.workflow,firstSlot:custody.open.ordinal,supplementWorkflow:custody.supplement.workflow,supplementSlot:custody.supplement.ordinal};
  for(const [i,k] of phases.entries()){
    const l=custody[k],run=actual.get(`actions/runs/${l.run}/attempts/1`);
    if(i) {
      const prev=actual.get('comments/102'),id=100+i,at=`2024-01-0${i}T12:00:00Z`,body=JSON.stringify({profile:'successor-first-use-v2',independentCustody:false,phase:k,source,repo:custody.repositoryId,workflow:l.workflow,slot:l.ordinal,attempt:1,qa:l.qaSource,build,material,releaseAdmission:false,opened:i===1?null:i===2?opened:{...opened,supplementAllocation,suitesComment:prev.id,suitesCommentSha:sha(prev.body)}});
      const comment={id,body,commit_id:l.qaSource,path:null,author_association:'OWNER',created_at:at,updated_at:at,user:{id:ownerId,type:'User'}};
      l.commentSha256=put(`qa/${['','open-precommit','precommit','supplement-precommit'][i]}.json`,comment);actual.set(`comments/${id}`,comment);
      run.display_title=`owner-v1:${k}:${id}:${sha(body)}`; if(k==='open'){opened.comment=id;opened.bodySha=sha(body);}
    }
    l.runSha256=put(`qa/${k}-run.json`,run);
  }
  actual.set(`commits/${custody.open.qaSource}/comments?per_page=100`,[101,102,103].map(id=>actual.get('comments/'+id)));
  config.priorRuns={build:[],campaign:[5],supplement:[6,7,8]};
  for(const [role,ph] of [['build',['build']],['campaign',['open','suites']],['supplement',['supplement']]]){
    const wid=custody[ph[0]].workflow;
    const workflow_runs=[...config.priorRuns[role].map((id,i)=>({id,run_number:i+1,workflow_id:wid,status:'completed'})),
      ...ph.map(k=>actual.get(`actions/runs/${custody[k].run}/attempts/1`))];
    actual.set(`actions/workflows/${wid}/runs?per_page=100`,{workflow_runs,total_count:workflow_runs.length});
  }
  q.custody=put('qa/custody.json',custody);
  q.obligations=coverage().map(({id,related})=>{const bytes=Buffer.from(JSON.stringify({...evidence,profile:'hybrid-b-requirement-test-v1',id,attempt:1,outcome:'passed',assertion:'unit case',specSha256,case:'B-'+id,originalSha256:reportSha256}));return {id,related,reason:'unit',disposition:'verified-by-supplement',proofSha256:put(`proofs/${sha(bytes)}.json`,bytes)};});
  for(const [key,name] of [['rootNumerical','root-numerical'],['rootProduct','root-product']])q[key]=put(`${name}.json`,{...evidence,...JSON.parse(enrollment),profile:`hybrid-b-${name}-review-v2`,findings:'unit only',openBlockers:0,originalSha256:orig(Buffer.from(name)),numericalBoundarySha256:q.numerical,locales:['ko','en','ja']});
  const run=(raw=Buffer.from(JSON.stringify(q,null,2)+'\n'),digest=sha(raw))=>qualify(raw,review,enrollment,read,checkPair,{...config,qualificationSha256:digest},path=>actual.get(path));
  return {q,review,enrollment,store,read,put,custody,actual,run};
}
test('exact original campaign and ZIP members, both roles, first use and 52 obligations are required together',()=>{
  const f=fixture(); f.run();
  const damaged=(key,val,callback)=>{const old=key[0][key[1]];key[0][key[1]]=val;try{assert.throws(callback);}finally{key[0][key[1]]=old;}};
  for(const [key,val] of [['source','3'.repeat(40)],['packet',sha('old packet')],['campaign',sha('diagnostic')],['analytics',f.q.product],['obligations',f.q.obligations.slice(1)],['rootNumerical',f.q.rootProduct]])damaged([f.q,key],val,f.run);
  for(const [key,val] of [['independentCustody',true],['witnessId',13],['workflowAttempt',2],['builderId',11]]){
    const p=f.put('qa/custody.json',{...f.custody,[key]:val});damaged([f.q,'custody'],p,f.run);f.put('qa/custody.json',f.custody);
  }
  f.store.set('qa/analytics.zip',f.store.get('qa/product.zip'));assert.throws(f.run);
  for(const [id,d] of [['A007','outside-disabled-profile'],['P006','verified-by-candidate'],['A041','outside-disabled-profile']]){
    const rows=structuredClone(f.q.obligations);rows.find(r=>r.id===id).disposition=d;
    assert.throws(()=>checkObligations(rows,k=>JSON.parse(f.read(`proofs/${k}.json`,k))),/cannot be waived|does not cover/);
  }
});
test('successor checkReview actually consumes only a consented redaction and its ordered signatures',t=>{
  const f=fixture(),r=f.review,p=f.run(),now=Date.now();
  const pretty=Buffer.from(JSON.stringify(f.q,null,2)+'\n');
  assert.equal(p.qualificationSha256,sha(pretty));
  assert.throws(()=>f.run(Buffer.from(JSON.stringify(f.q)),sha(pretty)),/byte pin/);
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'redacted-prep-unit-')));t.after(()=>rmSync(dir,{force:true,recursive:true}));
  const old=process.env.ROOT_SWITCH_SIGNERS;process.env.ROOT_SWITCH_SIGNERS=JSON.stringify(signerConfig);t.after(()=>{if(old===undefined)delete process.env.ROOT_SWITCH_SIGNERS;else process.env.ROOT_SWITCH_SIGNERS=old;});
  const put=(name,v)=>{const b=JSON.stringify(v);writeFileSync(join(dir,name+'.json'),b);return sha(b);};
  Object.assign(r,{profile:'production-root-pair-release-v1',evidenceProfile:profile,origin:'https://nikkecollection.com',siteWorker:'collection-kit-site-production',sourceRun:'1',sourceAttempt:'1',expiresAt:now+60000});
  for(const role of ['forward','rollback'])Object.assign(r.directions[role],{operationalSha256:sha(role+'grant'),serviceSha256:sha(role+'service')});
  function prep(proof,reviewAt=now-5,ownerAt=now-1) {
    r.evidence={'hybrid-b-attestation':put('hybrid-b-attestation',proof)};const d=put('public-review',r);
    put('policy-signatures',signatures(d,reviewAt,ownerAt));return checkReview(dir,d,source,repository,f.enrollment);
  }
  assert.deepEqual(prep(p),r);
  for(const v of [{...p,privatePath:'fixture'},{...p,obligations:p.obligations.slice(1)},{...p,complete:false},{...p,policy:'same-supply-current-batch-v1'},{...p,releaseAdmission:true},{...p,forwardSha256:r.directions.rollback.servedSha256}])assert.throws(()=>prep(v));
  assert.throws(()=>prep(p,now-1,now-3));
  const thread=f.actual.get(`commits/${f.custody.open.qaSource}/comments?per_page=100`);
  thread.push({id:999});assert.throws(f.run);thread.pop();
  // Editing both the archive and the service-side comment after the reservation still fails.
  const c=f.actual.get('comments/103'); c.updated_at=f.custody.supplement.createdAt;
  f.custody.supplement.commentSha256=f.put('qa/supplement-precommit.json',c);f.q.custody=f.put('qa/custody.json',f.custody);
  assert.throws(f.run); c.updated_at=c.created_at; f.custody.supplement.commentSha256=f.put('qa/supplement-precommit.json',c);
  f.q.custody=f.put('qa/custody.json',f.custody);f.run();
  f.actual.get('actions/runs/13/attempts/1').run_attempt=2;assert.throws(f.run);
});
