import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {isDeepStrictEqual as same} from 'node:util';
import {baseline, control, privateGraph, schedule, script, target} from './incident-canary-control.mjs';
import {beforeIds, history, publicBindings, publicHash, uploadReadbacks} from './incident-owner-upload-only.mjs';
import {stageU,stageUPredecessor,checkReceiverVersion} from './incident-stage-u-evidence.mjs';
import {db, immutable, name, noPreviews, requireThat as check, root, versionId, workers, zone} from './incident-provider.mjs';
import {original} from './incident-recovery-id.mjs';
import {incidentOrigin, incidentPath} from '../../shared/recalculationIncident.ts';
import {successorSummary} from '../../production-incidents/sealed-successor.ts';
import enrolled from '../../site-worker/production-root-release-v1.json' with {type:'json'};

const candidate=stageU.version;
export const routePath = `/zones/${zone}/workers/routes`, incidentUrl = incidentOrigin + incidentPath;
const host = new URL(incidentOrigin).hostname, pattern = host + incidentPath;
const preview = 'collection-kit-site-preview-k1r2', site = 'collection-kit-site-production', publisher = 'collection-kit-conditional-production';
const neighbors = [
  ['863270c636c945b8b788c329c9762f50',host+'/preview/*',preview],
  ['483199a1890b4fb696b38d53b6d63e3c',host+'/api/calendar',publisher],
  ['85e95eb76fd94eeba4531b7b26caa11c',host+'/api/joint-supply/v2',publisher],
];
const split = version_id => [{version_id,percentage:100}];
const state0 = () => ({active:null,cron:null,route:null,restored:null,reverse:false});

