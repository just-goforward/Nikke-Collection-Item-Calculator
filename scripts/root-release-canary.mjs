// Local Chromium, no DNS from browser. Only fresh exact production GETs are proxied by Node.
import assert from 'node:assert/strict';
import {hash} from 'node:crypto';
import {readFile,realpath,writeFile} from 'node:fs/promises';
import {extname,join} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {legacyFontAudit} from '../e2e/operational-font-policy.mjs';
const [packet,out,seals,...rest]=process.argv.slice(2);assert(out&&!rest.length);
const startedAt=Date.now();
const bytes=await readFile(packet),pair=JSON.parse(bytes),origin='https://nikkecollection.com';assert.equal(pair.profile,'private-production-root-v1');assert.equal(pair.publicationApproved,false);assert.equal(pair.files.retained,66);
const allowed=new Set(['/api/forecast','/api/forecast/version','/api/joint-supply/v2']);
const mime={'.html':'text/html','.css':'text/css','.js':'text/javascript','.wasm':'application/wasm','.json':'application/json','.woff2':'font/woff2','.png':'image/png'};
const browser=await chromium.launch({args:['--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND']});const results=[];
try{for(const [before,after] of [['rollback','forward'],['forward','rollback']]){
  const c=await browser.newContext({serviceWorkers:'block'});let active=before,switched=false;const gets=[],errors=[];
  const fonts=legacyFontAudit(c,origin);let oldFrame,newFrame;
  await c.routeWebSocket('**/*',socket=>{errors.push('websocket');socket.close();});
  await c.route('**/*',async route=>{const req=route.request(),u=new URL(req.url());try{
    if(await fonts.block(route))return;
    assert(req.method()==='GET' && !u.username && !u.password && !u.search && !u.hash && !req.postDataBuffer());
    assert.equal(u.origin,origin);const p=u.pathname;
    if(allowed.has(p)){assert(!u.search);const response=await fetch(u,{redirect:'error',signal:AbortSignal.timeout(8000),headers:{'cache-control':'no-cache'}});assert.equal(response.status,200);const b=Buffer.from(await response.arrayBuffer());assert(b.length<=524288);gets.push({active,p,switched,sha256:hash('sha256',b)});return route.fulfill({body:b,contentType:'application/json'});}
    const serving=active,k=p.endsWith('/')?p+'index.html':p, pin=pair.files[serving][k];assert(pin);
    const tree=seals?join(seals,serving,'dist'):serving==='forward'?pair.output:pair.rollback;
    const f=join(tree,k);assert.equal(await realpath(f),f);const b=await readFile(f);assert.equal(b.length,pin.bytes);assert.equal(hash('sha256',b),pin.sha256);
    if(req.isNavigationRequest()){
      const frame=req.frame();assert(frame===oldFrame || frame===newFrame);
      fonts.bind(frame,{role:frame===oldFrame?'old':'new',tree:serving,key:k,href:u.href,servedHash:pin.sha256,legacyHash:pair.files.rollback[k].sha256});
    }
    gets.push({active:serving,p,switched,sha256:pin.sha256});await route.fulfill({body:b,contentType:mime[extname(k)]??'application/octet-stream'});
  }catch{errors.push('denied request or unverified response');await route.abort().catch(()=>{});}});
  const p=await c.newPage();oldFrame=p.mainFrame();p.on('pageerror',()=>errors.push('old page error'));await p.goto(origin+'/');await p.locator('[data-grade="R"]').click();await p.locator('[data-level="14"]').click();for(const [k,v] of Object.entries({currentExp:800,blueStock:0,purpleStock:0,yellowStock:30})){await p.locator('#'+k).fill(String(v));await p.locator('#'+k).blur();}
  active=after;switched=true;await p.locator('#calculateButton').click();await expect(p.locator('#calculateButton')).toBeEnabled({timeout:40000});
  if(before==='forward'){await expect(p.getByTestId('preview-verification')).toContainText('D0–D14',{timeout:40000});await expect(p.getByTestId('preview-verification')).toContainText('production-conditional-');assert(gets.some(g=>g.switched&&g.p==='/api/joint-supply/v2'));}
  else {await expect(p.locator('#resultBox')).toBeVisible();await expect(p.getByTestId('waiting-metric')).toContainText('대기 비교 미완료',{timeout:40000});}
  const lazy=before==='rollback'?['/assets/browserWorker-EkFyhckN.js','/wasm/certified_solver.88553a72d8503d2c7c78366e3d85bbee0cd9dfd738ac94d588fb09bd9d5942ae.wasm']:['/'+pair.worker,'/wasm/service-fused-h14-'+pair.review.nativeWasmSha256+'.wasm'];
  for(const path of lazy) assert(gets.some(g=>g.switched && g.active===after && g.p===path && g.sha256===pair.files[before][path].sha256),'missing retained lazy bytes');
  const newTab=await c.newPage(), documents={};newFrame=newTab.mainFrame();newTab.on('pageerror',()=>errors.push('new page error'));
  for(const prefix of ['/','/en/','/ja/']) for(const name of ['index','privacy','terms','licenses']) {
    const file=prefix+name+'.html', doc=await newTab.goto(origin+file);
    assert.equal(doc.status(),200); documents[file]=hash('sha256',await doc.body()); assert.equal(documents[file],pair.files[after][file].sha256);
  }
  await newTab.close();await p.close();await c.unrouteAll({behavior:'wait'});await c.close();assert.deepEqual(errors,[]);results.push({before,after,gets,documents,blockedFonts:fonts.finish()});
}}finally{await browser.close();}
await writeFile(out,JSON.stringify({profile:seals?'sealed-root-rehearsal-v2':'private-root-tab-canary-v2',source:pair.review.source,packetSha256:hash('sha256',bytes),startedAt,finishedAt:Date.now(),results,publicTrafficSwitched:false},null,2),{flag:'wx',mode:0o600});
