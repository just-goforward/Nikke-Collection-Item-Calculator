import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
registerHooks({resolve(specifier,context,next){return next(specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier) ? specifier+".ts" : specifier,context);}});
const root = process.cwd();
const dir = new URL(".", import.meta.url);
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NODE_|UV_)/i.test(k)));
if (!process.argv[2]) {
  const candidates = [
    ["r-no56", "R", 0, 0, [200,100,50]],
    ["sr-no56", "SR", 0, 0, [0,0,0]],
    ["r-dense", "R", 0, 0, [0,0,0]],
  ];
  const results = [];
  for (const c of candidates) {
    const t = performance.now();
    const r = spawnSync(process.execPath, ["--experimental-transform-types",fileURLToPath(new URL("run.mjs", dir)), JSON.stringify(c)], {env,timeout:30000,encoding:"utf8",cwd:root});
    results.push({id:c[0],processWallMs:performance.now()-t,status:r.status,signal:r.signal,error:r.error?.message,stdout:r.stdout,stderr:r.stderr});
  }
  writeFileSync(new URL("results-waiting.json",dir),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results.map(r=>({...r,stdout:r.stdout ? JSON.parse(r.stdout) : ""})).map(r=>r.stdout ? {id:r.id,wallMs:r.stdout.wallMs,maxRSSKiB:r.stdout.resource.maxRSS,endMem:r.stdout.endMem,diagnostics:r.stdout.output.diagnostics,status:r.stdout.output.status,waiting:r.stdout.output.waiting.status,refusal:r.stdout.output.refusal,capsR:r.stdout.capsR,capsSR:r.stdout.capsSR} : r),null,2));
} else {
  const { solveCertifiedWasm } = await import("../../src/certified/wasmSolver.ts");
  const { loadCertifiedWasm } = await import("../../src/certified/wasmBackend.ts");
  const { certifiedWorkerFixture } = await import("../../src/certifiedRuntime/integrationFixture.ts");
  const { CAPS } = await import("../../src/certified/game.ts");
  const [id,grade,level,exp,stock] = JSON.parse(process.argv[2]);
  const input = {...structuredClone(await certifiedWorkerFixture(true)),grade,level,exp,stock,batchLimit:1000};
  if (id.includes("no56") || id.includes("dense")) input.snapshot.events = input.snapshot.events.filter(e=>Date.parse(e.at) < Date.parse(input.asOf)+55*86400000);
  if (id.includes("dense")) {
    const template=input.snapshot.events.find(e=>Date.parse(e.at)>Date.parse(input.asOf));
    input.snapshot.events=Array.from({length:2048},(_,i)=>({...template,id:"dense:"+i}));
  }
  const bytes = readFileSync("public/certified_solver.wasm");
  const module = await loadCertifiedWasm(async()=>bytes);
  const text = JSON.stringify(input);
  writeFileSync(new URL(id+".json",dir),text);
  const startMem=process.memoryUsage(), start=performance.now();
  const output=solveCertifiedWasm(module,input);
  const wallMs=performance.now()-start;
  console.log(JSON.stringify({id,wallMs,startMem,endMem:process.memoryUsage(),resource:process.resourceUsage(),capsR:CAPS[0],capsSR:CAPS[150],inputSha256:createHash("sha256").update(text).digest("hex"),wasmSha256:createHash("sha256").update(bytes).digest("hex"),output}));
}
