import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {defineConfig} from 'vite';
import isolated from './root-candidate.vite.config.ts';
import {assertProductionKey} from './root-release-custody.mjs';

// Reuse only the HTML transform, not the isolated trust guard or origin capability.
const shell=isolated.plugins!.find(p=>p&&typeof p==='object'&&'name' in p&&p.name==='isolated-root-candidate-only');
assert(shell&&typeof shell==='object'&&'transformIndexHtml' in shell);
export default defineConfig({...isolated,define:{...isolated.define,__ISOLATED_ROOT_CANDIDATE__:'false',__PRODUCTION_ROOT_SITE__:'true'},
  resolve:{...isolated.resolve,alias:[{find:/^(?:\.\/|\.\.\/lib\/|\.\/lib\/)rootCandidate(?:\.ts)?$/,replacement:resolve('src/lib/productionRootOrigin.ts')}]},
  plugins:[...isolated.plugins!.filter(p=>p!==shell),{name:'private-production-root-v1',transformIndexHtml:shell.transformIndexHtml,
    configResolved({base,build,env,root}){
      assert.equal(base,'/');assert.equal(env.VITE_SERVICE_CERTIFIED_SOLVER,'true');assert.equal(env.VITE_FORECAST_RUNTIME,'bundled');
      assert.deepEqual(Object.keys(env).filter(k=>k.startsWith('VITE_')).sort(),['VITE_FORECAST_RUNTIME','VITE_ROOT_CONDITIONAL_PUBLIC_KEY','VITE_SERVICE_CERTIFIED_SOLVER']);
      assertProductionKey(env.VITE_ROOT_CONDITIONAL_PUBLIC_KEY);
      assert(/^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA??''));
      const out=resolve(root,build.outDir),prefix=resolve(root,'.artifacts')+'/';assert(out.startsWith(prefix)&&/^service-h14-run\.[\w-]+\/root-build$/.test(out.slice(prefix.length)));
    }}]});
