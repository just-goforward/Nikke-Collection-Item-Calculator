// Stage U: ONE inactive version for one known predecessor. No deploy, cron, route, D1 or notification operation.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createPublicKey,verify} from 'node:crypto';
import {closeSync,constants,fstatSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {userInfo} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {account,activeTokenId,bindings,client,digest,immutable,versionId,zone} from './incident-provider.mjs';
import {api,gh,graphEnv,owner,protectedEnv,repo} from './incident-receipt.mjs';
import {original} from './incident-recovery-id.mjs';
import {baseline,privateGraph,target} from './incident-canary-control.mjs';
import {beforeIds,checkedCredentials,checkedMain,closed,historicalEditor,privateInput,publicBindings,publicHash,uploadReadbacks} from './incident-owner-upload-only.mjs';
import enrollment from '../../site-worker/production-root-release-v1.json' with {type:'json'};

const parent='ca2904054baf83ddc2a59166f9436776966a01d8', step='Verify mobile retry inactive successor (offline)';
export const predecessor='00323557-9e9f-470f-b491-3906316f5d69', newBuild='24d65a8263bf42e0205f4ee49c5451344c7c35c4c645cb849c4e88a47bb55f83';
const markerSha='e16afc3b992035149f42000b5984ac654acbaf8d5db7329ee411c03e31240068',ackSha='6e132d263351ea1ca1312a8d202c7ec6ea8e06e96ecb6dd52c26068a2ca1ae14';
const prior=[...beforeIds,predecessor].sort(), inherited=['ADMIN_ID','BOT_TOKEN'];
const destination=()=>bindings(newBuild).map(b=>b.name==='PUBLIC_INGRESS'?{...b,text:'1'}:b);
const checkWindow=(until,now=Date.now())=>assert(Number.isSafeInteger(until) && now<until*1000 && until*1000<=now+3600000,'outside signed upload window');
function checkDirectory(dir) {const s=lstatSync(dir);assert(s.isDirectory() && s.uid===process.getuid() && !(s.mode&0o077) && realpathSync(dir)===dir,'unsafe owner directory');}
function originalFile(file,expected) {
  const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const s=fstatSync(fd);assert(s.isFile() && s.nlink===1 && s.uid===process.getuid() && !(s.mode&0o077) && s.size<4096);
    const bytes=readFileSync(fd);assert.equal(digest(bytes),expected,'predecessor receipt changed');return JSON.parse(bytes);}
  finally {closeSync(fd);}
}
export function readPredecessor(dir) {
  checkDirectory(dir);const file=join(dir,original.workerId+'.json'),m=originalFile(file,markerSha);
  assert.equal(m.phase,'attempt-consumed');assert.equal(m.reviewedMain,parent);assert.equal(m.hash,publicHash);assert.equal(m.deployment,closed.deployment);
  assert.deepEqual(originalFile(file+'.ack',ackSha),{candidate:predecessor});
  return {markerSha,ackSha,issued:Date.parse(m.utc)};
}
function sync(dir) {const fd=openSync(dir,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
const record=(dir,name,v)=>{writeFileSync(join(dir,name),JSON.stringify(v)+'\n',{mode:0o600,flag:'wx',flush:true});sync(dir);};
export function uploadScope(head,until,topology,editorId,readerId) {
  assert.match(head,/^[a-f0-9]{40}$/);assert.match(topology,/^[a-f0-9]{64}$/);assert.match(editorId,immutable);assert.match(readerId,immutable);assert.notEqual(editorId,readerId);
  return {operation:'mobile-successor-inactive-upload-v1',repository:repo,source:head,account,worker:original.workerId,predecessor,markerSha,ackSha,build:newBuild,module:publicHash,bindingsSha256:digest(JSON.stringify(destination())),donor:baseline.donor,inertDeployment:closed.deployment,topology,editorId,readerId,until};
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
  const priorState=async()=>{await routes();await expectClosed();await verifyKnown();await exact(predecessor,publicHash,inherited,'worker.js',publicBindings());};
  const topology=async()=>{await priorState();assert.deepEqual(await inventory(),prior);return privateGraph(read);};
  return {topology,priorState,expectClosed,routes,inventory,exact};
}
export async function reviewScope({head,until,editorId,readerId,read}) {
  checkWindow(until);const graph=await receiverChecks(read).topology();checkWindow(until);
  const scope=uploadScope(head,until,graph,editorId,readerId);
  return {scope,scopeSha256:digest(JSON.stringify(scope)),uploadAuthorized:false};
}
export async function replaceInactive({head,until,module,dir,read,send,token,editorId,readerId,authorize}) {
  checkWindow(until);assert.equal(enrollment.serviceCodeHash,newBuild);assert.notEqual(newBuild,baseline.build);assert.equal(digest(module),publicHash);
  const {topology:checkTopology,priorState,expectClosed,routes,inventory,exact}=receiverChecks(read);
  const topology=await checkTopology();
  const scope=uploadScope(head,until,topology,editorId,readerId),approval=await authorize(scope);
  assert.equal(await checkTopology(),topology);
  assert.deepEqual(await authorize(scope),approval);checkDirectory(dir);checkWindow(until);
  // One fixed slot on the original owner device. Never select a fresh directory by run, build, expiry or attempt.
  const slot=join(dir,'successor-of-'+predecessor);mkdirSync(slot,{mode:0o700});sync(dir);
  record(slot,'intent.json',{scope,approval});checkWindow(until);
  let id;
  try {
    const res=await send('https://api.cloudflare.com/client/v4'+target+'/versions?deploy=false',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({main_module:'worker.js',compatibility_date:'2026-08-14',compatibility_flags:[],bindings:[...destination(),...inherited.map(name=>({name,type:'inherit',version_id:baseline.donor}))],modules:[{name:'worker.js',content_type:'application/javascript+module',content_base64:module.toString('base64')}]})});
    assert(res.ok);const v=await res.json();assert(v.success===true && ((v.errors===null && v.messages===null)||(Array.isArray(v.errors)&&!v.errors.length&&Array.isArray(v.messages))));
    id=v.result.id;assert.match(id,versionId);assert(!prior.includes(id));record(slot,'ack.json',{id,source:head,predecessor,build:newBuild,module:publicHash,bindingsSha256:scope.bindingsSha256});
    await exact(id,publicHash,inherited,'worker.js',destination());await priorState();assert.deepEqual(await inventory(),[...prior,id].sort());
  } finally {await expectClosed();assert.equal(await privateGraph(read),topology);await routes();await expectClosed();}
  checkWindow(until); const verified={state:'verified-inactive-only',id,scope,approval,verifiedAt:Date.now(),activationAuthorized:false};record(slot,'verified.json',verified);return verified;
}
async function main([file,end,editorId,...extra]) {
  const preview=file==='--review-scope';
  assert(file && /^\d{10}$/.test(end) && !extra.length && (preview?typeof editorId==='string' && immutable.test(editorId):editorId===undefined) && !process.env.CI && !process.env.GITHUB_ACTIONS);
  const until=Number(end);checkWindow(until);
  const cwd=fileURLToPath(new URL('../../',import.meta.url)),git=(...a)=>execFileSync('git',a,{cwd,encoding:'utf8'}).trim();
  assert.equal(realpathSync(process.cwd()),realpathSync(cwd),'run from the exact reviewed checkout');
  const dir=join(userInfo().homedir,'.incident-owner-upload-only'),head=git('rev-parse','HEAD');
  const source=()=>{assert.equal(git('rev-parse','HEAD'),head);assert.equal(git('rev-parse','HEAD^'),parent);assert.equal(git('status','--porcelain','--untracked-files=all'),'');assert.equal(JSON.parse(gh('api','user')).id,owner);checkedMain(head,api,step);};
  source();const priorReceipt=readPredecessor(dir);protectedEnv(graphEnv);
  const {assertServiceH14Build}=await import('../service-h14-integrity.ts');const identity=await assertServiceH14Build();
  assert.equal(identity.codeHash,newBuild);assert.equal(identity.nativeSourceHash,enrollment.nativeSourceHash);assert.equal(identity.exactWasmHash,enrollment.nativeWasmSha256);
  const retained=process.env.INCIDENT_U_RETAINED_PROOF_DIR;
  if(retained!==undefined)checkDirectory(retained);
  const retired=historicalEditor(retained);
  if(preview) {
    // FD4 only. Never read a policy token, Editor, review envelope or owner decision to preview a scope.
    const read=client(privateInput(4)),readerId=await activeTokenId(read);
    assert(readerId===gh('variable','get','INCIDENT_GRAPH_TOKEN_ID','--env',graphEnv,'--repo',repo) && editorId!==retired,'unregistered reader or retired Editor');
    const result=await reviewScope({head,until,editorId,readerId,read});source();checkWindow(until);
    console.log(JSON.stringify(result));return;
  }
  const module=readFileSync(file);assert.equal(digest(module),publicHash);
  const credentials=await checkedCredentials(retired,until);assert(credentials.issued>priorReceipt.issued,'fresh successor-only Editor required');
  const variable=k=>gh('variable','get',k,'--env',graphEnv,'--repo',repo);
  const authorize=async scope=>{source();readPredecessor(dir);protectedEnv(graphEnv);await credentials.recheck();const cid=variable('INCIDENT_U_OWNER_COMMENT_ID');assert.match(cid,/^[1-9][0-9]{0,15}$/);
    const c=api('comments/'+cid);assert.equal(String(c.id),cid);return checkApproval(scope,c,variable('INCIDENT_U_TECH_REVIEW'),variable('INCIDENT_U_TECH_REVIEW_KEY'));};
  console.log(JSON.stringify(await replaceInactive({head,until,module,dir,...credentials,authorize,send:fetch})));
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(()=>{
  console.error('Stopped: preserve both original and successor journals. No replay, activation or inferred ACK. Reconcile with authenticated reads only.');process.exitCode=1;
});
