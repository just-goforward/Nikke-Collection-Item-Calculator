import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import canary from './private-canary.ts';

for(const scenario of ['sent','ambiguous','crashed-after-claim','rate-limited','expired','early','invalid-secret','foreign-row']) test(scenario,async t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(readFileSync(new URL('schema.sql',import.meta.url),'utf8'));
  let sends=0;
  const prepare=(sql,args=[])=>{const stmt=db.prepare(sql);return {bind:(...a)=>prepare(sql,a),run:()=>({meta:stmt.run(...args)}),first:()=>{const r=stmt.get(...args);if(scenario==='crashed-after-claim' && sql.startsWith('UPDATE notifications SET state=\'claimed\''))throw Error('halt after committed claim');return r??null;}};};
  const e={PUBLIC_INGRESS:'0',INCIDENT_BUILD:'a'.repeat(64),ADMIN_ID:'1'.repeat(18),BOT_TOKEN:scenario==='invalid-secret'?'':'unit',INCIDENT_DB:{prepare,batch:stmts=>stmts.map(s=>s.run())}};
  const now=Date.now();globalThis.INCIDENT_CANARY_END=Math.floor(now/1000)+(scenario==='expired'?-1:scenario==='early'?7200:300);t.after(()=>delete globalThis.INCIDENT_CANARY_END);
  if(scenario==='foreign-row')db.exec("INSERT INTO incidents VALUES('other',unixepoch(),'other','worker','manual')");
  t.mock.method(globalThis,'fetch',async(url,init)=>{const channel='2'.repeat(18);if(url.endsWith('/users/@me/channels'))return Response.json({type:1,id:channel,recipients:[{id:e.ADMIN_ID}]});sends++;
    if(scenario==='ambiguous')throw Error('lost message acknowledgement');if(scenario==='rate-limited')return new Response(null,{status:429});return Response.json({id:'3'.repeat(18),nonce:JSON.parse(init.body).nonce,channel_id:channel});});
  const run=()=>canary.scheduled({cron:'*/5 * * * *',scheduledTime:now},e);
  const parallel=await Promise.allSettled([run(),run()]);
  if(scenario==='crashed-after-claim') {assert.equal(parallel.filter(r=>r.status==='rejected').length,1);assert.equal(db.prepare('SELECT state FROM notifications').get().state,'claimed');db.exec('UPDATE notifications SET next=unixepoch()-601');}
  else assert(parallel.every(r=>r.status==='fulfilled'));
  await run();await run();
  assert.equal(canary.fetch,undefined);
  const row=db.prepare("SELECT state,attempts FROM notifications WHERE reason='canary'").get();
  if(['expired','early','invalid-secret','foreign-row'].includes(scenario)){assert.equal(row,undefined);assert.equal(db.prepare("SELECT count(*) n FROM incidents WHERE fingerprint='operator-private-canary'").get().n,0);assert.equal(sends,0);}
  else {assert.equal(row.attempts,1);assert.equal(row.state,({sent:'sent',ambiguous:'uncertain','rate-limited':'blocked','crashed-after-claim':'uncertain'})[scenario]);assert.equal(sends,scenario==='crashed-after-claim'?0:1);}
});
