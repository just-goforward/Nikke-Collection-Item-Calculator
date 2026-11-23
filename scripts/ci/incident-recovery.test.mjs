import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {account,zone,db,name,root,registry,workers,digest,client,recoveryGraph,state,install,reserve} from './incident-provider.mjs';
import {original,recoveryMode} from './incident-recovery-id.mjs';
import {checkedProof,ownerClaim,recoveryIntent,intent,approved,approvalComment,owner,gate} from './incident-receipt.mjs';

const {workerId:id,tag,createdOn,notBefore} = original;
const subject = readFileSync(`production-incidents/absent-${original.run}-1.json`), old = JSON.parse(subject);
const {created,phase,...oldPins} = old, now = created + 86400000;
const module = Buffer.from('inert test module'), pins = {...oldPins,run:'45199999999',main:'3'.repeat(40),moduleHash:digest(module)};
const vid = '00000000-0000-4000-8000-000000000001', editorId = 'f'.repeat(32);
const missing = {success:false,result:null,errors:[{code:10007,message:'This Worker does not exist on your account.'}],messages:[]};
const classic = `${workers}/scripts/${name}`, details = `${registry}/${id}`, byName = `${registry}/${name}`;
const vv = `${details}/versions?per_page=100`, dd = `${classic}/deployments?per_page=100`, previews = `${details}/previews?per_page=1`, secrets = `${classic}/secrets`;
const ok = (result,result_info) => ({success:true,errors:[],messages:[],result,...(result_info && {result_info})});
const page = (per_page,count,total_count=count) => ({page:1,per_page,count,total_count});
const baseline = {id,name,tags:[tag],created_on:createdOn,updated_on:createdOn,deployed_on:null,subdomain:{enabled:false,previews_enabled:false},logpush:false,observability:{enabled:false},tail_consumers:[],references:{workers:[],domains:[],dispatch_namespace_outbounds:[],durable_objects:[],queues:[]}};
const makeReview = r => ({state:'approved',user:{id:owner},environments:[{id:7,name:gate}],comment:approvalComment(r)});

// Replay sanitized wire shapes, not a successful response substituted for the actual 404.
function fixture(change=()=>undefined) {
  let version; const calls=[];
  const reader=(role='graph')=>client('synthetic',async(url,opts)=>{
    const path = new URL(url).pathname.slice('/client/v4'.length)+new URL(url).search;
    calls.push([role,opts.method,path]);
    const w = {...baseline,...(version && {deployed_on:createdOn})};
    const others = Array.from({length:20},(_,i)=>({id:i.toString(16).padStart(32,'0'),name:`other-${i}`}));
    const rows = role === 'editor' ? [w] : [w,...others];
    let body, status=200;
    if (path === `${root}/tokens/verify`) body=ok({id:editorId,status:'active'});
    else if (path === `${registry}?per_page=100`) body=ok(rows,page(100,rows.length));
    else if (path === details || path === byName) body=ok(w);
    else if (path === `${root}/d1/database/${db}`) body=ok({name,uuid:db});
    else if (path === `${root}/pages/projects?per_page=1` || path === previews) body=ok([],page(1,0));
    else if (path === `/zones?account.id=${account}&per_page=50`) body=ok([{id:zone,account:{id:account}}],page(50,1));
    else if (path === `/zones/${zone}/workers/routes`) body=ok([]);
    else if (path === `${workers}/domains?service=${name}`) body=ok([],page(0,0));
    else if (path.endsWith('/deployments?per_page=1')) body=ok({deployments:[{id:vid,versions:[{version_id:vid,percentage:100}]}]},{...page(1,1,4),total_pages:4});
    else if (path.endsWith(`/versions/${vid}`)) body=ok({id:vid,bindings:[]});
    else if (path === `${classic}/subdomain`) body=ok(w.subdomain);
    else if (path === `${classic}/schedules`) body=ok({schedules:[]});
    else if (path === vv) body=ok(version?[version]:[],page(100,version?1:0));
    else if (path === dd) body=ok({deployments:version?[{versions:[{version_id:vid,percentage:100}]}]:[]},{...page(100,version?1:0),total_pages:version?1:0});
    else if (path === secrets) { if (version) body=ok([]); else {body=structuredClone(missing);status=404;} }
    else if (path === `${details}/versions?deploy=true` && opts.method === 'POST' && role === 'editor') {
      assert(!version); version={...JSON.parse(opts.body),id:vid}; body=ok(version);
    } else if (path === `${details}/versions/${vid}?include=modules`) body=ok(version);
    else assert.fail('unexpected capability');
    if (path.startsWith(registry) && opts.method === 'GET') Object.assign(body,{errors:null,messages:null});
    const altered=change(path,body,role) ?? {}; return Response.json(altered.body??body,{status:altered.status??status});
  },role === 'editor'?`${details}/versions?deploy=true`:null);
  return {reader,calls};
}

