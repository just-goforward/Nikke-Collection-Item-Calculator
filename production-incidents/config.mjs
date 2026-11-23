// Render only. Write the resulting file beside worker.ts, outside version control.
const [phase, database_id, namespace_id, build, ...extra] = process.argv.slice(2);
// Exclusive account allocation: follows the production 419201–419203 bindings.
if (extra.length || !['inert','canary','public'].includes(phase) || database_id!=='9a516350-d7d8-4a77-9cce-45d669fd3502' || namespace_id!=='419204' || !/^[a-f0-9]{64}$/.test(build)) throw Error('require phase, pinned incident D1, reserved incident rate namespace 419204 and approved service code hash');
console.log(JSON.stringify({ name:'collection-kit-production-incidents', main:'worker.ts', compatibility_date:'2026-08-14', workers_dev:false, preview_urls:false, observability:{enabled:false},
  routes:phase==='public'?[{pattern:'nikkecollection.com/api/recalculation-incident',zone_name:'nikkecollection.com'}]:[], triggers:{crons:phase==='inert'?[]:['*/5 * * * *']},
  vars:{PUBLIC_INGRESS:phase==='public'?'1':'0',INCIDENT_BUILD:build},secrets:{required:phase==='inert'?[]:['ADMIN_ID','BOT_TOKEN']},
  d1_databases:[{binding:'INCIDENT_DB',database_name:'collection-kit-production-incidents',database_id}],ratelimits:[{name:'INGRESS',namespace_id,simple:{limit:60,period:60}}]
},null,2));
