import {readFileSync,writeFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {registerHooks} from "node:module";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
registerHooks({resolve(s,c,n){return n(s.startsWith(".")&&!/\.[a-z]+$/i.test(s)?s+".ts":s,c);}});
const dir=new URL(".",import.meta.url);
if(!process.argv[2]){
 const candidates=[
 ...[
 ["today-r200",[200,100,50],"R",0,0],
 ["today-sr200",[200,100,50],"SR",0,0],
 ["today-r150",[150,80,40],"R",0,0],
 ].map(([id,stock,grade,level,cohort,priceBasisStock,asOf])=>({id,stock,grade,level,cohort,priceBasisStock,asOf}))
 ];
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(NODE_|UV_)/i.test(k)));
 const results=[];
 for(const c of candidates){
 const r=spawnSync(process.execPath,["--experimental-transform-types",fileURLToPath(import.meta.url),JSON.stringify(c)],{env,timeout:30000,encoding:"utf8"});
 const row={id:c.id,status:r.status,signal:r.signal,error:r.error?.message,stderr:r.stderr,data:r.stdout?JSON.parse(r.stdout):null};
 results.push(row);console.log(JSON.stringify(row));
 }
 writeFileSync(new URL("today-node-results.json",dir),JSON.stringify(results,null,2));
}else{
 const c=JSON.parse(process.argv[2]);
 const {solveCertifiedWasm}=await import("../../src/certified/wasmSolver.ts");
 const {loadCertifiedWasm}=await import("../../src/certified/wasmBackend.ts");
 const {prepareCertifiedForecast}=await import("../../src/lib/certifiedForecast.ts");
 let input;
 if(c.saved)input=JSON.parse(readFileSync(new URL(c.id+".json",dir),"utf8"));
 else{
 const asOf=c.asOf??new Date().toISOString();
 const snapshot=await prepareCertifiedForecast(asOf);
 input={grade:c.grade,level:c.level,exp:0,stock:c.stock,asOf,snapshot,batchLimit:10,computeWaiting:true,receivedEventIds:snapshot.events.filter(e=>e.gameDate===snapshot.coverage.currentDay).map(e=>e.id)};
 if(c.cohort)input.cohortWeights=[0,1,2].map(i=>({numerator:i===c.cohort-1?"1":"0",denominator:"1"}));
 if(c.priceBasisStock)input.priceBasisStock=c.priceBasisStock;
 writeFileSync(new URL(c.id+".json",dir),JSON.stringify(input));
 }
 const module=await loadCertifiedWasm(async()=>readFileSync("public/certified_solver.wasm"));
 const started=performance.now();let currentAtMs=null,currentDiagnostics=null;
 const output=solveCertifiedWasm(module,input,{onCurrent:o=>{currentAtMs=performance.now()-started;currentDiagnostics=o.diagnostics;}});
 console.log(JSON.stringify({id:c.id,wallMs:performance.now()-started,currentAtMs,currentDiagnostics,waitingAndFinalizeMs:currentAtMs===null?null:performance.now()-started-currentAtMs,diagnostics:output.diagnostics,evaluatedDays:output.waiting.evaluatedDays,waiting:output.waiting.status,recommendedDays:output.waiting.recommendedDays,evidence:output.waiting.evidence,refusal:output.refusal,memory:process.memoryUsage(),resource:process.resourceUsage(),inputSha256:createHash("sha256").update(JSON.stringify(input)).digest("hex")}));
}