test('historical signed subject bytes and fresh signed-claim contract are separate',()=>{
  assert.equal(`incident-first-${digest(subject)}`,tag); assert.equal(created,notBefore);
  const v=recoveryIntent(pins,'a'.repeat(64),now), r=ownerClaim(pins,recoveryMode,v,id,editorId,now);
  assert.equal(r.notBefore,notBefore); assert.equal(r.proofDigest,digest(JSON.stringify(v)));
  const admit=(p,mode,proof,reviews=[makeReview(r)],clock=now)=>approved(p,mode,proof,reviews,7,clock);
  assert.deepEqual(admit(pins,recoveryMode,v),r);
  for(const bad of [old,intent(pins,now),{...v,created:now+1},{...v,original:{...original,workerId:editorId}},{...v,graphDigest:'x'},{...v,extra:true}]) assert.throws(()=>admit(pins,recoveryMode,bad));
  for(const k of Object.keys(pins)) assert.throws(()=>admit({...pins,[k]:'wrong'},recoveryMode,v));
  assert.throws(()=>admit(pins,recoveryMode,v,undefined,now+3600000)); assert.throws(()=>admit(pins,'allocate',v));
  for(const drift of [{workerId:editorId},{tag:'x'},{graphDigest:'b'.repeat(64)},{proofDigest:'b'.repeat(64)},{phase:'private-reserved'},{editorId:null}]) assert.throws(()=>admit(pins,recoveryMode,v,[makeReview({...r,...drift})]));
  assert.throws(()=>admit(pins,recoveryMode,{...v,graphDigest:'b'.repeat(64)}));
  assert.throws(()=>checkedProof(pins,'allocate',old,now));
  for(const change of [{attempt:2},{main:original.main},{run:original.run}]) assert.throws(()=>recoveryIntent({...pins,...change},v.graphDigest,now));
});

test('fresh read-only preflight and independent gated install; never adopt on allocation',async()=>{
  const t=fixture(), graphDigest=await recoveryGraph(t.reader());
  assert.match(graphDigest,/^[a-f0-9]{64}$/);assert(t.calls.every(([,method])=>method==='GET'));
  assert(t.calls.some(([,m,p])=>m==='GET'&&p===secrets));
  await assert.rejects(reserve(t.reader(),tag,created,()=>assert.fail('spent')),/already exists/);
  const proof=recoveryIntent(pins,graphDigest,now), receipt=ownerClaim(pins,recoveryMode,proof,id,editorId,now);
  const recheck=clock=>approved(pins,recoveryMode,proof,[makeReview(receipt)],7,clock);
  await assert.rejects(install(t.reader('editor'),receipt,module,()=>recheck(now+3600000)),/expired/);
  assert(t.calls.every(([,m])=>m==='GET')); assert.equal(await install(t.reader('editor'),receipt,module,()=>recheck(now)),vid);
  assert.deepEqual(t.calls.filter(([,m])=>m!=='GET'),[['editor','POST',`${details}/versions?deploy=true`]]);
});

test('classic missing-script discriminator cannot certify a different identity, nonempty or incomplete graph',async()=>{
  const run=(path,alter)=>recoveryGraph(fixture((p,b)=>p===path?alter(b):undefined).reader());
  for(const path of [details,byName]) for(const d of [{id:editorId},{name:'wrong'},{tags:['wrong']},{created_on:'wrong'},{updated_on:'wrong'},{deployed_on:createdOn},{subdomain:{enabled:true,previews_enabled:false}},{references:{queues:[{}]}}])
    await assert.rejects(run(path,b=>({body:{...b,result:{...b.result,...d}}})));
  for(const path of [vv,dd,previews]) {
    await assert.rejects(run(path,()=>({status:404,body:missing})));
    for(const drift of [{count:1},{total_count:1},{page:2},{cursor:'next'}]) await assert.rejects(run(path,b=>({body:{...b,result_info:{...b.result_info,...drift}}})));
    await assert.rejects(run(path,b=>({body:{...b,result:path===dd?{deployments:[{}]}:[{}],result_info:page(b.result_info.per_page,1)}})));
  }
  for(const status of [401,403,409,429,500]) await assert.rejects(run(secrets,()=>({status,body:missing})));
  for(const drift of [{success:true},{result:[]},{errors:[{code:10007}]},{errors:[...missing.errors,...missing.errors]},{errors:[{...missing.errors[0],code:10222}]},{messages:[{}]},{extra:true}]) await assert.rejects(run(secrets,()=>({body:{...missing,...drift}})));
  for(const r of [[{name:'EXTRA'}],null,{}]) await assert.rejects(run(secrets,()=>({status:200,body:ok(r)})));
  for(const p of [secrets,dd,`${classic}/schedules`,`${classic}/subdomain`]) await assert.rejects(run(p,b=>({status:200,body:{...(p===secrets?ok([]):b),errors:null,messages:null}})));
  await assert.rejects(run(details,b=>{delete b.result.tail_consumers;}));
  await run(secrets,()=>({status:200,body:ok([])}));
  const t=fixture((p,b)=>p===byName||p===details?{body:{...b,result:{...b.result,tags:['another']}}}:undefined);
  await assert.rejects(state(t.reader(),id,'another',true,created),/classic script/);
  const deployed=fixture((p,b)=>p===secrets?{status:404,body:missing}:p===byName||p===details?{body:{...b,result:{...b.result,deployed_on:createdOn}}}:p===vv?{body:ok([{id:vid}],page(100,1))}:p===dd?{body:ok({deployments:[{}]},page(100,1))}:undefined);
  await assert.rejects(state(deployed.reader(),id,tag,false,created),/classic script/);
});

test('different unrelated deployment changes fingerprint, API ordering does not',async()=>{
  const hash=change=>recoveryGraph(fixture(change).reader());const expected=await hash();
  assert.equal(await hash((p,b)=>{if(p===`${registry}?per_page=100`)b.result.reverse();}),expected);
  assert.notEqual(await hash((p,b)=>{if(p.includes('/other-3/deployments'))b.result.deployments[0].id='00000000-0000-4000-8000-000000000002';}),expected);
});
