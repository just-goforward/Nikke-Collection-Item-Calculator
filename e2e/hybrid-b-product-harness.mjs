import assert from 'node:assert/strict';
import { createPublicKey, hash, verify } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { extname, join } from 'node:path';
import legacy from '../site-worker/production-forecast.proposed.json' with { type: 'json' };
import {controlFromCustody,supplyProjectionSha256} from '../scripts/ci/hybrid-b-policy-evidence.mjs';

export const origin = 'https://nikkecollection.com';
const api = new Set(['/api/forecast', '/api/forecast/version', '/api/joint-supply/v2']);
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.html': 'text/html',
  '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png' };
const key = base64 => createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(base64, 'base64').toString('base64url') } });

// No browser headers, visitor credentials, query strings, redirects, writes or arbitrary upstreams.
export async function signedGet(path, review, corrupt, heads) {
  assert(api.has(path));
  const start = Date.now();
  const response = await fetch(origin + path, { redirect: 'error', credentials: 'omit', cache: 'no-store',
    headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(8000) });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  let size = 0; const chunks = [];
  for await (const bytes of response.body) { size += bytes.length; assert(size <= 524288); chunks.push(bytes); }
  const body = Buffer.concat(chunks), envelope = JSON.parse(body), now = Date.now();
  assert(Number.isSafeInteger(envelope.remainingMs) && envelope.remainingMs > now - start && envelope.remainingMs <= 60000);
  const joint = path === '/api/joint-supply/v2', wire = joint ? envelope : envelope.pointer;
  const signer = key(joint ? review.publicKeyBase64 : legacy.publicKeyBase64), signature = Buffer.from(wire.signature, 'base64');
  assert(verify(null, Buffer.from(wire.statement), signer, signature));
  const d = JSON.parse(wire.statement);
  assert.equal(d.environment, 'production'); assert.equal(d.keyId, joint ? review.keyId : legacy.keyId);
  assert.equal(d.domain, joint ? review.domain : 'nikke.forecast.pointer.v1');
  assert(Number.isSafeInteger(d.sequence) && d.sequence > 0);
  if (joint) {
    assert.equal(d.sequence, d.issuedAt); assert(d.issuedAt <= now && now < d.expiresAt && d.expiresAt - d.issuedAt <= 900000);
    assert.equal(d.version, 'certified-daily-v4');
    const control=controlFromCustody(review.source,process.env.ROOT_POLICY_PACKET_SHA256);
    assert.equal(supplyProjectionSha256(d),control.value.supplySha256,'live supply differs from preallocated oracle');
    if (corrupt) {
      signature[0] ^= 1; assert(!verify(null, Buffer.from(wire.statement), signer, signature));
      return Buffer.from(JSON.stringify({ ...envelope, signature: signature.toString('base64') }));
    }
    heads.set(hash('sha256', wire.statement), `production-conditional-${d.sequence}`);
  }
  return body;
}

/** @typedef {{ seen: Set<string>, heads: Map<string,string>, worker: string, wasm: string, assertClean(): void }} ProductNetwork */
/** @returns {Promise<ProductNetwork>} */
export async function productNetwork(context, { receipt, forward }, mode) {
  const worker = '/' + receipt.worker, wasm = `/wasm/service-fused-h14-${receipt.review.nativeWasmSha256}.wasm`;
  const seen = new Set(), heads = new Map(); let violations = 0;
  await context.routeWebSocket('**/*', socket => { violations++; socket.close(); });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    try {
      assert.equal(request.method(), 'GET'); assert.equal(url.origin, origin); assert(!url.search && !url.hash);
      assert(!url.username && !url.password);
      if (mode === 'stats-offline' && path === '/api/stats') { seen.add(path); return await route.abort('failed'); }
      if (api.has(path)) {
        const body = await signedGet(path, receipt.review, mode === 'bad-signature', heads);
        seen.add(path); return await route.fulfill({ body, contentType: 'application/json', headers: { 'cache-control': 'no-store' } });
      }
      const file = path.endsWith('/') ? path + 'index.html' : path;
      assert(Object.hasOwn(receipt.files.forward, file));
      if (file.startsWith('/wasm/')) assert.equal(file, wasm);
      if (/\/browserWorker-[\w-]+\.js$/.test(file)) assert.equal(file, worker);
      if (file === wasm && mode === 'missing-wasm') { seen.add(file); return await route.abort('failed'); }
      const absolute = join(forward, file); assert.equal(await realpath(absolute), absolute);
      const body = await readFile(absolute), pin = receipt.files.forward[file];
      assert.equal(body.length, pin.bytes); assert.equal(hash('sha256', body), pin.sha256);
      seen.add(file); await route.fulfill({ body, contentType: mime[extname(file)] ?? 'application/octet-stream' });
    } catch { violations++; await route.abort().catch(() => {}); }
  });
  return { seen, heads, worker, wasm, assertClean() { assert.equal(violations, 0, 'unexpected network request, invalid source or package byte'); } };
}

// Serialized by Playwright. Observe messages without changing, delaying or manufacturing solver results.
export function instrumentWorker(workerPath) {
  const audit = window.hybridProduct = { count: 0, requests: [], finals: [], forbidden: 0 };
  const forbid = () => { audit.forbidden++; throw new Error('prohibited browser capability'); };
  window.SharedWorker = class { constructor() { forbid(); } };
  window.EventSource = class { constructor() { forbid(); } };
  navigator.sendBeacon = forbid;
  navigator.serviceWorker.register = forbid;
  window.Worker = class extends window.Worker {
    constructor(source, options) {
      if (new URL(String(source), location.href).href !== location.origin + workerPath ||
          options?.name !== 'service-fused-h14-v1' || options?.type !== 'module') forbid();
      super(source, options); audit.count++;
      this.addEventListener('message', ({ data }) => {
        if (data?.type === 'result') audit.finals.push(data);
      });
    }
    postMessage(message, ...args) {
      if (message?.type === 'calculate') {
        const { id, generation, sessionId, inputSha256, forecastIdentity, input: { grade, level, exp, stock } } = message;
        audit.requests.push({ id, generation, sessionId, inputSha256, forecastIdentity, grade, level, exp, stock });
      }
      return super.postMessage(message, ...args);
    }
  };
}
