import {isDeepStrictEqual as same} from 'node:util';
import {bindings, db, digest, graph, name, noPreviews, privateWorker, registry, requireThat as check, versionId, workers} from './incident-provider.mjs';
import {original} from './incident-recovery-id.mjs';

export const baseline = Object.freeze({version:'07805124-2b22-4311-84a5-261c13ee355b',deployment:'c1e6ba93-8f81-4a42-823f-b5b444adab00',partial:'73c7259d-8ed6-4386-9220-c673b0ede7ea',donor:'4b57a6dd-edf4-4465-9220-1da8a5aa9bcf',module:'a6858f2b05571c6e049d82e8409ac2dbb3d715944cefbdac8bf0b74c07ffcbb7',build:'d3fab41a90525df0c22b0a38541423d9bb23b8f33f7b47738811cea74bd3b701'});
export const target=`${registry}/${original.workerId}`, script=`${workers}/scripts/${name}`, schedule='*/5 * * * *';
const secrets=['ADMIN_ID','BOT_TOKEN'];
const byName=(a,b)=>a.name.localeCompare(b.name,'en');
export function exactVersion(v,id,hash,secretNames,main) {
  check(v.id===id && versionId.test(id) && v.main_module===main && v.compatibility_date==='2026-08-14' && same(v.compatibility_flags??[],[]) && v.usage_model==='standard' && same(v.urls??[],[]) && !['assets','containers','limits','placement','package_dependencies','exports','cache_options','migration_tag'].some(k=>v[k]!=null),'unexpected version runtime or preview');
  const m=v.modules;
  check(m?.length===1 && m[0].name===main && m[0].content_type==='application/javascript+module' && typeof m[0].content_base64==='string' && digest(Buffer.from(m[0].content_base64,'base64'))===hash,'module differs from approved bytes');
  const expected=[...bindings(baseline.build),...secretNames.map(name=>({type:'secret_text',name}))].sort(byName);
  const actual=v.bindings.map(b=>{if(b.type==='d1' && Object.hasOwn(b,'database_id')) {check(b.database_id===db,'database aliases differ');const {database_id,...rest}=b;return rest;}return b;}).sort(byName);
  check(same(actual,expected),'unexpected bindings (including secret names/types)');
}
export function uploadBody(module) {
  return {main_module:'private-canary.js',compatibility_date:'2026-08-14',compatibility_flags:[],bindings:[...bindings(baseline.build),...secrets.map(name=>({name,type:'inherit',version_id:baseline.donor}))],modules:[{name:'private-canary.js',content_type:'application/javascript+module',content_base64:module.toString('base64')}]};
}
async function privacy(read) {
  for(const key of [original.workerId,name]) {
    const w=await read(`${registry}/${key}`);privateWorker(w,original.workerId,original.tag,false,original.notBefore);
    check(w.created_on===original.createdOn && same(w.tail_consumers,[]),'changed immutable reservation');
  }
  const s=await read(`${script}/subdomain`);check(s.enabled===false && s.previews_enabled===false,'HTTP or previews enabled');
}
export async function control(read) {
  await privacy(read);
  const {deployments:[d]}=await read(`${script}/deployments?per_page=1`);
  check(versionId.test(d?.id) && d.versions?.length===1 && versionId.test(d.versions[0].version_id) && d.versions[0].percentage===100,'ambiguous active deployment');
  const schedules=await read(`${script}/schedules`);const rows=schedules.schedules??schedules;
  check(Array.isArray(rows)&&rows.every(x=>typeof x.cron==='string'),'invalid schedules');
  return {deployment:d.id,version:d.versions[0].version_id,crons:rows.map(x=>x.cron)};
}
const inert={deployment:baseline.deployment,version:baseline.version,crons:[]};
export async function executePrivate({read,create,deploy,schedules,authority,inventory,empty,outbox,observe,module,hash,end,receipt}) {
  const version=id=>read(`${target}/versions/${id}?include=modules`);
  const checked=async(id,h,names,main)=>exactVersion(await version(id),id,h,names,main);
  const lifetime=()=>check(Math.floor(Date.now()/1000)>=end-3600 && end-Date.now()/1000>=600,'outside approved window or insufficient remaining time');
  const expect=async(state)=>check(same(await control(read),state),'control changed; do not overwrite');
  const rows=await read(`${target}/versions?per_page=100`);
  check(same(rows.map(v=>v.id).sort(),[baseline.version,baseline.partial,baseline.donor].sort()),'not the unused installed inventory');
  await checked(baseline.version,baseline.module,[],'worker.js');await checked(baseline.donor,baseline.module,secrets,'worker.js');
  await expect(inert);const topology=await inventory();await empty();await authority();lifetime();
  check(module.length>0 && module.length<512*1024 && digest(module)===hash && hash!==baseline.module,'invalid canary bundle');
  const candidate=(await create(uploadBody(module))).id;
  check(versionId.test(candidate)&&!rows.some(x=>x.id===candidate),'ambiguous upload; no retry');
  await checked(candidate,hash,secrets,'private-canary.js');await empty();await authority();lifetime();await expect(inert);
  // One upload only. Even an ambiguous POST cannot be replayed on a new run: version inventory changed.
  let active,arming=false;
  try {
    active=(await deploy(candidate)).id;check(versionId.test(active),'ambiguous deployment; inspect read-only');
    receipt('deployment',{deployment:active,version:candidate});
    const off={deployment:active,version:candidate,crons:[]};await expect(off);
    await checked(candidate,hash,secrets,'private-canary.js');check(await inventory()===topology,'graph changed before scheduling');
    await empty();await authority();lifetime();await expect(off);
    arming=true;receipt('arm-intent');await schedules([schedule]);await expect({...off,crons:[schedule]});
    await observe(outbox,end,receipt);
  } finally {
    // If a deployment POST lost its acknowledgement we do not own a deployment ID.
    // No cron was armed in that case; never infer authority from the version alone.
    if(versionId.test(active)) await restorePrivate({read,deploy,schedules,receipt},active,candidate,arming,hash);
  }
}
export async function restorePrivate({read,deploy,schedules,receipt},active,candidate,arming,hash) {
  check(versionId.test(active) && versionId.test(candidate) && ![baseline.version,baseline.donor,baseline.partial].includes(candidate),'invalid restore journal');
  const checked=async(id,h,names,main)=>exactVersion(await read(`${target}/versions/${id}?include=modules`),id,h,names,main);
  await checked(candidate,hash,secrets,'private-canary.js');
  const current=await control(read);
  check(current.deployment===active && current.version===candidate && (same(current.crons,[]) || arming&&same(current.crons,[schedule])),'rollback withheld: different deployment/schedule');
  if(current.crons.length) await schedules([]);
  await checked(baseline.version,baseline.module,[],'worker.js');
  check(same(await control(read),{deployment:active,version:candidate,crons:[]}), 'changed before restoration');
  const restored=(await deploy(baseline.version)).id;check(versionId.test(restored),'ambiguous restoration; do not retry');
  check(same(await control(read),{deployment:restored,version:baseline.version,crons:[]}), 'restoration not verified');
  await checked(baseline.donor,baseline.module,secrets,'worker.js');receipt('inert-restored');
}
export async function privateGraph(reader) {const fingerprint=await graph(reader,original.workerId);await noPreviews(reader,original.workerId);return fingerprint;}
