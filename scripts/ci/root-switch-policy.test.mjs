// Non-production keys and IDs. These tests cannot emit a usable authorization or a live measurement.
import assert from 'node:assert/strict';
import test from 'node:test';
import {generateKeyPairSync,hash,sign} from 'node:crypto';
import {checkRehearsal,checkSwitchAuthority,siteScope} from './root-switch-policy.mjs';
import {observeRum} from './root-rum-policy.mjs';

const sha=s=>hash('sha256',s), key=()=>generateKeyPairSync('ed25519');
const seal=(data,key)=>{const statement=JSON.stringify(data);return JSON.stringify({statement,signature:sign(null,Buffer.from(statement),key.privateKey).toString('base64')});};
test('owner and advisory signatures are independently bound to exact source, scope, time and direction',()=>{
  const owner=key(),reviewer=key(),source='1'.repeat(40),operation='root-activate-forward',scope={pair:{packet:sha('p'),rehearsal:sha('b'),forward:sha('f'),rollback:sha('r')},run:'test-only'},now=1000000;
  const repository='just-goforward/Nikke-Collection-Item-Calculator';
  const report={kind:'independent-technical-review-v1',repository,source,pair:scope.pair,reviewedAt:now-2,reviewer:'fixture bot',method:'fixture review',diff:'exact test tree',controls:'pinned',failures:'case disposition',exposure:'bounded',rollback:'reverse bound',disposition:'closed',openBlockers:0,releaseAuthorization:false};
  const signedReview=seal(report,reviewer);
  const decision={kind:'single-owner-switch-v1',ownerId:281915448,repository,source,operation,decision:'APPROVE_THIS_OPERATION',reviewSha256:sha(signedReview),scopeSha256:sha(JSON.stringify(scope)),risks:'fixture only',otherGatesWaived:false,issuedAt:now-1,expiresAt:now+1};
  const x=k=>k.publicKey.export({format:'jwk'}).x;
  const env={ROOT_SWITCH_SIGNERS:JSON.stringify({owner:x(owner),review:x(reviewer)}),ROOT_TECHNICAL_REVIEW:signedReview,ROOT_OWNER_DECISION:seal(decision,owner)};
  const check=(e=env,s=source,o=operation,q=scope,t=now)=>checkSwitchAuthority(e,s,o,q,t);
  assert.equal(check().ownerDecisionSha256,sha(env.ROOT_OWNER_DECISION));
  for(const run of [()=>check(env,'2'.repeat(40)),()=>check(env,source,'root-restore-rollback'),()=>check(env,source,operation,[1]),()=>check(env,source,operation,scope,now+1),()=>check({...env,ROOT_OWNER_DECISION:seal(decision,reviewer)}),()=>check({...env,ROOT_SWITCH_SIGNERS:JSON.stringify({owner:x(owner),review:x(owner)})})])assert.throws(run);
  for(const patch of [{openBlockers:1},{releaseAuthorization:true},{method:''},{source:'2'.repeat(40)}]) {
    const r=seal({...report,...patch},reviewer);assert.throws(()=>check({...env,ROOT_TECHNICAL_REVIEW:r,ROOT_OWNER_DECISION:seal({...decision,reviewSha256:sha(r)},owner)}));
  }
  for(const patch of [{decision:'REVIEW_ONLY'},{issuedAt:now+1},{expiresAt:now+3600000},{otherGatesWaived:true},{reviewSha256:sha('stale')}])assert.throws(()=>check({...env,ROOT_OWNER_DECISION:seal({...decision,...patch},owner)}));
  const url='https://static.cloudflareinsights.com/beacon.min.js/v'+'b'.repeat(40),integrity='sha512-'+Buffer.alloc(64,1).toString('base64');
  const tag=`<script type="module" src="${url}" integrity="${integrity}" data-cf-beacon='{"version":"2026.11.1","token":"af412f42bf1145eea47507d378249625","r":1,"spa":2}' crossorigin="anonymous"></script>\n`;
  const restoreRum={url,integrity,version:'2026.11.1',tagSha256:sha(tag),configSha256:sha('config'),evidenceSha256:sha('independent raw/rendered capture and config'),observedAt:now-3};
  const restoreScope={...scope,restoreRum};
  const runRestore=(reviewProof,consumerProof,op='root-restore-rollback')=>{
    const r=seal({...report,restoreRum:reviewProof},reviewer),s={...restoreScope,restoreRum:consumerProof};
    return check({...env,ROOT_TECHNICAL_REVIEW:r,ROOT_OWNER_DECISION:seal({...decision,operation:op,reviewSha256:sha(r),scopeSha256:sha(JSON.stringify(s))},owner)},source,op,s);
  };
  runRestore(restoreRum,restoreRum);runRestore(restoreRum,restoreRum,'root-abandon-bridge');const late={...restoreRum,observedAt:now};assert.throws(()=>runRestore(late,late));assert.throws(()=>runRestore(undefined,restoreRum));
  assert.throws(()=>runRestore(restoreRum,{...restoreRum,configSha256:sha('other')}));assert.throws(()=>runRestore(restoreRum,restoreRum,'root-activate-forward'));
  const h={packetSha256:sha('packet'),directions:{forward:{manifestSha256:sha('f')},rollback:{manifestSha256:sha('r')}}};
  assert.throws(()=>siteScope({ROOT_SITE_TRANSITION:'{}'},{},h));
});

