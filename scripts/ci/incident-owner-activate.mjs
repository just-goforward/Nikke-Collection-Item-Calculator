import {execFileSync} from 'node:child_process';
import {closeSync,fsyncSync,lstatSync,mkdirSync,mkdtempSync,openSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir,userInfo} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {isDeepStrictEqual as same} from 'node:util';
import {account,activeTokenId,client,digest,immutable,requireThat as check,root,versionId,zone} from './incident-provider.mjs';
import {api,gh,graphEnv,numeric,owner,protectedEnv,repo} from './incident-receipt.mjs';
import {original} from './incident-recovery-id.mjs';
import {policy} from './incident-owner.mjs';
import {checkedMain,history,privateInput} from './incident-owner-upload-only.mjs';
import {terminalExit,capabilities,checkedTarget,initialGraph,operate,probeIngress,reconcile,siteWitness} from './incident-activation-control.mjs';
import {stageU,readStageU} from './incident-stage-u-evidence.mjs';
import {observeSite,versionMessage} from './root-promotion-live.mjs';
import enrolled from '../../site-worker/production-root-release-v1.json' with {type:'json'};
import {checkSwitchAuthority} from './root-switch-policy.mjs';

const parent=stageU.source, step='Verify exact existing incident activation and rollback (offline)';
const checkout=fileURLToPath(new URL('../../',import.meta.url));
const files=[
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
export function checkedSource(git,head) {
  check(/^[0-9a-f]{40}$/.test(head) && git('rev-list','--parents','-n','1','HEAD')===`${head} ${parent}` &&
    !git('status','--porcelain','--untracked-files=all') && same(git('diff','--no-renames','--name-only',parent,'HEAD').split('\n').sort(),files),'unreviewed activation checkout');
}
export function routePolicy(d,id,roles) {
  const [p]=d.policies??[], resource=`com.cloudflare.api.account.zone.${zone}`;
  check(immutable.test(id) && d.id===id && d.status==='active' && d.policies.length===1 && p.effect==='allow' &&
    p.permission_groups?.length===1 && roles.get(p.permission_groups[0].id)==='Workers Routes Write' &&
    (same(p.resources,{[resource]:'*'}) || same(p.resources,{[`com.cloudflare.api.account.${account}`]:{[resource]:'*'}})),
    'route token must have only Workers Routes Write on the exact zone');
}
function bounded(token,until) {
  const issued=Date.parse(token.issued_on),end=Date.parse(token.expires_on);
  check(issued<=Date.now() && end>issued && end-issued<=86400000 && end>=until*1000,'a fresh scoped token covering the window is required');
}
const hash=/^[a-f0-9]{64}$/;
function artifactMember(a,member) {
  check(a.size_in_bytes>0 && a.size_in_bytes<=16*1024*1024,'unexpected root receipt archive size');
  const zip=execFileSync('gh',['api',`repos/${repo}/actions/artifacts/${a.id}/zip`],{stdio:['ignore','pipe','pipe'],
    env:{...process.env,GH_HOST:'github.com',GH_DEBUG:'',DEBUG:''},timeout:30000,maxBuffer:16*1024*1024});
  check(`sha256:${digest(zip)}`===a.digest,'GitHub artifact bytes differ');
  const dir=mkdtempSync(join(tmpdir(),'incident-root-proof-')),file=join(dir,'artifact.zip');
  try {
    writeFileSync(file,zip,{flag:'wx',mode:0o600});
    // Read one constant member; never extract paths or execute anything from the archive.
    return execFileSync('/usr/bin/unzip',['-p',file,member],{stdio:['ignore','pipe','pipe'],maxBuffer:16384,timeout:5000});
  } finally {rmSync(dir,{recursive:true,force:true});}
}
// The attestation certifies bytes, not current ownership. Verify a snapshot of the supplied bytes
// and bundle, never a path that will be reopened and interpreted after verification.
export function retainedRestore(dir,head,run,attempt,verify=gh){
  safe(dir,true);
  const read=(name,limit)=>{const p=join(dir,name);safe(p);check(lstatSync(p).size<=limit,'oversize archived receipt');return readFileSync(p);};
  const bytes=read('state.json',16384),bundle=read('state.sigstore.jsonl',1024*1024),tmp=mkdtempSync(join(tmpdir(),'incident-restore-'));
  try {
    const state=join(tmp,'state.json'),proof=join(tmp,'state.sigstore.jsonl');
    writeFileSync(state,bytes,{flag:'wx',mode:0o600});writeFileSync(proof,bundle,{flag:'wx',mode:0o600});
    const results=JSON.parse(verify('attestation','verify',state,'--bundle',proof,'--repo',repo,'--signer-workflow',
      repo+'/.github/workflows/site-worker-promote.yml','--signer-digest',head,'--source-digest',head,'--source-ref','refs/heads/main',
      '--deny-self-hosted-runners','--format','json'));
    check(results.some(x=>{const c=x.verificationResult?.signature?.certificate;
      return c?.runInvocationURI===`https://github.com/${repo}/actions/runs/${run}/attempts/${attempt}` && c.buildTrigger==='workflow_dispatch' &&
        c.sourceRepositoryIdentifier==='1229775730' && c.sourceRepositoryOwnerIdentifier===String(owner);}), 'wrong restore attestation identity');
    return bytes;
  } finally {rmSync(tmp,{force:true,recursive:true});}
}
// Same exact merged SHA pins the entire producing tree, not just the workflow YAML.
export function rootProof(head,run,pair,{query=api,member=artifactMember,archived,gate=()=>protectedEnv(graphEnv)}={}) {
  check(numeric.test(run),'expected intended root run ID');
  const r=query(`actions/runs/${run}`),attempt=String(r.run_attempt),job=pair?'publish-root-pair':'prepare-root-pair';
  check(String(r.id)===run && numeric.test(attempt) && r.head_sha===head && r.path==='.github/workflows/site-worker-promote.yml' &&
    r.event==='workflow_dispatch' && r.actor?.id===owner && r.triggering_actor?.id===owner && r.head_branch==='main' &&
    r.repository?.id===1229775730 && r.head_repository?.id===1229775730 && r.status==='completed' && r.conclusion==='success','unadmitted root run or altered source');
  const envId=gate(), approvals=query(`actions/runs/${run}/approvals`);
  check(approvals.some(v=>v.state==='approved' && v.user?.id===owner && v.environments?.some(e=>e.id===envId && e.name===graphEnv)),'no protected root approval');
  const jobs=query(`actions/runs/${run}/attempts/${attempt}/jobs?per_page=100`);
  check(jobs.total_count===jobs.jobs.length && jobs.jobs.filter(j=>j.name===job && j.conclusion==='success').length===1,'wrong root producer');
  let bytes,artifactOperation;
  if(archived) {
    check(pair && jobs.jobs.filter(j=>j.name==='attest-root-state' && j.conclusion==='success').length===1,'successful restore attester required');
    bytes=archived(head,run,attempt);
  } else {
    const suffix=`-${head}-${run}-${attempt}`;
    const keys=pair?['root-state-root-restore-rollback','root-state-root-abandon-bridge']:['root-pair-receipt'];
    const artifacts=query(`actions/runs/${run}/artifacts?per_page=100`);
    check(artifacts.total_count===artifacts.artifacts.length,'incomplete root artifact inventory');
    const hits=artifacts.artifacts.filter(x=>keys.some(k=>x.name===k+suffix));
    check(hits.length===1 && hits[0].expired===false && /^sha256:[0-9a-f]{64}$/.test(hits[0].digest) &&
      Number.isSafeInteger(hits[0].id) && hits[0].id>0 && String(hits[0].workflow_run?.id)===run &&
      hits[0].workflow_run.head_sha===head,'missing immutable root artifact');
    if(pair)artifactOperation=hits[0].name.slice('root-state-'.length,-suffix.length);
    bytes=member(hits[0],pair?'state.json':'handoff.json');
  }
  const v=JSON.parse(bytes);
  check(v.run===run && v.attempt===attempt,'artifact run or attempt changed');
  if(!pair) {
    check(v.profile==='production-root-pair-handoff-v1' && v.sha===head && v.repository===repo && v.deployed===false &&
      hash.test(v.directions?.rollback?.manifestSha256) && hash.test(v.directions?.forward?.manifestSha256) &&
      hash.test(v.rehearsalSha256) && hash.test(v.packetSha256) &&
      v.directions.rollback.manifestSha256!==v.directions.forward.manifestSha256,'wrong intended root handoff');
    return {run,attempt,handoff:digest(bytes),rollback:v.directions.rollback.manifestSha256,forward:v.directions.forward.manifestSha256,packet:v.packetSha256,rehearsal:v.rehearsalSha256};
  }
  check(v.profile==='production-root-state-v1' && terminalExit(v) && (!artifactOperation || v.operation===artifactOperation) && v.source===head &&
    v.handoffSha256===pair.handoff && v.manifestSha256===pair.rollback && hash.test(v.moduleSha256) && hash.test(v.controlSha256) &&
    versionId.test(v.deployment) && versionId.test(v.version) && v.producerVersion===enrolled.publisherVersion &&
    versionId.test(v.incident?.deployment) && v.incident.version===stageU.version && v.incident.build===stageU.build,'root restoration not bound to enrolled handoff and receiver');
  return v;
}
export function restoredControl(receipt,live) {
  check(receipt.deployment===live.deployment && receipt.version===live.version && receipt.controlSha256===live.controlSha256 &&
    receipt.moduleSha256===live.moduleSha256 && receipt.producerVersion===live.producerVersion && same(receipt.incident,live.incident) &&
    live.annotations?.['workers/tag']===receipt.source && live.annotations['workers/message']===versionMessage('rollback',receipt.manifestSha256),
    'protected root restoration does not match live controls');
}
function windowOpen(until) {const ms=until*1000-Date.now();check(Number.isSafeInteger(until) && ms>0 && ms<=3600000,'outside operator window');}
function safe(path,dir=false) {
  const s=lstatSync(path);check((dir?s.isDirectory():s.isFile() && s.nlink===1) && s.uid===process.getuid() && (s.mode&0o077)===0,'unsafe owner custody');
}
const readJSON=path=>{safe(path);return JSON.parse(readFileSync(path,'utf8'));};
function syncDir(dir) {const fd=openSync(dir,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
export function custody(dir) {
  const put=(name,data)=>{safe(dir,true);writeFileSync(join(dir,name),JSON.stringify(data)+'\n',{flag:'wx',mode:0o600,flush:true});syncDir(dir);};
  const get=name=>readJSON(join(dir,name));
  const identity={schema:3,worker:original.workerId,stageU,from:history[0].id};
  return {
    begin(head,before,pair) {mkdirSync(dir,{mode:0o700});syncDir(dirname(dir));put('start',{...identity,head,before,pair});},
    intent(n,op) {put(`${n}.intent`,{op});},
    ack(n,op,ack) {put(`${n}.ack`,{op,ack});},
    load(head) {
      safe(dir,true);const start=get('start');
      check(same(start,{...identity,head,before:start.before,pair:start.pair}) && start.before?.sites?.length===2 &&
        numeric.test(start.pair?.run) && numeric.test(start.pair.attempt) && ['handoff','rollback','forward','packet','rehearsal'].every(k=>hash.test(start.pair[k])),'wrong activation receipt');
      const entries=new Set(readdirSync(dir)), rows=[];entries.delete('start');
      while(entries.size) {
        const n=rows.length;check(n<6 && entries.delete(`${n}.intent`) && entries.delete(`${n}.ack`),'ambiguous or incomplete write; reconcile read-only');
        const row=get(`${n}.ack`);check(same(get(`${n}.intent`),{op:row.op}),'journal intent/ACK mismatch');rows.push(row);
      }
      return {before:start.before,pair:start.pair,rows};
    },
  };
}
function uploadProof(home) {
  readStageU(join(home,'.incident-owner-upload-only'));
  const j=join(home,'.incident-private-canary','45197180403','journal.jsonl');safe(j);
  check(digest(readFileSync(j))==='c86e031f96c0b4c5e87e76e516d4ded97c79ee4feef9561617ab1338a97f059f','wrong private successor journal');
}
export async function authorizeTokens({management,reader,editor,route,registered,retired,until}) {
  const groups=await management(`${root}/tokens/permission_groups`);
  check(Array.isArray(groups) && groups.every(g=>immutable.test(g.id) && typeof g.name==='string'),'invalid permission catalog');
  const roles=new Map(groups.map(g=>[g.id,g.name]));check(roles.size===groups.length,'ambiguous permission catalog');
  const [mid,rid,eid,zid]=await Promise.all([management,reader,editor,route].map(c=>activeTokenId(c)));
  check(new Set([mid,rid,eid,zid]).size===4 && rid===registered && eid!==retired && zid!==retired,'wrong or shared token identity');
  const detail=id=>management(`${root}/tokens/${id}`);
  const md=await detail(mid), [p]=md.policies??[];
  check(md.status==='active' && md.id===mid && md.policies.length===1 && p.effect==='allow' && p.permission_groups?.length===1 &&
    roles.get(p.permission_groups[0].id)==='Account API Tokens Read' && same(p.resources,{[`com.cloudflare.api.account.${account}`]:'*'}),'wrong token-policy reader');
  policy(await detail(rid),rid,roles);
  const e=await detail(eid), z=await detail(zid);policy(e,eid,roles,original.workerId);routePolicy(z,zid,roles);bounded(e,until);bounded(z,until);
}
async function main([mode,end,run,...extra]) {
  const readOnly=mode==='reconcile';
  check(['activate','rollback','reconcile'].includes(mode) && /^\d{10}$/.test(end) && (mode!=='activate' && run===undefined || numeric.test(run)) &&
    !extra.length && !process.env.CI && !process.env.GITHUB_ACTIONS && (readOnly || !process.stdin.isTTY),'local owner, window and intended root proof required');
  const until=Number(end); windowOpen(until);
  const home=userInfo().homedir,git=(...args)=>execFileSync('git',args,{cwd:checkout,stdio:['ignore','pipe','pipe'],encoding:'utf8'}).trim(),head=git('rev-parse','HEAD');
  const source=()=>{checkedSource(git,head);check(JSON.parse(gh('api','user')).id===owner,'not the authenticated owner');checkedMain(head,api,step,mode!=='activate');};
  source();uploadProof(home);
  const journal=custody(join(home,'.incident-owner-activation-'+original.workerId)),graphToken=privateInput(4),reader=client(graphToken);
  const registered=()=>gh('variable','get','INCIDENT_GRAPH_TOKEN_ID','--env',graphEnv,'--repo',repo);
  const observe={inspect:s=>checkedTarget(reader,s),witness:()=>siteWitness(reader,fetch),ingress:open=>probeIngress(fetch,open),
    restoreProof:run?pair=>rootProof(head,run,pair,{archived:process.env.ROOT_RESTORE_ARCHIVE ? (h,r,a)=>retainedRestore(process.env.ROOT_RESTORE_ARCHIVE,h,r,a) : undefined}):undefined,restoredControl:async receipt=>restoredControl(receipt,await observeSite(enrolled,graphToken))};
  if(readOnly) {
    check(await activeTokenId(reader)===registered(),'unregistered graph reader');
    console.log(JSON.stringify(await reconcile({...observe,load:()=>journal.load(head)})));return;
  }
  const past=api('actions/runs/45171435589/approvals').filter(r=>r.user?.id===owner && r.state==='approved' && r.comment?.startsWith('incident-private-v1:'));
  check(past.length===1,'retired installer identity unavailable');const old=JSON.parse(past[0].comment.slice('incident-private-v1:'.length));
  check(old.workerId===original.workerId && immutable.test(old.editorId),'retired installer identity changed');
  const management=client(privateInput(3)),routeToken=privateInput(5),editorToken=privateInput(0);
  const auth={management,reader,editor:client(editorToken),route:client(routeToken),retired:old.editorId,until};
  const authority=async()=>{source();await authorizeTokens({...auth,registered:registered()});windowOpen(until);};
  const ops=capabilities(editorToken,routeToken,graphToken,fetch);
  protectedEnv(graphEnv);
  const signed=Object.fromEntries(['ROOT_SWITCH_SIGNERS','ROOT_TECHNICAL_REVIEW','ROOT_OWNER_DECISION'].map(k=>[k,gh('variable','get',k,'--env',graphEnv,'--repo',repo)]));
  const approveChange=([record,...state])=>{
    const {packet,rehearsal,forward,rollback}=record;
    return checkSwitchAuthority(signed,head,'incident-'+mode,{until,run:run??null,worker:original.workerId,stageU,handoff:record.handoff,pair:{packet,rehearsal,forward,rollback},state});
  };
  console.log(JSON.stringify(await operate(mode,{...ops,...observe,head,journal,authority,approveChange,
    initialGraph:()=>initialGraph(reader),pairProof:()=>rootProof(head,run,null),windowOpen:()=>windowOpen(until)})));
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(()=>{
  console.error('Stopped: approval, custody, current state, or ACK not proven. Preserve journal; no replay or broader credentials. Reconcile read-only before rollback.');process.exitCode=1;
});
