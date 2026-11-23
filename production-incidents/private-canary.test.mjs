import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import canary from './private-canary.ts';
import {oldEvidence,seedSeal,seen} from './canary-fixture.mjs';
import {claimSuccessor,serviceBuild,successorBuild,successorSummary} from './sealed-successor.ts';
globalThis.INCIDENT_ATTEMPT_LIMIT=1;
globalThis.INCIDENT_OUTBOUND_REDIRECT='manual'; // compiled by config.mjs in the workerd test

const refusals=['expired','early','invalid-secret','wrong-binding','empty','foreign-row','foreign-notification','wrong-fingerprint','wrong-seen','wrong-day','wrong-build','unsealed','direct-block','wrong-attempts','wrong-state'];
for(const scenario of ['sent','ambiguous','crashed-after-claim','rate-limited',...refusals]) test(scenario,async t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(readFileSync(new URL('schema.sql',import.meta.url),'utf8'));
  // Same UTC day as the old row regardless of when CI runs. Test both clocks.
  let now=seen+1200;
  db.function('unixepoch',()=>BigInt(now));
  t.mock.method(Date,'now',()=>now*1000);
  if(scenario!=='empty')db.exec(seedSeal);
  const drift={
    'foreign-row':"INSERT INTO incidents VALUES('other',unixepoch(),'other','worker','manual')",
    'foreign-notification':"INSERT INTO notifications(day,build,reason,stage) VALUES(0,'foreign','worker','manual')",
    'wrong-fingerprint':"UPDATE incidents SET fingerprint='impostor'",
    'wrong-seen':'UPDATE incidents SET seen=seen-86400','wrong-day':'UPDATE notifications SET day=day+1',
    'wrong-build':"UPDATE incidents SET build='other';UPDATE notifications SET build='other'",
    'unsealed':'UPDATE notifications SET next=next-1','direct-block':'UPDATE notifications SET next=0',
    'wrong-attempts':'UPDATE notifications SET attempts=2','wrong-state':"UPDATE notifications SET state='uncertain'",
  };
  if(drift[scenario])db.exec(drift[scenario]);
  const original=db.prepare('SELECT * FROM notifications ORDER BY rowid').all();
  const evidence=db.prepare(oldEvidence).all();
  let sends=0,calls=0;
  const prepare=(sql,args=[])=>{const stmt=db.prepare(sql);return {bind:(...a)=>prepare(sql,a),run:()=>stmt.run(...args),first:()=>{const r=stmt.get(...args);if(r && scenario==='crashed-after-claim' && sql===claimSuccessor)throw Error('halt after committed claim');return r??null;}};};
  const e={PUBLIC_INGRESS:'0',INCIDENT_BUILD:scenario==='wrong-binding'?serviceBuild:successorBuild,ADMIN_ID:'1'.repeat(18),BOT_TOKEN:scenario==='invalid-secret'?'':'unit',INCIDENT_DB:{prepare}};
  globalThis.INCIDENT_CANARY_END=now+(scenario==='expired'?-1:scenario==='early'?7200:1200);t.after(()=>delete globalThis.INCIDENT_CANARY_END);
  t.mock.method(globalThis,'fetch',async(url,init)=>{calls++;const channel='2'.repeat(18);if(url.endsWith('/users/@me/channels'))return Response.json({type:1,id:channel,recipients:[{id:e.ADMIN_ID}]});sends++;
    if(scenario==='ambiguous')throw Error('lost message acknowledgement');if(scenario==='rate-limited')return new Response(null,{status:429});return Response.json({id:'3'.repeat(18),nonce:JSON.parse(init.body).nonce,channel_id:channel});});
  const run=()=>canary.scheduled({cron:'*/5 * * * *',scheduledTime:now*1000},e);
  const parallel=await Promise.allSettled([run(),run()]);
  if(scenario==='crashed-after-claim') {assert.equal(parallel.filter(r=>r.status==='rejected').length,1);assert.equal(db.prepare('SELECT state FROM notifications WHERE build=?').get(successorBuild).state,'claimed');now+=601;}
  else assert(parallel.every(r=>r.status==='fulfilled'));
  await run();await run();
  assert.equal(canary.fetch,undefined);
  assert.deepEqual(db.prepare(oldEvidence).all(),evidence);
  const row=db.prepare('SELECT day,state,attempts FROM notifications WHERE build=?').get(successorBuild);
  if(refusals.includes(scenario)){assert.equal(row,undefined);assert.deepEqual(db.prepare('SELECT * FROM notifications ORDER BY rowid').all(),original);assert.equal(calls,0);}
  else {
    assert.equal(row.day,evidence[0].day);assert.equal(row.attempts,1);assert.equal(row.state,({sent:'sent',ambiguous:'uncertain','rate-limited':'blocked','crashed-after-claim':'uncertain'})[scenario]);assert.equal(sends,scenario==='crashed-after-claim'?0:1);
    assert.deepEqual({...db.prepare(successorSummary).get(...Array(4).fill(String(globalThis.INCIDENT_CANARY_END)))},{incidents:1,notifications:2,sealed:1,state:row.state,attempts:1});
    // Changing the window/key's day is NOT a replay path.
    now+=86400;globalThis.INCIDENT_CANARY_END=now+1200;await run();assert.equal(db.prepare('SELECT count(*) AS n FROM notifications').get().n,2);
  }
});
