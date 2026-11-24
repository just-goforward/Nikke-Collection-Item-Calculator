// Layout successor: ONE inactive version after the original Stage U receipt. No activation or retry.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createPublicKey,verify} from 'node:crypto';
import {closeSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {userInfo} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {account,activeTokenId,client,digest,immutable,versionId,zone} from './incident-provider.mjs';
import {api,gh,graphEnv,owner,protectedEnv,repo} from './incident-receipt.mjs';
import {original} from './incident-recovery-id.mjs';
import {baseline,privateGraph,target} from './incident-canary-control.mjs';
import {beforeIds,checkedCredentials,checkedMobileMain,closed,historicalEditor,privateInput,publicBindings,publicHash,uploadReadbacks} from './incident-owner-upload-only.mjs';
import {checkOwnerDirectory,checkReceiverVersion,readStageU,stageU,stageUPredecessor} from './incident-stage-u-evidence.mjs';
import enrollment from '../../site-worker/production-root-release-v1.json' with {type:'json'};

const recoveryParent='1b73c733283f3cecaaaee782fe897281493be631';
const recoveryFiles=[
  '.github/workflows/site-source-verify.yml','docs/root-rum-witness.md','production-incidents/RUNBOOK.ko.md',
  'scripts/ci/incident-activation-control.mjs','scripts/ci/incident-mobile-successor.mjs','scripts/ci/incident-mobile-successor.test.mjs',
  'scripts/ci/incident-owner-activate.mjs','scripts/ci/incident-owner-activate.test.mjs',
  'scripts/ci/incident-owner-upload-only.mjs','scripts/ci/incident-owner-upload-only.test.mjs',
  'scripts/ci/incident-stage-u-evidence.mjs','scripts/ci/root-promotion.test.mjs','site-worker/production-root-release-v1.json',
  'src/components/StockPanel.tsx','src/serviceH14/generated/build.ts',
];
export const newBuild='2bfe30a171be2e58243bcf3c6b05961c3b031a1d4ddbc114e650a928605c90d0';
const predecessor=stageU.version,bindingsSha256='8db7effc4f4f7f0bf97c536e4960f642692806689c83a871dd4f1b870ef383bd';
const prior=[...beforeIds,stageUPredecessor,predecessor].sort(), inherited=['ADMIN_ID','BOT_TOKEN'];
const slotPath=dir=>join(dir,'successor-of-'+predecessor);
const checkWindow=(until,now=Date.now())=>assert(Number.isSafeInteger(until) && now<until*1000 && until*1000<=now+3600000,'outside signed upload window');
function unusedSlot(dir) {
  checkOwnerDirectory(dir);const slot=slotPath(dir);
  assert.equal(lstatSync(slot,{throwIfNoEntry:false}),undefined,'layout attempt already consumed; preserve original evidence');return slot;
}
function sync(dir) {const fd=openSync(dir,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
const record=(dir,name,v)=>{writeFileSync(join(dir,name),JSON.stringify(v)+'\n',{mode:0o600,flag:'wx',flush:true});sync(dir);};
export function uploadScope(head,until,topology,editorId,readerId) {
  assert.match(head,/^[a-f0-9]{40}$/);assert.match(topology,/^[a-f0-9]{64}$/);assert.match(editorId,immutable);assert.match(readerId,immutable);assert.notEqual(editorId,readerId);
  assert.equal(enrollment.serviceCodeHash,newBuild);assert.equal(digest(JSON.stringify(publicBindings(newBuild))),bindingsSha256);
  return {operation:'layout-successor-inactive-upload-v1',repository:repo,source:head,account,worker:original.workerId,predecessor,predecessorReceipt:stageU,build:newBuild,module:publicHash,bindingsSha256,donor:baseline.donor,inertDeployment:closed.deployment,topology,editorId,readerId,until};
}
// Independent reviewer may be an automated service. Only the authenticated human owner's unedited commit comment authorizes THIS scope.
export function checkApproval(scope,comment,reviewEnvelope,reviewKey,now=Date.now()) {
  checkWindow(scope.until,now);assert.equal(comment.commit_id,scope.source);assert.equal(comment.user?.id,owner);assert.equal(comment.author_association,'OWNER');assert.equal(comment.created_at,comment.updated_at);
  const issued=Date.parse(comment.created_at);assert(issued<=now && scope.until*1000-issued<=3600000);
  const scopeSha256=digest(JSON.stringify(scope));
  const {statement,signature}=JSON.parse(reviewEnvelope);assert.match(reviewKey,/^[A-Za-z0-9_-]{43}$/);assert.equal(Buffer.from(reviewKey,'base64url').toString('base64url'),reviewKey);
  assert(verify(null,Buffer.from(statement),createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:reviewKey},format:'jwk'}),Buffer.from(signature,'base64')),'invalid technical review signature');
  const r=JSON.parse(statement);assert.equal(r.kind,'technical-review-only-v1');assert.equal(r.source,scope.source);assert.equal(r.scopeSha256,scopeSha256);assert.equal(r.openBlockers,0);assert.equal(r.publicationApproved,false);
  for(const field of ['reviewer','method','findings','disposition'])assert(typeof r[field]==='string' && r[field].trim().length>0);
  const reviewSha256=digest(reviewEnvelope); assert.equal(comment.body,'APPROVE INACTIVE UPLOAD ONLY '+scopeSha256+' '+reviewSha256);
  assert(Number.isSafeInteger(comment.id)&&comment.id>0);return {commentId:comment.id,scopeSha256,reviewSha256};
}
function receiverChecks(read) {
  const {expectClosed,inventory,exact,verifyKnown}=uploadReadbacks(read);
  const routes=async()=>{
    const rows=await read('/zones/'+zone+'/workers/routes');assert.equal(rows.length,3);
    for(const [id,path,script] of [['863270c636c945b8b788c329c9762f50','/preview/*','collection-kit-site-preview-k1r2'],['483199a1890b4fb696b38d53b6d63e3c','/api/calendar','collection-kit-conditional-production'],['85e95eb76fd94eeba4531b7b26caa11c','/api/joint-supply/v2','collection-kit-conditional-production']])assert(rows.some(r=>r.id===id && r.pattern==='nikkecollection.com'+path && r.script===script && r.request_limit_fail_open===false),'zone routes changed');
  };
  const priorState=async()=>{
    await routes();await expectClosed();await verifyKnown();
    await exact(stageUPredecessor,publicHash,inherited,'worker.js',publicBindings());
    await checkReceiverVersion(read,stageU.build);
  };
  const topology=async()=>{await priorState();assert.deepEqual(await inventory(),prior);return privateGraph(read);};
  return {topology,priorState,expectClosed,routes,inventory,exact};
}
export async function reviewScope({head,until,editorId,readerId,read,dir}) {
  checkWindow(until);unusedSlot(dir);const graph=await receiverChecks(read).topology();unusedSlot(dir);checkWindow(until);
  const scope=uploadScope(head,until,graph,editorId,readerId);
  return {scope,scopeSha256:digest(JSON.stringify(scope)),uploadAuthorized:false};
}
export async function replaceInactive({head,until,module,dir,read,send,token,editorId,readerId,authorize}) {
  checkWindow(until);unusedSlot(dir);assert.equal(digest(module),publicHash);
  const {topology:checkTopology,priorState,expectClosed,routes,inventory,exact}=receiverChecks(read);
  const topology=await checkTopology();
  const scope=uploadScope(head,until,topology,editorId,readerId),approval=await authorize(scope);
  assert.equal(await checkTopology(),topology);
  assert.deepEqual(await authorize(scope),approval);checkWindow(until);
  // One fixed slot on the original owner device. Never select a fresh directory by run, build, expiry or attempt.
  const slot=unusedSlot(dir);mkdirSync(slot,{mode:0o700});sync(dir);
  record(slot,'intent.json',{scope,approval});checkWindow(until);
  let id;
  try {
    const res=await send('https://api.cloudflare.com/client/v4'+target+'/versions?deploy=false',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({main_module:'worker.js',compatibility_date:'2026-08-14',compatibility_flags:[],bindings:[...publicBindings(newBuild),...inherited.map(name=>({name,type:'inherit',version_id:baseline.donor}))],modules:[{name:'worker.js',content_type:'application/javascript+module',content_base64:module.toString('base64')}]})});
    assert(res.ok);const v=await res.json();assert(v.success===true && ((v.errors===null && v.messages===null)||(Array.isArray(v.errors)&&!v.errors.length&&Array.isArray(v.messages))));
    id=v.result.id;assert.match(id,versionId);assert(!prior.includes(id));record(slot,'ack.json',{id,source:head,predecessor,build:newBuild,module:publicHash,bindingsSha256:scope.bindingsSha256});
    await exact(id,publicHash,inherited,'worker.js',publicBindings(newBuild));await priorState();assert.deepEqual(await inventory(),[...prior,id].sort());
  } finally {await expectClosed();assert.equal(await privateGraph(read),topology);await routes();await expectClosed();}
  checkWindow(until); const verified={state:'verified-inactive-only',id,scope,approval,verifiedAt:Date.now(),activationAuthorized:false};record(slot,'verified.json',verified);return verified;
}
export function checkRecoveryCheckout(head,git) {
  assert.match(head,/^[a-f0-9]{40}$/);
  assert.equal(git('rev-list','--parents','-n','1','HEAD'),head+' '+recoveryParent,'expected the single layout squash');
  assert.equal(git('status','--porcelain','--untracked-files=all'),'','dirty layout checkout');
  assert.deepEqual(git('diff','--no-renames','--name-only',recoveryParent,head).split('\n').sort(),recoveryFiles,'unexpected combined layout diff');
}
async function main([file,end,editorId,...extra]) {
  const preview=file==='--review-scope';
  assert(file && /^\d{10}$/.test(end) && !extra.length && (preview?typeof editorId==='string' && immutable.test(editorId):editorId===undefined) && !process.env.CI && !process.env.GITHUB_ACTIONS);
  const until=Number(end);checkWindow(until);
  const cwd=fileURLToPath(new URL('../../',import.meta.url)),git=(...a)=>execFileSync('git',a,{cwd,encoding:'utf8'}).trim();
  assert.equal(realpathSync(process.cwd()),realpathSync(cwd),'run from the exact reviewed checkout');
  const dir=join(userInfo().homedir,'.incident-owner-upload-only'),head=git('rev-parse','HEAD');
  const source=()=>{checkRecoveryCheckout(head,git);assert.equal(JSON.parse(gh('api','user')).id,owner);checkedMobileMain(head,api);};
  source();const priorReceipt=readStageU(dir);unusedSlot(dir);protectedEnv(graphEnv);
  const {assertServiceH14Build}=await import('../service-h14-integrity.ts');const identity=await assertServiceH14Build();
  assert.equal(identity.codeHash,newBuild);assert.equal(identity.nativeSourceHash,enrollment.nativeSourceHash);assert.equal(identity.exactWasmHash,enrollment.nativeWasmSha256);
  const retained=process.env.INCIDENT_U_RETAINED_PROOF_DIR;
  if(retained!==undefined)checkOwnerDirectory(retained);
  const retired=historicalEditor(retained);
  if(preview) {
    // FD4 only. Never read a policy token, Editor, review envelope or owner decision to preview a scope.
    const read=client(privateInput(4)),readerId=await activeTokenId(read);
    assert(readerId===gh('variable','get','INCIDENT_GRAPH_TOKEN_ID','--env',graphEnv,'--repo',repo) && editorId!==retired && editorId!==priorReceipt.scope.editorId,'unregistered reader or retired Editor');
    const result=await reviewScope({head,until,editorId,readerId,read,dir});source();readStageU(dir);unusedSlot(dir);checkWindow(until);
    console.log(JSON.stringify(result));return;
  }
  const module=readFileSync(file);assert.equal(digest(module),publicHash);
  const credentials=await checkedCredentials(retired,until);
  assert(credentials.issued>priorReceipt.verifiedAt && credentials.editorId!==priorReceipt.scope.editorId,'fresh layout-only Editor required');
  const variable=k=>gh('variable','get',k,'--env',graphEnv,'--repo',repo);
  const authorize=async scope=>{source();readStageU(dir);protectedEnv(graphEnv);await credentials.recheck();const cid=variable('INCIDENT_LAYOUT_OWNER_COMMENT_ID');assert.match(cid,/^[1-9][0-9]{0,15}$/);
    const c=api('comments/'+cid);assert.equal(String(c.id),cid);return checkApproval(scope,c,variable('INCIDENT_LAYOUT_TECH_REVIEW'),variable('INCIDENT_LAYOUT_TECH_REVIEW_KEY'));};
  console.log(JSON.stringify(await replaceInactive({head,until,module,dir,...credentials,authorize,send:fetch})));
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(()=>{
  console.error('Stopped: preserve both original and successor journals. No replay, activation or inferred ACK. Reconcile with authenticated reads only.');process.exitCode=1;
});
