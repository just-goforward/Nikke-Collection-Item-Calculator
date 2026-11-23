// Post-write live check, with no provider credentials. Never fabricate responses or permit browser writes.
import assert from 'node:assert/strict';
import { hash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
const [packet,role]=process.argv.slice(2);assert(process.argv.length===4&&['rollback','forward'].includes(role));
assert(!process.env.CLOUDFLARE_API_TOKEN&&!process.env.GH_TOKEN&&!process.env.ROOT_CONTROL_READ_TOKEN);
const files=JSON.parse(readFileSync(packet)).files[role],origin='https://nikkecollection.com';
const apis=new Set(['/api/forecast','/api/forecast/version','/api/joint-supply/v2','/api/calendar']);
const browser=await chromium.launch();try {
  for(const [path,lang] of [['/en/','en'],['/ja/','ja'],['/','ko']]) {
    const ctx=await browser.newContext({serviceWorkers:'block',locale:lang}),p=await ctx.newPage(),errors=[],resources=[];
    await ctx.route('**/*',async route=>{
      const req=route.request(),u=new URL(req.url()),file=u.pathname.endsWith('/')?u.pathname+'index.html':u.pathname;
      if(req.method()==='GET'&&u.origin===origin&&!u.search&&(Object.hasOwn(files,file)||apis.has(u.pathname)))return route.continue();
      if(req.method()!=='GET')errors.push(`unexpected method ${req.method()}`);
      return route.abort();
    });
    p.on('pageerror',e=>errors.push(String(e)));
    p.on('response',r=>{const u=new URL(r.url());if(u.origin===origin&&(/browserWorker.*\.js$/.test(u.pathname)||/\.wasm$/.test(u.pathname)))resources.push(r);});
    const doc=await p.goto(origin+path);assert.equal(doc.status(),200);assert.equal(hash('sha256',await doc.body()),files[path+'index.html'].sha256);
    await expect(p.locator('html')).toHaveAttribute('lang',lang);await expect(p.locator('#calculateButton')).toBeVisible();
    if(lang==='ko'){
      await p.locator('[data-grade="R"]').click();await p.locator('[data-level="14"]').click();
      for(const [k,v] of Object.entries({currentExp:800,blueStock:0,purpleStock:0,yellowStock:30})){await p.locator('#'+k).fill(String(v));await p.locator('#'+k).blur();}
      await p.locator('#calculateButton').click();await expect(p.locator('#calculateButton')).toBeEnabled({timeout:40000});
      if(role==='forward'){await expect(p.getByTestId('preview-verification')).toContainText('D0–D14',{timeout:40000});await expect(p.getByTestId('preview-verification')).toContainText('production-conditional-');}
      else await expect(p.getByTestId('waiting-metric')).toContainText('대기 비교 미완료',{timeout:40000});
      for(const pattern of [/browserWorker.*\.js$/,/\.wasm$/])assert(resources.some(r=>pattern.test(r.url())));
      for(const r of resources){const f=new URL(r.url()).pathname;assert.equal(r.status(),200);assert.equal(hash('sha256',await r.body()),files[f].sha256);}
    }
    assert.deepEqual(errors,[]);await ctx.close();
  }
}finally{await browser.close();}