test('only a complete authenticated matching account/zone/site/rule inventory is admissible',async()=>{
  const account='15be33fd20ea78eb3d60b719be831148',zone='2ed78e90cd4834066e079282aea4acb2',host='nikkecollection.com';
  const s={site_tag:'1'.repeat(32),site_token:'af412f42bf1145eea47507d378249625',auto_install:true,ruleset:{id:'2'.repeat(32),zone_tag:zone,zone_name:host,enabled:true,lite:true},rules:[{id:'3'.repeat(32),host:'*',paths:['*'],priority:1000,inclusive:true,is_paused:false}]};
  const info={page:1,total_pages:1,count:1,total_count:1},z={id:zone,account:{id:account},name:host,status:'active'};
  const config={account,zone,host,site:s.site_tag,token:s.site_token,ruleset:s.ruleset.id,rule:s.rules[0].id,enabled:true,auto_install:true,lite:true,hostPattern:'*',paths:['*'],priority:1000,inclusive:true,is_paused:false};
  async function run(change=()=>{},status=200,pin=sha(JSON.stringify(config)),date=new Date()) {
    const data=structuredClone({zone:z,inventory:s,detail:s,rules:{rules:s.rules,ruleset:s.ruleset},info});change(data);
    return observeRum('fixture',pin,async(url,opts)=>{
      assert.equal(opts.method,'GET');assert.equal(opts.headers.authorization,'Bearer fixture');assert.equal(opts.redirect,'error');assert.equal(opts.cache,'no-store');
      const path=new URL(url).pathname, base='/client/v4/accounts/'+account+'/rum';let result;
      if(path==='/client/v4/zones/'+zone)result=data.zone;else if(path===base+'/site_info/list')result=[data.inventory];else if(path===base+'/site_info/'+s.site_tag)result=data.detail;else {assert.equal(path,base+'/v2/'+s.ruleset.id+'/rules');result=data.rules;}
      return Response.json({success:true,errors:[],result,result_info:data.info},{status,headers:{date:date.toUTCString()}});
    });
  }
  assert.deepEqual((await run()).config,config);
  for(const change of [d=>d.zone.account.id='wrong',d=>d.info.total_pages=2,d=>d.detail.auto_install=false,d=>delete d.detail.ruleset.lite,d=>d.detail.lite=false,d=>d.rules.ruleset.enabled=false,d=>d.rules.ruleset.zone_tag='other',d=>d.inventory.site_token='wrong',d=>d.rules.rules.push({...s.rules[0]}),d=>d.rules.rules[0].paths=['/en/*'],d=>d.rules.rules[0].is_paused=true,d=>d.rules.rules[0].inclusive=false,d=>d.rules.rules[0].priority=2,d=>d.rules.rules[0].override=true]) await assert.rejects(run(change));
  await assert.rejects(run(undefined,403));await assert.rejects(run(undefined,200,sha('stale')));
  await assert.rejects(run(undefined,200,sha(JSON.stringify(config)),new Date(0)),/stale authenticated/);
});
test('rehearsal binds both real direction traces, all new documents and old-tab lazy bytes',()=>{
  const pair={worker:'assets/browserWorker-FORWARD1.js',review:{nativeWasmSha256:sha('W')},files:{}},packet=sha('test packet'),source='1'.repeat(40);
  const proof={profile:'sealed-root-rehearsal-v2',publicTrafficSwitched:false,packetSha256:packet,source,startedAt:1,finishedAt:2,results:[]};
  for(const role of ['rollback','forward']) {
    const pins={}; for(const p of ['/','/en/','/ja/']) for(const d of ['index','privacy','terms','licenses']) pins[p+d+'.html']={sha256:sha((d==='index'?role:'legacy')+p+d)};
    const paths=role==='rollback'?['/assets/browserWorker-EkFyhckN.js','/wasm/certified_solver.88553a72d8503d2c7c78366e3d85bbee0cd9dfd738ac94d588fb09bd9d5942ae.wasm']:['/'+pair.worker,'/wasm/service-fused-h14-'+pair.review.nativeWasmSha256+'.wasm'];
    for(const path of paths)pins[path]={sha256:sha(path)};pair.files[role]=pins;
  }
  for(const [before,after] of [['rollback','forward'],['forward','rollback']]) {
    const docs=Object.entries(pair.files[after]).filter(([p])=>p.endsWith('.html'));
    const gets=[{active:before,switched:false,p:'/',sha256:pair.files[before]['/index.html'].sha256},...Object.entries(pair.files[before]).filter(([p])=>!p.endsWith('.html')).map(([p,v])=>({active:after,switched:true,p,sha256:v.sha256}))];
    const row=(role,tree,key)=>({role,tree,key,sha256:pair.files.rollback[key].sha256,method:'GET',path:'legacy-cdn-stylesheet-'+(key.split('/').length===3?key.split('/')[1]:'ko'),blocked:true,requestfailed:true});
    const blockedFonts=docs.filter(([k])=>after==='rollback'||!k.endsWith('/index.html')).map(([k])=>row('new',after,k));
    if(before==='rollback')blockedFonts.push(row('old',before,'/index.html'));
    proof.results.push({before,after,documents:Object.fromEntries(docs.map(([p,v])=>[p,v.sha256])),gets,blockedFonts});
  }
  checkRehearsal(proof,pair,packet,source,3);
  for(const mutate of [p=>p.results.pop(),p=>p.results.reverse(),p=>p.finishedAt=4,p=>p.publicTrafficSwitched=true,p=>p.source='old',p=>p.results[1].gets.pop(),p=>delete p.results[0].documents['/ja/terms.html'],p=>p.results[0].gets[1].active='rollback']) {const b=structuredClone(proof);mutate(b);assert.throws(()=>checkRehearsal(b,pair,packet,source,3));}
  for(const change of [r=>delete r.blockedFonts,r=>r.blockedFonts.pop(),r=>r.blockedFonts.push(r.blockedFonts[0]),r=>r.blockedFonts[0].requestfailed=false,r=>r.blockedFonts[0].sha256=sha('other'),r=>r.blockedFonts[0].role='old']){
    const b=structuredClone(proof);change(b.results[0]);assert.throws(()=>checkRehearsal(b,pair,packet,source,3));
  }
});