// A write ACK is provenance, not a live read. Never infer an ACK from inventory.
function transition(s,op,ack) {
  switch (op) {
    case 'deploy': case 'restore': {
      const version = op === 'deploy' ? candidate : baseline.version;
      check(versionId.test(ack?.id) && !history.some(d=>d.id===ack.id) && ack.id!==s.active &&
        (!Object.hasOwn(ack,'versions') || same(ack.versions,split(version))), 'ambiguous deployment ACK');
      return op === 'deploy' ? {...s,active:ack.id} : {...s,restored:ack.id,reverse:true};
    }
    case 'arm': {
      const [row,...rest] = ack.schedules;
      check(!rest.length && row?.cron===schedule && Number.isFinite(Date.parse(row.created_on)) &&
        Date.parse(row.modified_on)>=Date.parse(row.created_on),'ambiguous cron ownership');
      return {...s,cron:{cron:schedule,created_on:row.created_on,modified_on:row.modified_on}};
    }
    case 'expose':
      check(immutable.test(ack?.id) && !neighbors.some(([id])=>id===ack.id) &&
        (!Object.hasOwn(ack,'pattern') || ack.pattern===pattern) && (!Object.hasOwn(ack,'script') || ack.script===name),'ambiguous route ACK');
      return {...s,route:ack.id};
    case 'withdraw': check(ack?.id===s.route,'route deletion not acknowledged'); return {...s,route:null,reverse:true};
    case 'disarm': check(same(ack.schedules,[]),'cron removal not acknowledged'); return {...s,cron:null,reverse:true};
    default: throw Error('unknown operation');
  }
}
function next(s,reverse) {
  if (s.restored) return null;
  if (reverse) return s.route?'withdraw':s.cron?'disarm':s.active?'restore':null;
  check(!s.reverse,'activation cannot resume after rollback');
  return !s.active?'deploy':!s.cron?'arm':!s.route?'expose':null;
}
export function replay(rows) {
  let state = state0();
  for (const {op,ack} of rows) {
    const reverse=['withdraw','disarm','restore'].includes(op);
    check(op===next(state,reverse),'invalid journal order');
    if (op==='expose' && same(ack,{forbidden:true})) { state={...state,reverse:true}; continue; }
    state=transition(state,op,ack);
  }
  return state;
}
function checkedRoutes(rows,owned) {
  const expected=owned?[...neighbors,[owned,pattern,name]]:neighbors;
  check(rows.length===expected.length && expected.every(([id,p,script])=>rows.some(r=>r.id===id && r.pattern===p &&
    r.script===script && r.request_limit_fail_open===false)), 'unexpected zone route; never adopt, replace or widen');
}
export async function checkedTarget(read,s,serviceCodeHash) {
  const ids=(await read(`${target}/versions?per_page=100`)).map(v=>v.id).sort();
  check(same(ids,[...beforeIds,stageUPredecessor,candidate].sort()),'changed seven-version inventory');
  const {exact}=uploadReadbacks(read);
  await exact(baseline.version,baseline.module,[],'worker.js');
  await exact(stageUPredecessor,publicHash,['ADMIN_ID','BOT_TOKEN'],'worker.js',publicBindings());
  await checkReceiverVersion(read,serviceCodeHash);
  await noPreviews(read,original.workerId);
  check(same(await read(`${workers}/domains?service=${name}`),[]),'incident custom domain present');
  checkedRoutes(await read(routePath),s.route);
  const deployments=[...history];
  if(s.active) deployments.unshift({id:s.active,versions:split(candidate)});
  if(s.restored) deployments.unshift({id:s.restored,versions:split(baseline.version)});
  const d=await read(`${script}/deployments?per_page=100`);
  check(same(d.deployments.map(({id,versions})=>({id,versions})),deployments),'conflicting deployment history');
  const rows=(await read(`${script}/schedules`)).schedules;
  check(Array.isArray(rows) && same(rows.map(({cron,created_on,modified_on})=>({cron,created_on,modified_on})),s.cron?[s.cron]:[]),'cron was replaced or changed');
  check(same(await control(read),{deployment:deployments[0].id,version:deployments[0].versions[0].version_id,crons:s.cron?[schedule]:[]}), 'active controls changed');
}
// Public GETs do not send credentials, follow redirects, insert an incident, or trigger a DM.
export async function siteWitness(read,send) {
  const domains=await read(`${workers}/domains?service=${site}`);
  check(domains.length===1 && domains[0].hostname===host && domains[0].zone_id===zone && domains[0].service===site &&
    domains[0].environment==='production' && domains[0].enabled===true && immutable.test(domains[0].id),'production root domain changed');
  const sites=[];
  for(const [worker,path] of [[site,'/'],[preview,'/preview/']]) {
    const {deployments:[d]}=await read(`${workers}/scripts/${worker}/deployments?per_page=1`);
    check(versionId.test(d?.id) && d.versions?.length===1 && d.versions[0].percentage===100 && versionId.test(d.versions[0].version_id),'unbound Site/preview deployment');
    const r=await send(incidentOrigin+path,{method:'GET',redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(15000)});
    check(r.status===200 && r.headers.get('content-type')?.split(';')[0]==='text/html','Site/preview document unavailable');
    const hash=createHash('sha256'); let n=0;
    for await(const b of r.body) {n+=b.length;check(n<=1024*1024,'oversize Site document');hash.update(b);}
    check(n>0,'empty Site document');sites.push({worker,path,version:d.versions[0].version_id,deployment:d.id,html:hash.digest('hex')});
  }
  return {domain:domains[0].id,sites};
}
export async function probeIngress(send,open) {
  for (const [url,secure] of [[incidentUrl.replace(/^https:/,'http:'),false],[incidentUrl,true]]) {
    const r=await send(url,{method:'GET',redirect:'manual',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(15000)});
    try {
      if (!secure) check(r.status===404 || ([301,302,307,308].includes(r.status) && r.headers.get('location')===incidentUrl), 'HTTP ingress not denied or redirected to exact HTTPS URL');
      else if(open) check(r.status===405 && r.headers.get('cache-control')==='no-store','public GET denial not verified');
      else check(r.status===404,'closed incident URL not verified');
    } finally {await r.body?.cancel();}
  }
}
class RouteForbidden extends Error {}
async function json(token,send,path,method,body) {
  const res=await send(`https://api.cloudflare.com/client/v4${path}`,{method,redirect:'error',signal:AbortSignal.timeout(15000),
    headers:{authorization:`Bearer ${token}`,...(body!==undefined && {'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  if(res.status===403 && path===routePath && method==='POST') {
    const x=await res.json();
    if(x?.success===false && x.result===null && Array.isArray(x.errors) && x.errors.length>0 &&
      x.errors.every(e=>e.code===10000) && Array.isArray(x.messages)) throw new RouteForbidden('route permission refused');
  }
  check(res.ok,'provider write or read not acknowledged');
  const x=await res.json();check(x?.success===true && x.result!=null && ((x.errors===null && x.messages===null) || (same(x.errors,[]) && Array.isArray(x.messages))), 'ambiguous provider response');
  return x.result;
}
export function capabilities(editor,route,reader,send) {
  return {
    outbox:async()=>{
      const data=await json(reader,send,`${root}/d1/database/${db}/query`,'POST',{sql:successorSummary,params:Array(4).fill('1795448388')});
      const row=data?.[0];
      check(data.length===1 && row.success===true && row.meta?.served_by_primary===true && row.meta.changed_db===false && row.meta.rows_written===0 &&
        same(row.results,[{incidents:1,notifications:2,sealed:1,state:'sent',attempts:1}]),'historical outbox seal or successor sent/1 not proven');
    },
    write:(op,s)=>{
      switch(op){
        case 'deploy': case 'restore': return json(editor,send,`${script}/deployments`,'POST',{strategy:'percentage',versions:split(op==='deploy'?candidate:baseline.version)});
        case 'arm': case 'disarm': return json(editor,send,`${script}/schedules`,'PUT',op==='arm'?[{cron:schedule}]:[]);
        case 'expose': return json(route,send,routePath,'POST',{pattern,script:name});
        case 'withdraw': check(immutable.test(s.route) && !neighbors.some(([id])=>id===s.route),'invalid owned route'); return json(route,send,`${routePath}/${s.route}`,'DELETE');
        default: throw Error('outside mutation capability');
      }
    },
  };
}

// Retry only reads after an acknowledged write. No inventory observation can complete
// a missing ACK, and no callback that can submit a mutation belongs in this loop.
async function converge(read,pause) {
  for(const ms of [0,1000,3000,7000]) {
    if(ms) await pause(ms);
    try {return await read();} catch(e) {if(ms===7000)throw e;}
  }
}
export function terminalExit(receipt) {
  return receipt?.operation==='root-restore-rollback' && receipt.state==='ROLLBACK_ACTIVE' ||
    receipt?.operation==='root-abandon-bridge' && receipt.state==='BRIDGE_ABANDONED' && receipt.noSiteWrite===true &&
    receipt.deployment===receipt.fromDeployment && receipt.version===receipt.fromVersion;
}
export function rollbackWitness(original,now,receipt) {
  if(same(original,now))return;
  const [was,p]=original.sites,[live,previewNow]=now.sites;
  check(original.domain===now.domain && same(p,previewNow) && now.sites.length===2 &&
    same({...live,deployment:was.deployment,version:was.version},was) &&
    live.deployment!==was.deployment && live.version!==was.version &&
    terminalExit(receipt) &&
    receipt.deployment===live.deployment && receipt.version===live.version,
    'restore and prove protected Site rollback before incident rollback');
}

// A separate entry point: no write capability or intent/ACK methods. An unacknowledged
// operation stays unresolved even if the live state looks exactly as intended.
export async function reconcile({load,inspect,witness,ingress,restoreProof,restoredControl,pause=delay}) {
  const stored=load(),s=replay(stored.rows);
  return converge(async()=>{
    await inspect(s);const now=await witness();
    const proof=!same(stored.before,now) && restoreProof?await restoreProof(stored.pair):null;
    rollbackWitness(stored.before,now,proof);
    if(proof && s.route)await restoredControl(proof);
    await ingress(Boolean(s.route));check(same(load(),stored),'operation overtaken');
    return {phase:'read-only-reconciled',deployment:s.restored??s.active??history[0].id,
      version:s.active&&!s.restored?candidate:baseline.version,crons:s.cron?[schedule]:[],route:s.route,sites:now};
  },pause);
}

// A numbered, exclusive slot is the local compare-and-swap between concurrent forward/reverse processes.
// Every intent precedes its request; only complete acknowledgements can advance the state machine.
export async function operate(mode,{journal,head,authority,windowOpen,initialGraph,inspect,witness,ingress,outbox,write,
  pairProof,restoreProof,restoredControl,approveChange,pause=delay}) {
  const reverse=mode==='rollback';check(reverse || mode==='activate','invalid mode');
  await authority();
  let s=state0(), n=0, before, graph, receipt, scope;
  if(reverse) {
    const stored=journal.load(head);s=replay(stored.rows); n=stored.rows.length;
    check(next(s,true),'no outstanding acknowledged activation');
    const originalSite=stored.before;
    before=await witness();
    if(!same(originalSite,before) && restoreProof)receipt=await restoreProof(stored.pair);
    rollbackWitness(originalSite,before,receipt);
    scope=[stored.pair,before,stored.rows,receipt??null];
  } else {
    const pair=await pairProof();
    graph=await initialGraph();await inspect(s);before=await witness();
    check(before.sites[0].version===enrolled.priorSiteVersion,'Site already beyond enrolled pre-bridge version');
    await ingress(false);await outbox();
    windowOpen();
    scope=[pair,before,graph]; approveChange(scope);
    journal.begin(head,before,pair);
  }
  for (let op; (op=next(s,reverse));) {
    if(!reverse) {
      check(await initialGraph()===graph && same(await witness(),before),'unrelated graph or Site/preview changed');
      if(op==='arm')await outbox();
    }
    await authority();await inspect(s);
    if(reverse)check(same(await witness(),before),'Site/preview changed during rollback');
    if(op==='withdraw' && receipt)await restoredControl(receipt);
    windowOpen(); // last fallible admission check, BEFORE spending the durable intent
    approveChange(scope); // Explicit signed direction, still within its independent clock.
    journal.intent(n,op); let ack;
    try {ack=await write(op,s);} catch(e) {
      // A positive, specific authorization denial is not a lost ACK. Never retry it. Only this
      // case can release prior owned controls after an independent proof the route is still absent.
      if(op==='expose' && e instanceof RouteForbidden) journal.ack(n,op,{forbidden:true});
      throw e;
    }
    s=transition(s,op,ack);
    const proof=op==='arm'?{schedules:[s.cron]}:op==='disarm'?{schedules:[]}:{id:ack.id};
    journal.ack(n++,op,proof); // persist only checked ownership, never provider metadata
    await converge(()=>inspect(s),pause);
  }
  await converge(async()=>{
    if(reverse) await initialGraph();
    await ingress(!reverse);check(same(await witness(),before),'unaffected Site/preview not verified');
    await inspect(s);check(journal.load(head).rows.length===n,'operation overtaken');
  },pause);
  return {phase:reverse?'inert-restored':'exact-incident-active',version:reverse?baseline.version:candidate,deployment:s.restored??s.active,route:s.route,crons:s.cron?[schedule]:[],unaffected:before};
}
export const initialGraph = read=>privateGraph(read);
