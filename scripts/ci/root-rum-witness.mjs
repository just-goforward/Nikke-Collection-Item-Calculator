// Read-only, non-authorizing companion to the protected root checks. No browser request is fulfilled here.
import assert from 'node:assert/strict';
import { hash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { assertPin, beaconURL, restoreBeacon, checkPreview, rootOrigin, traceIdentity, verifyRootDocument } from './root-rum-bytes.mjs';

const [packet, role, mode = 'full'] = process.argv.slice(2);
const previewOnly=mode==='restore-preflight';
assert((mode==='full' || previewOnly && role==='forward') && ['forward','rollback'].includes(role));
const proof=process.env.ROOT_RESTORE_RUM ? JSON.parse(process.env.ROOT_RESTORE_RUM) : undefined;
assert(!proof || previewOnly || role==='rollback');
const tag=proof ? restoreBeacon(proof) : undefined;
assert(!process.env.CLOUDFLARE_API_TOKEN && !process.env.ROOT_CONTROL_READ_TOKEN && !process.env.ROOT_RUM_READ_TOKEN && !process.env.GH_TOKEN);
const packetBytes = readFileSync(packet), pair = JSON.parse(packetBytes), files = pair.files[role];
assert(pair.profile === 'private-production-root-v1' && pair.publicationApproved === false && pair.productionDeployable === false);
assert(pair.review.origin === rootOrigin);
const worker = role === 'rollback' ? '/assets/browserWorker-EkFyhckN.js' : '/' + pair.worker;
const wasm = role === 'rollback' ? '/wasm/certified_solver.88553a72d8503d2c7c78366e3d85bbee0cd9dfd738ac94d588fb09bd9d5942ae.wasm' : `/wasm/service-fused-h14-${pair.review.nativeWasmSha256}.wasm`;
assert(/^\/assets\/browserWorker-[\w-]{8}\.js$/.test(worker) && files[worker] && files[wasm]);
const trace = rootOrigin + '/cdn-cgi/trace', reads = new Set(['/api/forecast','/api/forecast/version','/api/calendar','/api/joint-supply/v2']);
const docs = new Map();
for (const locale of ['', 'en/', 'ja/']) for (const leaf of ['', 'privacy', 'terms', 'licenses']) {
  const path = `/${locale}${leaf}`, pin = files[path + (leaf ? '.html' : 'index.html')];
  assert(pin && pin.bytes > 0 && pin.bytes <= 512 * 1024);
  docs.set(path,{pin});
}
const endpoint = process.env.ROOT_REGIONAL_BROWSER;
const browser = endpoint
  ? await chromium.connect(endpoint, {timeout:15000}).catch(() => { throw Error('enrolled regional browser unavailable'); })
  : await chromium.launch({args:['--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE nikkecollection.com']});
const rows = [], resources = [], previews=[], errors = [];
const key=process.env.ROOT_EGRESS_NONCE || randomBytes(32).toString('hex');
try {
  if (endpoint) {
    const pkg = createRequire(import.meta.resolve('@playwright/test')).resolve('playwright/package.json');
    const registry = JSON.parse(readFileSync(join(dirname(createRequire(pkg).resolve('playwright-core/package.json')),'browsers.json')));
    assert.equal(browser.version(), registry.browsers.find(b => b.name === 'chromium').browserVersion);
  }
  const ctx = await browser.newContext({serviceWorkers:'block'}), cdp = await browser.newBrowserCDPSession();
  const tracePage = await ctx.newPage(), page = await ctx.newPage(); let egress, activePath, beaconAttempts = 0;
  await ctx.routeWebSocket('**/*', socket => { errors.push('unexpected WebSocket (blocked)'); socket.close(); });
  await ctx.route('**/*', route => {
    const req = route.request(), u = new URL(req.url());
    if (req.method() !== 'GET') errors.push('unexpected non-GET (blocked)');
    else if (u.href === trace && req.isNavigationRequest() && req.frame() === tracePage.mainFrame()) return route.continue();
    else if (u.origin === rootOrigin && !u.search && (u.pathname === activePath || Object.hasOwn(files,u.pathname) || reads.has(u.pathname) || (activePath?.startsWith('/preview/') && u.pathname.startsWith('/preview/')))) return route.continue();
    else if (u.href === (proof?.url ?? beaconURL) && req.resourceType() === 'script') beaconAttempts++;
    else if (!(u.origin === 'https://cdn.jsdelivr.net' && u.pathname.startsWith('/gh/orioncactus/pretendard@v1.3.9/dist/'))) errors.push('unexpected GET destination (blocked)');
    return route.abort(); // Do not download/execute the third-party script or send a single RUM event.
  });
  const classify = async (tab=tracePage) => {
    const r = await tab.goto(trace); assert(r && r.url() === trace && r.status() === 200 && !r.request().redirectedFrom());
    assert(r.headers()['content-type']?.split(';')[0] === 'text/plain');
    return traceIdentity(await r.text(),key);
  };
  const network=await classify(); egress=network.egress;
  // APIRequestContext is owned by the remote Playwright context. Compare its actual edge trace, not runner labels.
  const raw=await browser.newContext({serviceWorkers:'block',userAgent:'node'});
  const rawRead=async(url,type)=>{
    const r=await raw.request.get(url,{maxRedirects:0,maxRetries:2,timeout:12000,headers:{accept:'*/*','cache-control':'no-cache'}});
    try {assert(r.status()===200 && r.url()===url && r.headers()['content-type']?.split(';')[0]===type);return await r.body();}
    finally {await r.dispose();}
  };
  const rawIdentity=async()=>traceIdentity((await rawRead(trace,'text/plain')).toString('utf8'),key);
  try {
    assert.deepEqual(await rawIdentity(),network,'raw/browser egress mismatch');
    if(!previewOnly) for(const [path,doc] of docs) {doc.original=await rawRead(rootOrigin+path,'text/html');assertPin(doc.original,doc.pin);}
    assert.deepEqual(await rawIdentity(),network,'raw runner changed');
  } finally { await raw.close(); }
  if (endpoint) assert.equal(egress,process.env.ROOT_EXPECTED_EGRESS);
  // Browser-level Fetch pauses the ORIGINAL response, including dedicated-worker targets, before consumption/teardown.
  // No Network.loadNetworkResource, second GET, route.fulfill, replacement or reinterpretation of executed bytes.
  cdp.on('Fetch.requestPaused', async ({requestId, request, responseStatusCode, responseHeaders}) => {
    try {
      const u = new URL(request.url); assert(u.origin === rootOrigin && !u.search && request.method === 'GET' && responseStatusCode === 200);
      const mime = responseHeaders.find(h => h.name.toLowerCase() === 'content-type')?.value.split(';')[0];
      const {body, base64Encoded} = await cdp.send('Fetch.getResponseBody', {requestId});
      assert(base64Encoded === true, 'opaque original response bytes required');
      const b = Buffer.from(body, 'base64'), digest = hash('sha256', b);
      if (docs.has(u.pathname)) {
        assert(u.pathname === activePath && mime === 'text/html'); const {original,pin} = docs.get(activePath);
        verifyRootDocument(original, pin, b, egress, tag); rows.push({path:activePath, bytes:b.length, originSha256:pin.sha256, browserSha256:digest});
      } else {
        assert((u.pathname === worker && ['text/javascript','application/javascript'].includes(mime)) || (u.pathname === wasm && mime === 'application/wasm'));
        assertPin(b, files[u.pathname]); resources.push({path:u.pathname, bytes:b.length, sha256:digest});
      }
      await cdp.send('Fetch.continueResponse', {requestId});
    } catch (e) { errors.push(e.message); await cdp.send('Fetch.failRequest', {requestId,errorReason:'BlockedByClient'}).catch(() => {}); }
  });
  await cdp.send('Fetch.enable', {patterns:[...docs.keys()].map(path => ({urlPattern:rootOrigin+path, resourceType:'Document', requestStage:'Response'})).concat(
    ['*/assets/browserWorker-*.js','*.wasm'].map(urlPattern => ({urlPattern,requestStage:'Response'})))});
  page.on('pageerror', () => errors.push('uncaught page error'));
  if (!previewOnly) for (const path of docs.keys()) {
    activePath = path; const prior = beaconAttempts, count = rows.length;
    const r = await page.goto(rootOrigin + path); assert(r && r.status() === 200 && r.url() === rootOrigin + path && !r.request().redirectedFrom());
    assert(rows.length === count + 1 && rows.at(-1).path === path, 'missing original document response');
    assert.equal(await page.locator('script[data-cf-beacon]').count(), egress === 'EU' ? 0 : 1);
    assert.equal(beaconAttempts - prior, egress === 'EU' ? 0 : 1, 'unexpected number of beacon loads (blocked)');
    if (path.endsWith('/')) {
      const lang = path.split('/')[1] || 'ko'; await expect(page.locator('html')).toHaveAttribute('lang',lang);
      await expect(page.locator('#calculateButton')).toBeVisible();
    }
    if (path === '/') {
      await page.locator('[data-grade="R"]').click(); await page.locator('[data-level="14"]').click();
      for (const [k,v] of Object.entries({currentExp:800, blueStock:0, purpleStock:0, yellowStock:30})) {
        await page.locator('#'+k).fill(String(v)); await page.locator('#'+k).blur();
      }
      await page.locator('#calculateButton').click(); await expect(page.locator('#calculateButton')).toBeEnabled({timeout:40000});
      if (role === 'rollback') await expect(page.getByTestId('waiting-metric')).toContainText('대기 비교 미완료',{timeout:40000});
      else { const result = page.getByTestId('preview-verification'); await expect(result).toContainText('D0–D14',{timeout:40000}); await expect(result).toContainText('production-conditional-'); }
      for (const url of [worker,wasm]) assert(resources.some(r => r.path === url), 'missing actual lazy response');
    }
    assert.deepEqual(errors,[]);
  }
  await cdp.send('Fetch.disable'); // Preview is a separately pinned route, not the active root runtime.
  for(const path of ['/preview/','/preview/en/','/preview/ja/']) {
    activePath=path; const prior=beaconAttempts, response=await page.goto(rootOrigin+path);
    assert(response && response.status()===200 && response.url()===rootOrigin+path && !response.request().redirectedFrom());
    await expect(page.locator('#calculateButton')).toBeVisible(); assert.equal(await page.locator('script[data-cf-beacon]').count(),0);
    const bytes=await response.body(), headers=response.headers();
    await page.goto('about:blank'); checkPreview(bytes,headers['cache-control'],headers['content-security-policy'],beaconAttempts-prior);
    previews.push({path,sha256:hash('sha256',bytes),cache:headers['cache-control'],csp:headers['content-security-policy']});
  }
  assert.deepEqual(await classify(),network,'browser egress changed'); await ctx.close(); assert.deepEqual(errors,[]);
  console.log(JSON.stringify({scope:'single-vantage-readback-not-authorization',mode,role,source:pair.review.source,packetSha256:hash('sha256',packetBytes),observedAt:new Date().toISOString(),egress,egressId:network.id,rows,resources,previews}));
} finally { await browser.close(); }
