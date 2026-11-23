import { readBoundedJson } from '../shared/boundedHttp.ts';
import { incidentOrigin, incidentPath, reasons, stages } from '../shared/recalculationIncident.ts';

type Env = { INCIDENT_DB: D1Database; INGRESS: RateLimit; INCIDENT_BUILD: string; PUBLIC_INGRESS: string; ADMIN_ID: string; BOT_TOKEN: string };
type Row = { day:number; build:string; reason:string; stage:string; attempts:number };
const epoch = () => Math.floor(Date.now()/1000);
const reply = (status:number) => new Response(null,{status,headers:{'cache-control':'no-store'}});
const key = 'day=? AND build=? AND reason=? AND stage=?';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const snow = (x:unknown):x is string => typeof x==='string' && /^\d{17,20}$/.test(x);
async function ingest(req:Request,e:Env) {
  if(e.PUBLIC_INGRESS!=='1'||req.url!==incidentOrigin+incidentPath) return reply(404);
  if(req.method!=='POST') return reply(405);
  if(req.headers.get('origin')!==incidentOrigin || req.headers.get('sec-fetch-site')!=='same-origin') return reply(403);
  if(req.headers.get('content-type')!=='application/json') return reply(415);
  if(!(await e.INGRESS.limit({key:'recalculation-v1'})).success) return reply(429);
  const p=await readBoundedJson(req,384,'invalid').catch(()=>null) as Record<string,unknown>|null;
  if(!p||Object.keys(p).sort().join(',')!=='attempt,build,reason,stage,v'||p.v!==1||typeof p.attempt!=='string'||!uuid.test(p.attempt)||!reasons.some(x=>x===p.reason)||!stages.some(x=>x===p.stage)||!(/^[0-9a-f]{64}$/).test(e.INCIDENT_BUILD)||p.build!==e.INCIDENT_BUILD) return reply(400);
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(p.attempt)));
  const fingerprint=Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');
  const now=epoch(), start=now-now%86400;
  // Single SQLite statement serializes admission; trigger enqueues only for a new row.
  const result=await e.INCIDENT_DB.prepare('INSERT INTO incidents SELECT ?,?,?,?,? WHERE (SELECT count(*) FROM incidents WHERE seen>=?)<240 ON CONFLICT(fingerprint) DO NOTHING').bind(fingerprint,now,e.INCIDENT_BUILD,p.reason,p.stage,start).run();
  if(!result.meta.changes && !(await e.INCIDENT_DB.prepare('SELECT 1 FROM incidents WHERE fingerprint=?').bind(fingerprint).first())) return reply(429);
  return reply(202);
}
async function notify(e:Env,row:Row) {
  const identity=[row.day,row.build,row.reason,row.stage];
  const set=async(state:string,next=0)=>{await e.INCIDENT_DB.prepare(`UPDATE notifications SET state=?,next=? WHERE ${key} AND state='claimed'`).bind(state,next,...identity).run();};
  const retry=()=>set(row.attempts>=4?'blocked':'pending',epoch()+3600);
  // Only definite pre-send failures or explicit rate rejection may be retried. A lost
  // acknowledgement or isolate crash after claim never results in another automatic POST.
  let posted=false;
  try {
    if(!snow(e.ADMIN_ID)||!e.BOT_TOKEN || row.build!==e.INCIDENT_BUILD || !(row.reason==='canary'&&row.stage==='private'||reasons.some(x=>x===row.reason)&&stages.some(x=>x===row.stage))) return await set('blocked');
    const call=(path:string,body:object)=>fetch('https://discord.com/api/v10'+path,{method:'POST',redirect:'error',headers:{authorization:'Bot '+e.BOT_TOKEN,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
    const channel=await call('/users/@me/channels',{recipient_id:e.ADMIN_ID});
    if(!channel.ok) return await (channel.status===429||channel.status>=500?retry():set('blocked'));
    const dm=await readBoundedJson(channel,16384,'dm') as {type?:number;id?:string;recipients?:{id:string;bot?:boolean}[]};
    if(dm.type!==1||!snow(dm.id)||dm.recipients?.length!==1||dm.recipients[0]?.id!==e.ADMIN_ID||dm.recipients[0]?.bot) return await set('blocked');
    const nonce=`ri${row.day}-${row.build.slice(0,8)}-${[...reasons,'canary'].indexOf(row.reason)}${[...stages,'private'].indexOf(row.stage)}`;
    posted=true;
    const msg=await call(`/channels/${dm.id}/messages`,{content:`Calculator incident v1: ${row.reason} / ${row.stage}, UTC day ${new Date(row.day*86400000).toISOString().slice(0,10)}, build ${row.build}`,allowed_mentions:{parse:[]},nonce,enforce_nonce:true});
    if(msg.status===429) return await retry();
    if(!msg.ok) return await set(msg.status>=500?'uncertain':'blocked');
    const receipt=await readBoundedJson(msg,16384,'receipt') as {id?:string;channel_id?:string;nonce?:string};
    await set(snow(receipt.id)&&receipt.channel_id===dm.id&&receipt.nonce===nonce?'sent':'uncertain');
  } catch { if(posted) await set('uncertain'); else await retry(); }
}
export default {
  async fetch(req:Request,e:Env){try{return await ingest(req,e);}catch{return reply(503);}},
  async scheduled(_event:unknown,e:Env){
    const now=epoch(),db=e.INCIDENT_DB;
    await db.batch([db.prepare('DELETE FROM incidents WHERE seen<?').bind(now-30*86400),db.prepare('DELETE FROM notifications WHERE day<?').bind(Math.floor(now/86400)-30),db.prepare("UPDATE notifications SET state='uncertain' WHERE state='claimed' AND next<?").bind(now-600)]);
    const row=await db.prepare("UPDATE notifications SET state='claimed',attempts=attempts+1,next=? WHERE rowid=(SELECT rowid FROM notifications WHERE state='pending' AND next<=? ORDER BY day,rowid LIMIT 1) RETURNING day,build,reason,stage,attempts").bind(now,now).first<Row>();
    if(row) await notify(e,row);
  }
};
