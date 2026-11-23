import {serviceBuild, successorBuild} from './sealed-successor.ts';
// Render only. Write the resulting file beside worker.ts, outside version control.
const [phase, database_id, namespace_id, build, ...extra] = process.argv.slice(2);
// Exclusive account allocation: follows the production 419201–419203 bindings.
if (extra.length || !['inert','canary','public'].includes(phase) || database_id!=='9a516350-d7d8-4a77-9cce-45d669fd3502' || namespace_id!=='419204' || !/^[a-f0-9]{64}$/.test(build)) throw Error('require phase, pinned incident D1, reserved incident rate namespace 419204 and approved service code hash');
const end = process.env.INCIDENT_CANARY_END;
if (phase==='canary' && !/^[1-9][0-9]{9}$/.test(end ?? '')) throw Error('canary requires a reviewed UTC expiry (epoch seconds)');
if (phase==='canary' && build!==serviceBuild) throw Error('incorrect predecessor service build');
console.log(JSON.stringify({ name:'collection-kit-production-incidents', main:phase==='canary'?'private-canary.ts':'entry/worker.ts', compatibility_date:'2026-08-14', workers_dev:false, preview_urls:false, observability:{enabled:false},
  // The inert rollback artifact must still reproduce its installed module hash.
  // It has no cron or secrets. Every send-capable artifact uses manual redirects.
  define:{INCIDENT_OUTBOUND_REDIRECT:JSON.stringify(phase==='inert'?'error':'manual'),INCIDENT_ATTEMPT_LIMIT:phase==='canary'?'1':'4',...(phase==='canary' && {INCIDENT_CANARY_END:end})},
  routes:phase==='public'?[{pattern:'nikkecollection.com/api/recalculation-incident',zone_name:'nikkecollection.com'}]:[], triggers:{crons:phase==='inert'?[]:['*/5 * * * *']},
  vars:{PUBLIC_INGRESS:phase==='public'?'1':'0',INCIDENT_BUILD:phase==='canary'?successorBuild:build},secrets:{required:phase==='inert'?[]:['ADMIN_ID','BOT_TOKEN']},
  d1_databases:[{binding:'INCIDENT_DB',database_name:'collection-kit-production-incidents',database_id}],ratelimits:[{name:'INGRESS',namespace_id,simple:{limit:60,period:60}}]
},null,2));
