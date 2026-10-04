import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
const harnessDirectory=path.dirname(fileURLToPath(import.meta.url));
const packet=path.resolve(process.env.FORECAST_NATIVE_MOCK_ROOT??'.tmp/review32-native-mocks');
const cwd=process.cwd(),node=process.execPath,preload=path.join(harnessDirectory,'trace-preload.mjs');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const write=(p,v)=>fs.writeFileSync(p,JSON.stringify(v,null,2)+'\n');
const registry={epoch:2,accountId:'a'.repeat(32),maintenanceHold:true,sourcePin:'b'.repeat(64),registeredAt:'2026-10-03T00:00:00.000Z',approvalRef:'local-mock-approval',flags:{COLLECT_ENABLED:'false',DISPATCH_ENABLED:'false'},workers:{collector:{script:'collection-kit-forecast-collector-staging',versionId:'11111111-1111-4111-8111-111111111111',bundleHash:'c'.repeat(64)},dispatcher:{script:'collection-kit-forecast-dispatcher-staging',versionId:'22222222-2222-4222-8222-222222222222',bundleHash:'d'.repeat(64)}}};
const deployment=(versionId,number=1)=>({id:`${String(number).padStart(8,'0')}-3333-4333-8333-333333333333`,created_on:`2026-10-03T00:00:0${number}.000Z`,annotations:{'workers/message':''},versions:[{version_id:versionId,percentage:100}]});
export const scenarios=[
 {id:'budget-provided',budget:true},{id:'budget-missing',budget:true,evidence:'missing'},
 {id:'budget-partial',budget:true,evidence:'partial'},{id:'budget-pending',budget:true,evidence:'pending'},
 {id:'budget-epoch-missing',budget:true,baseline:null},{id:'budget-epoch-decreased',budget:true,baseline:3},
 {id:'budget-write-failure',budget:true,writeFailure:'submitted'},
 {id:'budget-terminal-failure',budget:true,writeFailure:'resolved'},
 {id:'budget-ack-loss',budget:true,ackLoss:true},{id:'budget-current-mismatch',budget:true,currentMismatch:true},
 {id:'budget-duplicate-history',budget:true,duplicateHistory:true},{id:'budget-dispatcher-403',budget:true,postReject:['dispatcher']},
 {id:'budget-invalid-collector',budget:true,invalidFlags:{collector:{COLLECT_ENABLED:'true'}}},
 {id:'budget-registry-transient',budget:true,registryFailures:1},{id:'budget-version-transient',budget:true,versionErrors:{collector:503},transientOnce:true},
 {id:'budget-version-auth',budget:true,versionErrors:{collector:403}},
 {id:'normal-idle-missing',budget:false,hold:false,evidence:'missing',baseline:null},
 {id:'normal-hold-match-partial',budget:false,evidence:'partial',baseline:null},
 {id:'normal-hold-correction',budget:false,initialMismatch:true},
 {id:'normal-hold-write-failure',budget:false,initialMismatch:true,writeFailure:'submitted'},
 {id:'normal-hold-missing',budget:false,initialMismatch:true,evidence:'missing'},
 {id:'normal-hold-epoch-decreased',budget:false,initialMismatch:true,baseline:3},
 {id:'operator-provided',operator:true},{id:'operator-active',operator:true,activeRuns:1},
 {id:'operator-registry-change',operator:true,registryDriftAfter:2},
 {id:'prepare-exit',budget:true,prepareDeath:'missing'},{id:'prepare-truncated',budget:true,prepareDeath:'truncated'},
 {id:'dispatcher-exit',budget:true,dispatcherDeath:true},
 {id:'result-missing',budget:true,resultFault:'missing'},{id:'result-corrupt',budget:true,resultFault:'corrupt'},
 {id:'relation-budget',budget:true,relationInvalid:true},{id:'relation-operator',operator:true,relationInvalid:true},
];
export function runScenario(source,label,spec){
 const root=path.join(packet,'trace-cases',label,spec.id);fs.mkdirSync(path.join(root,'packet'),{recursive:true});fs.mkdirSync(path.join(root,'provided'),{recursive:true});
 const state={registry:{...structuredClone(registry),maintenanceHold:spec.hold??true},entries:{collector:[],dispatcher:[]},current:{collector:deployment(registry.workers.collector.versionId),dispatcher:deployment(registry.workers.dispatcher.versionId)},nextDeployment:10,versionReads:{collector:0,dispatcher:0},...spec};
 if(spec.initialMismatch)state.current.collector=deployment(registry.workers.dispatcher.versionId,2);
 write(path.join(root,'mock-state.json'),state);
 for(const role of ['collector','dispatcher']){
  let contents='';if(spec.evidence==='partial')contents=JSON.stringify({chain:'incomplete',reason:'mock_partial'})+'\n';
  if(spec.evidence==='pending'){
   const id='88888888-8888-4888-8888-888888888888';
   contents=JSON.stringify({attempt:{requestId:id,role,script:registry.workers[role].script,versionId:registry.workers[role].versionId,epoch:2,startedAt:'2026-10-03T00:00:00.000Z',approvalRef:'mock',message:`forecast-stop/v1:${id};epoch=2;role=${role};kind=operator`},state:'unknown'})+'\n';
  }
  fs.writeFileSync(path.join(root,'provided',role+'-requests.jsonl'),contents);
  write(path.join(root,'provided',role+'-requests.jsonl.origin.json'),{format:1,kind:'baseline',approvalRef:'mock-approved',sourceRef:'mock-history',checkpoint:{bytes:Buffer.byteLength(contents),sha256:hash(contents)}});
 }
 write(path.join(root,'provided/epoch.json'),{epoch:spec.baseline??1});
 const env={SystemRoot:process.env.SystemRoot,TEMP:path.join(packet,'temp'),TMP:path.join(packet,'temp'),STOP_TRACE_ROOT:root,FORECAST_STOP_ONLY_EXECUTION_APPROVED:'true',CLOUDFLARE_ACCOUNT_ID:registry.accountId,GITHUB_REPOSITORY:'just-goforward/Nikke-Collection-Item-Calculator',GH_TOKEN:'mock',CLOUDFLARE_API_TOKEN:'mock',BUDGET_STOP:spec.budget?'true':'false',GITHUB_OUTPUT:path.join(root,'outputs')};
 if(spec.evidence!=='missing')env.FORECAST_STOP_REQUEST_BASELINE_DIR=path.join(root,'provided');
 if(spec.baseline!==null)env.FORECAST_STOP_EPOCH_BASELINE_FILE=path.join(root,'provided/epoch.json');
 const steps=[];
 function child(mode,role){
  const result=spawnSync(node,['--import',pathToFileURL(preload).href,path.join(source,'scripts/forecast-stop-only.ts'),mode,path.join(root,'packet'),...(role?[role]:[])],{env,cwd:source,windowsHide:true,encoding:'utf8',timeout:10000});
  if(result.error)throw result.error;
  const value={mode,...(role?{role}:{}),exit:result.status,signal:result.signal,stderr:result.stderr.trim()};steps.push(value);
  if(value.stderr.includes('node:internal')){write(path.join(root,'boot-failure.json'),value);throw Error('child boot failure: '+value.stderr);}
  return value;
 }
 child('prepare');
 if(spec.relationInvalid){const p=path.join(root,'packet/snapshot.json'),s=JSON.parse(fs.readFileSync(p,'utf8'));delete s.epochBaseline;s.epochComparison='compared';write(p,s);delete env.FORECAST_STOP_EPOCH_BASELINE_FILE;}
 if(spec.operator)child('operator','collector');
 else{
  child('worker','dispatcher');child('worker','collector');
  const target=path.join(root,'packet/dispatcher.json');
  if(spec.resultFault==='missing')fs.unlinkSync(target);
  if(spec.resultFault==='corrupt')fs.writeFileSync(target,'{broken');
  child('finalize');
 }
 const traceFile=path.join(root,'effects.jsonl');
 if(fs.existsSync(traceFile)&&fs.statSync(traceFile).size>4_194_304)throw Error('bounded mock trace exceeded');
 const trace=fs.existsSync(traceFile)?fs.readFileSync(traceFile,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
 const results={};for(const file of fs.readdirSync(path.join(root,'packet')).sort()){if(file.endsWith('.tmp'))continue;const b=fs.readFileSync(path.join(root,'packet',file),'utf8');try{results[file]=file.endsWith('.json')?JSON.parse(b):b;}catch{results[file]=b;}}
 const output={steps,trace,files:results,outputs:fs.existsSync(path.join(root,'outputs'))?fs.readFileSync(path.join(root,'outputs'),'utf8'):''};
 write(path.join(root,'observations.json'),output);return output;
}
export function assertWriteAhead(output,spec){
 for(let i=0;i<output.trace.length;i++){
  const call=output.trace[i];if(call.kind!=='http'||call.method!=='POST')continue;
  const writes=output.trace.slice(0,i).filter(e=>e.phase===call.phase);
  if(spec.writeFailure==='submitted'&&spec.budget){assert(writes.some(e=>e.kind==='write_failure'&&e.state==='submitted'&&e.path.includes(call.phase+'-requests.jsonl')));continue;}
  if(spec.markerFailure&&spec.budget){assert(writes.some(e=>e.kind==='marker_failure'&&e.path.includes(call.phase+'-fallback-requests.jsonl')));continue;}
  const submitted=writes.findLastIndex(e=>{
    if(e.kind!=='write')return false;
    try{const receipt=JSON.parse(e.data);return receipt.state==='submitted'&&receipt.attempt.message===call.body.annotations['workers/message'];}catch{return false;}
  });
  assert(submitted>=0,'POST without submitted write');
  assert(writes.slice(submitted+1).some(e=>e.kind==='fsync'&&e.path===writes[submitted].path),'POST before submitted fsync');
 }
}
export function assertScenario(output,spec){
 const posts=output.trace.filter(e=>e.kind==='http'&&e.method==='POST');
 const expected=spec.operator?(spec.activeRuns||spec.registryDriftAfter||spec.relationInvalid||spec.writeFailure||['missing','partial','pending'].includes(spec.evidence)||spec.baseline===null?0:1):spec.budget?(spec.registryInvalid?0:spec.invalidFlags||spec.versionErrors&&!spec.transientOnce||spec.dispatcherDeath?1:2):spec.initialMismatch&&!spec.writeFailure&&!['missing','partial','pending'].includes(spec.evidence)&&spec.baseline!==3&&spec.baseline!==null?1:0;
 assert.equal(posts.length,expected,'POST count: '+spec.id);
 if(!spec.operator){assert.equal(output.steps.at(-1).exit,spec.outputFailure?1:0,'finalize domain exit');assert(output.files['aggregate.json'],'missing aggregate');assert.equal(output.files['aggregate.json'].nextStageAllowed,spec.expectedNextStageAllowed??false,'scenario aggregate next permission');}
 if(spec.id==='budget-provided')assert.equal(output.files['aggregate.json'].fail,false);
 if(spec.prepareDeath)assert.equal(output.steps[0].exit,23);
 if(spec.dispatcherDeath)assert.equal(output.steps.find(s=>s.role==='dispatcher').exit,24);
 if(spec.outputFailure){assert(output.trace.some(e=>e.kind==='output_failure'));assert.equal(output.outputs,'');}
 if(spec.markerFailure){assert(output.trace.some(e=>e.kind==='marker_failure'));assert(output.files['aggregate.json'].integrityReasons.includes('main_chain_partial_marker_failed'));}
 if(spec.relationInvalid&&spec.budget)for(const role of ['collector','dispatcher'])assert(output.files[role+'-requests.jsonl'].includes('"chain":"incomplete"'));
}
