import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const root=process.env.STOP_TRACE_ROOT;
if(!root)throw Error('mock trace root required');
const mode=process.argv[2],role=process.argv[4],phase=mode==='worker'?role:mode;
const original=Object.fromEntries(['openSync','closeSync','writeSync','writeFileSync','appendFileSync','fsyncSync','renameSync','copyFileSync'].map(k=>[k,fs[k].bind(fs)]));
const statePath=path.join(root,'mock-state.json'),tracePath=path.join(root,'effects.jsonl');
let state=JSON.parse(fs.readFileSync(statePath,'utf8')),ordinal=0;
const rawWrite=(file,data,flags='w')=>{const fd=original.openSync(file,flags);try{original.writeSync(fd,data);}finally{original.closeSync(fd);}};
const save=()=>rawWrite(statePath,JSON.stringify(state));
const normalize=s=>String(s).replaceAll(root,'<case>').replaceAll(root.replaceAll('\\','/'),'<case>').replaceAll('\\','/');
let events=0;
const event=(kind,details={})=>{if(++events>1000)process.exit(97);rawWrite(tracePath,JSON.stringify({phase,kind,...details})+'\n','a');};
const safe=file=>{const resolved=path.resolve(String(file));if(resolved!==path.resolve(root)&&!resolved.startsWith(path.resolve(root)+path.sep))throw Error('unexpected mock write');return resolved;};
const descriptors=new Map();
fs.openSync=(file,flags,...args)=>{
  if(String(flags).includes('w')||String(flags).includes('a'))safe(file);
  if(mode==='prepare'&&String(file).includes('snapshot.json.')&&state.prepareDeath){
    if(state.prepareDeath==='truncated')rawWrite(path.join(root,'packet/snapshot.json'),'{"registry":');
    event('process_exit',{code:23,reason:state.prepareDeath});process.exit(23);
  }
  const fd=original.openSync(file,flags,...args);
  if(String(flags).includes('w')||String(flags).includes('a')){descriptors.set(fd,String(file));event('open',{path:normalize(file),flags});}
  return fd;
};
function fault(file,data){
  if(state.outputFailure&&String(file).endsWith('outputs')){
    event('output_failure',{path:normalize(file)});throw Error('disk_failed');
  }
  const receipt=String(file).includes('-requests.jsonl');
  if(receipt&&state.writeFailure&&String(data).includes(`"state":"${state.writeFailure}"`)){
    event('write_failure',{path:normalize(file),state:state.writeFailure});throw Error('disk_failed');
  }
  if(state.markerFailure&&String(data).includes('"chain":"incomplete"')){
    event('marker_failure',{path:normalize(file)});throw Error('disk_failed');
  }
}
fs.writeSync=(fd,data,...args)=>{const file=descriptors.get(fd);fault(file,data);const result=original.writeSync(fd,data,...args);event('write',{path:normalize(file),data:String(data)});return result;};
fs.writeFileSync=(file,data,...args)=>{const name=typeof file==='number'?descriptors.get(file):safe(file);fault(name,data);const result=original.writeFileSync(file,data,...args);event('write_file',{path:normalize(name),data:String(data)});return result;};
fs.appendFileSync=(file,data,...args)=>{safe(file);fault(file,data);const result=original.appendFileSync(file,data,...args);event('append_file',{path:normalize(file),data:String(data)});return result;};
fs.fsyncSync=fd=>{const result=original.fsyncSync(fd);event('fsync',{path:normalize(descriptors.get(fd))});return result;};
fs.closeSync=fd=>{const file=descriptors.get(fd),result=original.closeSync(fd);if(file)event('close',{path:normalize(file)});descriptors.delete(fd);return result;};
fs.renameSync=(from,to)=>{safe(from);safe(to);const result=original.renameSync(from,to);event('rename',{from:normalize(from),to:normalize(to)});return result;};
fs.copyFileSync=(from,to,...args)=>{safe(to);const result=original.copyFileSync(from,to,...args);event('copy',{from:normalize(from),to:normalize(to)});return result;};
const phaseId={prepare:1,dispatcher:2,collector:3,finalize:4,operator:5}[phase]??6;
crypto.randomUUID=()=>`${String(phaseId).padStart(8,'0')}-7777-4777-8777-${String(++ordinal).padStart(12,'0')}`;
const NativeDate=Date;
globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:['2026-10-03T00:00:00.000Z']));}static now(){return NativeDate.parse('2026-10-03T00:00:00.000Z');}};
syncBuiltinESMExports();

