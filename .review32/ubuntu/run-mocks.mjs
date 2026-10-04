import fs from 'node:fs';
import path from 'node:path';
import {runScenario,assertScenario,assertWriteAhead,scenarios} from './trace-harness.mjs';
const ids=['normal-idle-missing','budget-provided','budget-write-failure','budget-dispatcher-403','prepare-exit','dispatcher-exit'];
const results=[];
for(const id of ids){const spec=scenarios.find(s=>s.id===id);const output=runScenario(process.cwd(),'approved-source',spec);assertScenario(output,spec);assertWriteAhead(output,spec);results.push({id,steps:output.steps,posts:output.trace.filter(e=>e.kind==='http'&&e.method==='POST').length,fsyncs:output.trace.filter(e=>e.kind==='fsync').length,renames:output.trace.filter(e=>e.kind==='rename').length});}
const root=path.resolve(process.env.FORECAST_NATIVE_MOCK_ROOT??'.tmp/review32-native-mocks');fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'native-summary.json'),JSON.stringify({os:process.platform,node:process.version,cases:results.length,actualApiRequests:0,results},null,2)+'\n');console.log(JSON.stringify({pass:true,os:process.platform,node:process.version,cases:results.length,actualApiRequests:0}));
