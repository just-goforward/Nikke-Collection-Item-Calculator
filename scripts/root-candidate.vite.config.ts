import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {defineConfig} from 'vite';
import base from '../vite.config.ts';
import target from './root-conditional-target.json' with {type:'json'};

// Deliberately not a selectable production or preview mode. This executable target has
// no credentials, no official timed trust, and cannot write an operational site receipt.
export default defineConfig({ ...base, base:'/', envDir:false,
  define:{...base.define,__ISOLATED_ROOT_CANDIDATE__:'true'},
  plugins:[...(base.plugins ?? []).filter(plugin => !(plugin && typeof plugin==='object' && 'name' in plugin && plugin.name==='preview-only-trust')),{
    name:'isolated-root-candidate-only',
    configResolved({base,build,env,root}) {
      assert.equal(base,'/');assert.equal(target.enrolledPublicKeyBase64,null);
      assert.equal(env.VITE_ROOT_CONDITIONAL_PUBLIC_KEY,target.isolatedCandidatePublicKeyBase64);
      assert.equal(env.VITE_SERVICE_CERTIFIED_SOLVER,'true');assert.equal(env.VITE_FORECAST_RUNTIME,'bundled');
      assert.deepEqual(Object.keys(env).filter(k=>k.startsWith('VITE_')).sort(),['VITE_FORECAST_RUNTIME','VITE_ROOT_CONDITIONAL_PUBLIC_KEY','VITE_SERVICE_CERTIFIED_SOLVER']);
      assert.match(resolve(root,build.outDir).slice(resolve(root,'.artifacts').length),/^\/service-h14-run\.[a-zA-Z0-9]+\/root-build$/);
      assert(resolve(root,build.outDir).startsWith(resolve(root,'.artifacts')+'/'));
    },
    transformIndexHtml:{order:'pre',handler(html){return html.replaceAll('/preview/','/').replace('preview:collectionThemeMode','collectionThemeMode').replace('</head>',`<script>window.COLLECTION_STATS_CONFIG={endpoint:"https://nikkecollection.com",turnstileSiteKey:"0x4AAAAAADJiF42vmIlh7EOp"};</script></head>`);}},
  }],
});
