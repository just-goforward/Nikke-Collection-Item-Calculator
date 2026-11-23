import sender from './worker.ts';

declare const INCIDENT_CANARY_END: number; // UTC seconds, compiled into the owner-reviewed module
const cron = '*/5 * * * *';
type Env = Parameters<typeof sender.scheduled>[1];
const identity = "build=? AND reason='canary' AND stage='private'";

async function tick(event:{cron:string;scheduledTime:number}, env:Env, end:number, now=Math.floor(Date.now()/1000)) {
  const inWindow=(t:number)=>Number.isSafeInteger(t) && t>=end-3600 && t<end;
  if (!Number.isSafeInteger(end) || !inWindow(now) || !inWindow(Math.floor(event.scheduledTime/1000)) || event.cron!==cron || env.PUBLIC_INGRESS!=='0' || !/^[a-f0-9]{64}$/.test(env.INCIDENT_BUILD) || !/^\d{17,20}$/.test(env.ADMIN_ID) || !env.BOT_TOKEN) return;
  const db=env.INCIDENT_DB;
  // Only the isolate whose INSERT actually won may enter the existing sender. Never
  // drain/requeue an older outbox, including definite pre-send failures from that sender.
  const won=await db.prepare(`INSERT INTO incidents SELECT 'operator-private-canary',unixepoch(),?,'canary','private' WHERE NOT EXISTS(SELECT 1 FROM incidents) AND NOT EXISTS(SELECT 1 FROM notifications) ON CONFLICT DO NOTHING RETURNING fingerprint`).bind(env.INCIDENT_BUILD).first();
  if(won?.fingerprint==='operator-private-canary') {
    await sender.scheduled(event,env);
    await db.prepare(`UPDATE notifications SET state='blocked' WHERE ${identity} AND state='pending' AND attempts=1`).bind(env.INCIDENT_BUILD).run();
  } else {
    await db.prepare(`UPDATE notifications SET state='uncertain' WHERE ${identity} AND state='claimed' AND next<unixepoch()-600`).bind(env.INCIDENT_BUILD).run();
  }
}
// There is intentionally no fetch handler (including a test or operator URL).
export default {scheduled:(event:ScheduledController,env:Env)=>tick(event,env,INCIDENT_CANARY_END)};
