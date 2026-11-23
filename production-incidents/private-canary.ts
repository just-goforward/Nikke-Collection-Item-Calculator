import {notify} from './worker.ts';
import {claimSuccessor, quarantineSuccessor, successorBuild} from './sealed-successor.ts';

declare const INCIDENT_CANARY_END: number; // UTC seconds, compiled into the owner-reviewed module
const cron = '*/5 * * * *';
type Env = Parameters<typeof notify>[0];

async function tick(event:{cron:string;scheduledTime:number}, env:Env, end:number, now=Math.floor(Date.now()/1000)) {
  const inWindow=(t:number)=>Number.isSafeInteger(t) && t>=end-3600 && t<end;
  if (!Number.isSafeInteger(end) || !inWindow(now) || !inWindow(Math.floor(event.scheduledTime/1000)) || event.cron!==cron || env.PUBLIC_INGRESS!=='0' || env.INCIDENT_BUILD!==successorBuild || !/^\d{17,20}$/.test(env.ADMIN_ID) || !env.BOT_TOKEN) return;
  const db=env.INCIDENT_DB;
  const won=await db.prepare(claimSuccessor).bind(end,end).first<Parameters<typeof notify>[1]>();
  if(won) await notify(env,won);
  else await db.prepare(quarantineSuccessor).bind(end,end).run();
}
// There is intentionally no fetch handler (including a test or operator URL).
export default {scheduled:(event:ScheduledController,env:Env)=>tick(event,env,INCIDENT_CANARY_END)};
