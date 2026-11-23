// Local Chromium, no DNS from browser. Only fresh exact production GETs are proxied by Node.
import assert from 'node:assert/strict';
import {hash} from 'node:crypto';
import {readFile,realpath,writeFile} from 'node:fs/promises';
import {extname,join} from 'node:path';
import {chromium,expect} from '@playwright/test';
const [packet,out,...rest]=process.argv.slice(2);assert(out&&!rest.length);
const bytes=await readFile(packet),pair=JSON.parse(bytes),origin='https://nikkecollection.com';assert.equal(pair.profile,'private-production-root-v1');assert.equal(pair.publicationApproved,false);assert.equal(pair.files.retained,66);
const allowed=new Set(['/api/forecast','/api/forecast/version','/api/joint-supply/v2']);
const mime={'.html':'text/html','.css':'text/css','.js':'text/javascript','.wasm':'application/wasm','.json':'application/json','.woff2':'font/woff2','.png':'image/png'};
const browser=await chromium.launch({args:['--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND']});const results=[];
try{for(const [before,after] of [['rollback','forward'],['forward','rollback']]){
  const c=await browser.newContext({serviceWorkers:'block'});let active=before,switched=false;const gets=[],errors=[];
  await c.route('**/*',async route=>{const req=route.request(),u=new URL(req.url());try{
    assert.equal(req.method(),'GET');if(u.origin==='https://cdn.jsdelivr.net'&&u.pathname.startsWith('/gh/orioncactus/pretendard@v1.3.9/dist/'))return route.abort();
    assert.equal(u.origin,origin);const p=u.pathname;
    if(allowed.has(p)){assert(!u.search);const response=await fetch(u,{redirect:'error',signal:AbortSignal.timeout(8000),headers:{'cache-control':'no-cache'}});assert.equal(response.status,200);const b=Buffer.from(await response.arrayBuffer());assert(b.length<=524288);gets.push({active,p,switched,sha256:hash('sha256',b)});return route.fulfill({body:b,contentType:'application/json'});}
    const k=p.endsWith('/')?p+'index.html':p,pin=pair.files[active][k];assert(pin,k);const f=join(active==='forward'?pair.output:pair.rollback,k);assert.equal(await realpath(f),f);const b=await readFile(f);assert.equal(hash('sha256',b),pin.sha256);gets.push({active,p,switched,sha256:pin.sha256});return route.fulfill({body:b,contentType:mime[extname(k)]??'application/octet-stream'});
  }catch(e){errors.push(String(e));return route.abort();}});
  const p=await c.newPage();p.on('pageerror',e=>errors.push(String(e)));await p.goto(origin+'/');await p.locator('[data-grade="R"]').click();await p.locator('[data-level="14"]').click();for(const [k,v] of Object.entries({currentExp:800,blueStock:0,purpleStock:0,yellowStock:30})){await p.locator('#'+k).fill(String(v));await p.locator('#'+k).blur();}
  active=after;switched=true;await p.locator('#calculateButton').click();await expect(p.locator('#calculateButton')).toBeEnabled({timeout:40000});
  if(before==='forward'){await expect(p.getByTestId('preview-verification')).toContainText('D0–D14',{timeout:40000});await expect(p.getByTestId('preview-verification')).toContainText('production-conditional-');assert(gets.some(g=>g.switched&&g.p==='/api/joint-supply/v2'));}
  else {await expect(p.locator('#resultBox')).toBeVisible();await expect(p.getByTestId('waiting-metric')).toContainText('대기 비교 미완료',{timeout:40000});}
  for(const marker of [/browserWorker.*\.js$/,/\.wasm$/])assert(gets.some(g=>g.switched&&marker.test(g.p)),String(marker));
  assert.deepEqual(errors,[]);const doc=await p.goto(origin+'/');assert.equal(hash('sha256',await doc.body()),pair.files[after]['/index.html'].sha256);results.push({before,after,gets});await c.close();
}}finally{await browser.close();}
await writeFile(out,JSON.stringify({profile:'private-root-tab-canary-v1',packetSha256:hash('sha256',bytes),observedAt:new Date().toISOString(),results,publicTrafficSwitched:false},null,2),{flag:'wx',mode:0o600});