const deployment=(versionId,message='',number=1)=>({id:`${String(number).padStart(8,'0')}-3333-4333-8333-333333333333`,created_on:new NativeDate(NativeDate.parse('2026-10-03T00:00:00Z')+number*1000).toISOString(),annotations:{'workers/message':message},versions:[{version_id:versionId,percentage:100}]});
globalThis.fetch=async(input,init={})=>{
  const url=new URL(String(input)),method=init.method??'GET',body=init.body?JSON.parse(String(init.body)):undefined;
  event('http',{method,url:url.href,...(body?{body}: {})});
  if(!['api.github.com','api.cloudflare.com'].includes(url.hostname))throw Error('unexpected mock origin');
  const knownRole=url.pathname.includes('forecast-dispatcher-staging')?'dispatcher':'collector';
  if(mode==='worker'&&role==='dispatcher'&&state.dispatcherDeath){event('process_exit',{code:24});process.exit(24);}
  if(url.hostname==='api.github.com'){
    if(url.pathname.endsWith('/actions/workflows/forecast-d1-budget-watch.yml/runs'))return Response.json({total_count:state.activeRuns??0,workflow_runs:Array.from({length:state.activeRuns??0},()=>({status:'waiting'}))});
    if(!url.pathname.endsWith('/actions/variables/FORECAST_STAGING_PAUSED_PAIR'))throw Error('unexpected mock GitHub scope');
    state.registryReads=(state.registryReads??0)+1;
    if(state.registryReads<=(state.registryFailures??0)){save();return new Response(null,{status:503});}
    const registry=structuredClone(state.registry);
    if(state.registryInvalid)registry.workers.dispatcher.versionId=registry.workers.collector.versionId;
    if(state.registryDriftAfter&&state.registryReads>state.registryDriftAfter)registry.epoch++;
    if(state.phaseEpochs?.[phase])registry.epoch=state.phaseEpochs[phase];
    save();return Response.json({value:JSON.stringify(registry)});
  }
  const prefix=`/client/v4/accounts/${state.registry.accountId}/workers/scripts/${state.registry.workers[knownRole].script}/`;
  if(!url.pathname.startsWith(prefix))throw Error('unexpected mock Cloudflare scope');
  if(url.pathname.includes('/versions/')){
    state.versionReads[knownRole]++;
    const code=state.versionErrors?.[knownRole];
    if(code&&(!state.transientOnce||state.versionReads[knownRole]===1)){save();return new Response(null,{status:code});}
    const flags={ENVIRONMENT:'staging',COLLECT_ENABLED:'false',DISPATCH_ENABLED:'false',...(state.invalidFlags?.[knownRole]??{})};
    const bindings=Object.entries(flags).map(([name,text])=>({type:'plain_text',name,text}));
    if(state.secretBindings)bindings.push({type:'secret_text',name:'DISCORD_BOT_TOKEN',text:'mock-secret-excluded'});
    save();return Response.json({success:true,result:{id:state.registry.workers[knownRole].versionId,resources:{bindings}}});
  }
  if(!url.pathname.endsWith('/deployments'))throw Error('unexpected mock REST path');
  if(method==='GET'&&state.currentReadError)return new Response(null,{status:500});
  if(method==='POST'){
    if(state.postReject?.includes(knownRole))return new Response(null,{status:403});
    if(body.strategy!=='percentage'||body.versions.length!==1||body.versions[0].version_id!==state.registry.workers[knownRole].versionId||body.versions[0].percentage!==100)throw Error('unexpected mock deployment body');
    const d=deployment(body.versions[0].version_id,body.annotations['workers/message'],state.nextDeployment++);
    state.entries[knownRole].push(d);state.current[knownRole]=d;
    if(state.duplicateHistory)state.entries[knownRole].push(deployment(body.versions[0].version_id,d.annotations['workers/message'],state.nextDeployment++));
    if(state.currentMismatch)state.current[knownRole]=deployment(state.registry.workers[knownRole==='collector'?'dispatcher':'collector'].versionId,'competing',state.nextDeployment++);
    save();
    if(state.ackLoss)throw new DOMException('mock timeout','TimeoutError');
    return Response.json({success:true,result:{id:d.id}});
  }
  const entries=state.entries[knownRole],current=state.current[knownRole];
  return Response.json({success:true,result:{deployments:entries.some(d=>d.id===current.id)?entries:[...entries,current]},result_info:{total_pages:1}});
};
