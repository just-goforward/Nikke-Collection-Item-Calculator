import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from './worker.ts';
globalThis.INCIDENT_OUTBOUND_REDIRECT='manual'; // public sender build definition
globalThis.INCIDENT_ATTEMPT_LIMIT=4;
const origin='https://nikkecollection.com';
function fixture(){
  const db=new DatabaseSync(':memory:'); db.exec(readFileSync(new URL('schema.sql',import.meta.url),'utf8'));
  function prepare(sql,args=[]){const s=db.prepare(sql);return {bind:(...a)=>prepare(sql,a),run:()=>({meta:s.run(...args)}),first:()=>s.get(...args)??null};}
  const e={PUBLIC_INGRESS:'1',INCIDENT_BUILD:'a'.repeat(64),ADMIN_ID:'1'.repeat(18),BOT_TOKEN:'unit-only',INGRESS:{limit:async()=>({success:true})},INCIDENT_DB:{prepare,batch:arr=>arr.map(x=>x.run())}};
  const report={v:1,reason:'capacity',stage:'outcome',build:e.INCIDENT_BUILD,attempt:crypto.randomUUID()};
  const post=(p=report,headers={})=>worker.fetch(new Request(origin+'/api/recalculation-incident',{method:'POST',headers:{origin,'sec-fetch-site':'same-origin','content-type':'application/json',...headers},body:JSON.stringify(p)}),e);
  return {db,e,report,post};
}
test('strict admission, atomic idempotency, database quota and retention',async()=>{
  const {db,e,post,report}=fixture();
  for(const p of [{...report,extra:'x'},{...report,attempt:'raw'},{...report,reason:'canary'},{...report,build:'b'.repeat(64)},{...report,reason:'x'.repeat(512)}]) assert.equal((await post(p)).status,400);
  assert.equal((await post(report,{origin:'https://outside.invalid'})).status,403);
  e.PUBLIC_INGRESS='0';assert.equal((await post()).status,404);e.PUBLIC_INGRESS='1';
  assert.equal((await post()).status,202);assert.equal((await post()).status,202);
  assert.notEqual(db.prepare('select fingerprint from incidents').get().fingerprint,report.attempt);
  for(let i=1;i<240;i++)assert.equal((await post({...report,attempt:crypto.randomUUID()})).status,202);
  assert.equal((await post({...report,attempt:crypto.randomUUID()})).status,429);
  assert.equal(db.prepare('select count(*) n from notifications').get().n,1);
  db.exec('update incidents set seen=0;update notifications set day=0');await worker.scheduled(null,e);
  assert.equal(db.prepare('select count(*) n from incidents').get().n,0);assert.equal(db.prepare('select count(*) n from notifications').get().n,0);
});
for(const scenario of ['verified','wrong recipient','guild','ambiguous','explicit 429'])test(scenario,async t=>{
  const {db,e,post}=fixture();await post();let sends=0;const channel='2'.repeat(18);
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    if(url.endsWith('/users/@me/channels'))return Response.json({type:scenario==='guild'?0:1,id:channel,recipients:[{id:scenario==='wrong recipient'?'3'.repeat(18):e.ADMIN_ID}]});
    assert.equal(url,'https://discord.com/api/v10/channels/'+channel+'/messages');sends++;const p=JSON.parse(init.body);assert.deepEqual(p.allowed_mentions,{parse:[]});assert.equal(p.enforce_nonce,true);
    if(scenario==='ambiguous')throw Error('lost acknowledgement');if(scenario==='explicit 429')return new Response(null,{status:429});
    return Response.json({id:'4'.repeat(18),channel_id:channel,nonce:p.nonce});
  });
  await Promise.all([worker.scheduled(null,e),worker.scheduled(null,e)]);await worker.scheduled(null,e);
  const state=db.prepare('select state from notifications').get().state;
  assert.equal(state,({verified:'sent','wrong recipient':'blocked',guild:'blocked',ambiguous:'uncertain','explicit 429':'pending'})[scenario]);assert.equal(sends,state==='blocked'?0:1);
});
