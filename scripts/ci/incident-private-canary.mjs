import {execFileSync} from 'node:child_process';
import {appendFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {isDeepStrictEqual as same} from 'node:util';
import {activeTokenId,client,db,digest,immutable,requireThat as check,root} from './incident-provider.mjs';
import {api,certifiedRun,gate,gh,graphEnv,localMain,numeric,owner,protectedEnv,ref,repo} from './incident-receipt.mjs';
import {original} from './incident-recovery-id.mjs';
import {policy} from './incident-owner.mjs';
import {executePrivate,privateGraph,restorePrivate,script,target} from './incident-canary-control.mjs';
import {predecessorRun, successorBuild, successorSummary} from '../../production-incidents/sealed-successor.ts';

const workflow='.github/workflows/incident-private-canary.yml', schemaHash='b7caa79093856b09aaaa7440153c8049211a4731026e9b1dfd1743524693d6fa';
const catalog="SELECT type,name,sql FROM sqlite_master WHERE name!='_cf_KV' ORDER BY name";
// The owner's protected approval must confirm nonreceipt AND specifically authorize one new DM.
function permit(run,sha,mode) {
  check(BigInt(run)>BigInt(predecessorRun),'old canary runs are permanently spent');
  const a=api(`actions/runs/${run}`),branch=api('branches/main');
  check(a.id.toString()===run && a.repository.id===1229775730 && a.head_repository.full_name===repo && a.path===workflow && a.actor.id===owner && a.triggering_actor.id===owner && a.event==='workflow_dispatch' && a.head_branch==='main' && a.head_sha===sha && a.run_attempt===1 && a.conclusion==='success','no completed protected canary permit');
  if(mode==='execute') {
    check(branch.protected && branch.commit.sha===sha,'protected main moved');
    const src=api(`actions/workflows/site-source-verify.yml/runs?branch=main&event=push&head_sha=${sha}&per_page=30`).workflow_runs.find(r=>r.conclusion==='success' && r.head_sha===sha && r.event==='push' && r.head_repository.full_name===repo);
    check(src,'no successful protected source verification');
    const jobs=api(`actions/runs/${src.id}/attempts/${src.run_attempt}/jobs?per_page=100`).jobs;
    check(jobs.some(j=>j.conclusion==='success' && j.steps.some(s=>s.name==='Check private canary one-shot delivery and fail-closed activation' && s.conclusion==='success')),'protected source did not run the canary checks');
  }
  const envId=protectedEnv(gate), reviews=api(`actions/runs/${run}/approvals`);
  check(reviews.length===1 && reviews[0].state==='approved' && reviews[0].user.id===owner && reviews[0].environments.length===1 && reviews[0].environments[0].id===envId && reviews[0].environments[0].name===gate,'missing unique owner approval');
  check(reviews[0].comment===`nonreceipt:${predecessorRun}; authorize-one-new-dm:${run}:${sha}`,'fresh explicit owner authorization for this successor is required');
}
// Never return HTTP bodies/errors from a failing request; Discord is not contacted by this process.
async function post(token,path,method,body) {
  const response=await fetch(`https://api.cloudflare.com/client/v4${path}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},redirect:'error',signal:AbortSignal.timeout(15000),body:JSON.stringify(body)}).catch(()=>null);
  check(response?.ok,'provider request refused or ambiguous; never replay');
  const x=await response.json().catch(()=>null);check(x?.success===true && x.result!=null && (x.errors===null||same(x.errors,[])),'ambiguous provider acknowledgement; never replay');return x.result;
}
async function main([mode,run,...extra]) {
  check(['execute','restore'].includes(mode) && numeric.test(run) && !extra.length && !process.stdin.isTTY && !process.env.CI && !process.env.GITHUB_ACTIONS,'local owner, private FDs and exact run required');
  check(JSON.parse(gh('api','user')).id===owner,'sole authenticated owner required');
  check(!execFileSync('git',['status','--porcelain','--untracked-files=normal'],{encoding:'utf8'}).trim(),'clean reviewed checkout required');
  const sha=localMain(),dir=join(homedir(),'.incident-private-canary',run),journal=join(dir,'journal.jsonl'),tmp=mkdtempSync(join(tmpdir(),'private-canary-'));
  try {
    permit(run,sha,mode);
    gh('run','download',run,'--repo',repo,'--name',`private-canary-permit-${run}-1`,'--dir',tmp);
    const file=join(tmp,'permit.json');certifiedRun(JSON.parse(gh('attestation','verify',file,'--repo',repo,'--signer-workflow',`${repo}/${workflow}`,'--signer-digest',sha,'--source-digest',sha,'--source-ref',ref,'--deny-self-hosted-runners','--format','json')),run);
    const p=JSON.parse(readFileSync(file)),module=readFileSync(join(tmp,'private-canary.js')),hash=digest(module);
    check(same(p,{phase:'sealed-successor-one-dm',predecessor:predecessorRun,slot:successorBuild,sha,run,attempt:1,module:hash,end:p.end}) && Number.isSafeInteger(p.end),'permit does not bind the predecessor, slot, bytes and new run');
    const input=fd=>{try{return readFileSync(fd,'utf8').trim();}catch{throw Error('private descriptor unavailable');}};
    const token=input(0),read=client(token),management=client(input(3)),graphToken=input(4),reader=client(graphToken);
    const groups=await management(`${root}/tokens/permission_groups`),roles=new Map(groups.map(g=>[g.id,g.name]));check(roles.size===groups.length,'ambiguous permission groups');
    const editorId=await activeTokenId(read),editor=await management(`${root}/tokens/${editorId}`);
    policy(editor,editorId,roles,original.workerId);
    const issued=Date.parse(editor.issued_on),expires=Date.parse(editor.expires_on),now=Date.now();
    check(issued<=now && expires>now && expires-issued<=86400000 && (mode==='restore' || expires>=p.end*1000+600000),'a fresh Editor (at most 24h) covering the window and rollback is required');
    const old=api('actions/runs/45171435589/approvals').filter(r=>r.user.id===owner && r.state==='approved' && r.comment?.startsWith('incident-private-v1:'));
    check(old.length===1,'cannot identify retired installation Editor');const retired=JSON.parse(old[0].comment.slice('incident-private-v1:'.length));
    check(retired.workerId===original.workerId && immutable.test(retired.editorId) && editorId!==retired.editorId,'retired installer credentials forbidden');
    const readerId=await activeTokenId(reader);
    check(readerId===gh('variable','get','INCIDENT_GRAPH_TOKEN_ID','--env',graphEnv,'--repo',repo),'wrong registered graph reader');
    policy(await management(`${root}/tokens/${readerId}`),readerId,roles);
    const query=async(sql,params=[])=>{
      check(sql===catalog||sql===successorSummary,'only two fixed SELECTs permitted');
      const a=await post(graphToken,`${root}/d1/database/${db}/query`,'POST',{sql,params});
      check(a.length===1 && a[0].success===true && Array.isArray(a[0].results) && a[0].meta?.changed_db===false && a[0].meta.rows_written===0 && a[0].meta.served_by_primary===true,'ambiguous D1 primary read');return a[0].results;
    };
    const outbox=async()=>{
      const data=await query(successorSummary,Array(4).fill(String(p.end))),s=data[0];
      check(data.length===1 && s.incidents===1 && s.sealed===1 &&
        (s.notifications===1 && s.state===null && s.attempts===null ||
         s.notifications===2 && ['claimed','sent','blocked','uncertain'].includes(s.state) && s.attempts===1),'unexpected outbox or missing historical seal; stop');
      return s;
    };
    const schema=readFileSync('production-incidents/schema.sql');check(digest(schema)===schemaHash,'schema pin changed');
    const sqlite=new DatabaseSync(':memory:');sqlite.exec(schema.toString());const expected=sqlite.prepare(catalog).all().map(r=>({...r}));sqlite.close();
    const requireSeal=async()=>{check(same(await query(catalog),expected) && (await outbox()).notifications===1,'not the reviewed schema and its sole sealed predecessor');};
    const receipt=(phase,detail={})=>{const row={utc:new Date().toISOString(),phase,hash,...detail};appendFileSync(journal,JSON.stringify(row)+'\n',{mode:0o600,flush:true});console.log(JSON.stringify({utc:row.utc,phase,hash,...(detail.state && {state:detail.state,attempts:detail.attempts})}));};
    const observe=async(readState,end,record)=>{const limit=Math.min(end*1000,Date.now()+17*60000);let previous='';do {const s=await readState();if(s.state!==previous){record('outbox',{state:s.state??'empty',attempts:s.attempts});previous=s.state;}if(['sent','uncertain','blocked'].includes(s.state)) return;await delay(5000);}while(Date.now()<limit);record('window-ended-no-replay');};
    const ops={read,deploy:id=>post(token,`${script}/deployments`,'POST',{strategy:'percentage',versions:[{version_id:id,percentage:100}]}),schedules:rows=>post(token,`${script}/schedules`,'PUT',rows.map(cron=>({cron}))),receipt};
    if(mode==='restore') {
      const rows=readFileSync(journal,'utf8').trim().split('\n').map(s=>JSON.parse(s));
      const deployments=rows.filter(r=>r.phase==='deployment');check(deployments.length===1 && rows.every(r=>r.hash===hash) && !rows.some(r=>r.phase==='inert-restored'),'not an outstanding known deployment');
      await restorePrivate(ops,deployments[0].deployment,deployments[0].version,rows.some(r=>r.phase==='arm-intent'),hash);return;
    }
    mkdirSync(dir,{mode:0o700,recursive:true});check(!existsSync(journal),'attempt already consumed; never replay');writeFileSync(journal,'',{flag:'wx',mode:0o600,flush:true});receipt('attempt');
    await executePrivate({...ops,create:body=>post(token,`${target}/versions?deploy=false`,'POST',body),authority:()=>permit(run,sha,mode),inventory:()=>privateGraph(reader),requireSeal,outbox,observe,module,hash,end:p.end});
    const final=await outbox();receipt('outbox-final',{state:final.state??'empty',attempts:final.attempts});check(final.state==='sent' && final.attempts===1,'DM not provider-confirmed; no replay');
  } finally {rmSync(tmp,{force:true,recursive:true});}
}
main(process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=1;});
