import test from 'node:test';
import assert from 'node:assert/strict';
import { hash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { sealRootRelease, verifyRelease, verifyRootRelease } from '../site-release.mjs';
import { assertSiteUploadApproved } from '../deploy-site.ts';
import { V14_MODULE } from '../site-release-v14.mjs';

const carrier=process.env.ROOT_V14_CARRIER;
test('both nonpublishing fixture transports preserve the actual historical module and independently verified npm closure',
  {skip:carrier? false:'requires original authenticated v14 carrier; no substitute Worker'},t=>{
    const tmp=mkdtempSync(join(tmpdir(),'v14-transport-'));t.after(()=>rmSync(tmp,{recursive:true,force:true}));
    const root=join(tmp,'test-checkout'),src=join(root,'site-worker/src');mkdirSync(root);
    const put=(p,b)=>{mkdirSync(dirname(p),{recursive:true});writeFileSync(p,b);};
    const prior=join(carrier,'v14');cpSync(join(prior,'site-worker'),join(root,'site-worker'),{recursive:true});
    for(const p of ['pnpm-lock.yaml','pnpm-workspace.yaml','node_modules/wrangler/package.json'])put(join(root,p),readFileSync(resolve(import.meta.dirname,'../..',p)));
    const sha='a'.repeat(40),env={GITHUB_SHA:sha,GITHUB_WORKFLOW_SHA:sha,GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',
      GITHUB_REPOSITORY:'test/transport-only',GITHUB_WORKFLOW_REF:'test/transport-only/.github/workflows/site-worker-promote.yml@refs/heads/main',GITHUB_RUN_ID:'101',GITHUB_RUN_ATTEMPT:'1'};
    const git=(_cmd,args)=>args[0]==='rev-parse'?sha:args[0]==='ls-files'?readdirSync(src,{recursive:true,withFileTypes:true}).filter(f=>f.isFile()).map(f=>join(f.parentPath,f.name).slice(root.length+1)+'\0').join(''):'';
    const manifests=[];
    for(const role of ['rollback','forward']){
      const dir=join(tmp,role);mkdirSync(dir);
      for(const file of ['manifest.json','site-production.json','forecast-runtime.json','local-operational-profile.json'])put(join(root,'dist/.vite',file),'{"deploymentApproved":false}');
      put(join(root,'dist/index.html'),role);const digest=sealRootRelease(root,dir,sha,env,carrier,git);manifests.push(digest);
      const worker=verifyRootRelease(root,dir,sha,digest,'101','1',true);
      assert.equal(hash('sha256',readFileSync(worker)),V14_MODULE);assert.deepEqual(readFileSync(worker),readFileSync(join(carrier,'worker/worker.js')));
      assert.deepEqual(readFileSync(join(dir,'worker/meta.json')),readFileSync(join(carrier,'worker/meta.json')));
      assert.equal(JSON.parse(readFileSync(join(dir,'manifest.json'))).provenance.dependencies.length,123);
      assert.throws(()=>verifyRelease(root,dir,sha,digest,'101','1'),/identity mismatch/);
      assert.throws(()=>assertSiteUploadApproved(join(dir,'dist')),/nondeployable/);
    }
    assert.notEqual(...manifests);
    // Even replacing the outside manifest pin after changing the historical npm dependency cannot create another valid carrier.
    const dir=join(tmp,'forward'),p='v14/node_modules/zod/package.json',b=Buffer.from('{"name":"zod"}');put(join(dir,p),b);
    const m=JSON.parse(readFileSync(join(dir,'manifest.json')));m.files[p]={bytes:b.length,sha256:hash('sha256',b)};
    const raw=JSON.stringify(m);put(join(dir,'manifest.json'),raw);
    assert.throws(()=>verifyRootRelease(root,dir,sha,hash('sha256',raw),'101','1'),/v14 custody inventory mismatch/);
    put(join(src,'worker.ts'),'export default {};');mkdirSync(join(tmp,'other'));
    assert.throws(()=>sealRootRelease(root,join(tmp,'other'),sha,env,carrier,git),/asset-only promotion cannot change/);
  });
