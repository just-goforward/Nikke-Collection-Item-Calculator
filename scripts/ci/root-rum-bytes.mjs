import assert from 'node:assert/strict';
import { createHmac, hash } from 'node:crypto';
import { isIP } from 'node:net';

export const rootOrigin = 'https://nikkecollection.com';
export const beaconURL = 'https://static.cloudflareinsights.com/beacon.min.js/vce701823e78c4301a35b7e07294d87301792088814092';
// Forward and bridge always use the source pin. Restore may use only an independently reviewed exact replacement.
const beacon = Buffer.from(`<script type="module" src="${beaconURL}" integrity="sha512-UKNk8GbxkABxKcXYuLkO16EleLGUkcvJWtpSNmExE0Too3ZaFAxTscNWEc1OdAv5/BikHawapSCaiD2XCmp+Bw==" data-cf-beacon='{"version":"2024.11.0","token":"af412f42bf1145eea47507d378249625","r":1,"spa":2}' crossorigin="anonymous"></script>\n`);
export function restoreBeacon(proof) {
  assert.deepEqual(Object.keys(proof).sort(),['configSha256','evidenceSha256','integrity','observedAt','tagSha256','url','version']);
  assert.match(proof.evidenceSha256,/^[a-f0-9]{64}$/);assert(Number.isSafeInteger(proof.observedAt) && proof.observedAt>0);
  assert.match(proof.configSha256,/^[a-f0-9]{64}$/);
  assert.match(proof.url,/^https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/v[a-f0-9]{32,80}$/);
  assert.match(proof.version,/^20[0-9]{2}\.[0-9]{1,2}\.[0-9]{1,3}$/);
  assert.match(proof.integrity,/^sha512-[A-Za-z0-9+/]{86}==$/);
  assert.equal(Buffer.from(proof.integrity.slice(7),'base64').toString('base64'),proof.integrity.slice(7));
  const tag=Buffer.from(`<script type="module" src="${proof.url}" integrity="${proof.integrity}" data-cf-beacon='{"version":"${proof.version}","token":"af412f42bf1145eea47507d378249625","r":1,"spa":2}' crossorigin="anonymous"></script>\n`);
  assert.equal(hash('sha256',tag),proof.tagSha256,'reviewed tag bytes required');
  return tag;
}
const suffix = Buffer.from('</body>\n</html>\n');
// These are forbidden byte sequences anywhere in the document, not a URL/hostname allowlist.
const beaconAttribute=Buffer.from('data-cf-beacon'), beaconDomain=Buffer.from('cloudflareinsights.com');
const hasBeaconMarker=bytes=>bytes.includes(beaconAttribute) || bytes.includes(beaconDomain);
const eu = new Set('AT BE BG HR CY CZ DE DK EE ES FI FR GR HU IE IT LT LU LV MT NL PL PT RO SE SI SK'.split(' '));
// Only explicitly recognized test egresses. Unknown/other/Tor must not become a non-EU authorization.
const nonEU = new Set(['KR', 'US']);
export function traceClass(text, now = Date.now()) {
  // Never include the raw trace, IP or other values in assertion messages, logs or receipts.
  function field(name) {
    const rows = text.split('\n').filter(s => s.startsWith(name + '='));
    assert(rows.length === 1, 'ambiguous/missing edge trace field');
    return rows[0].slice(name.length + 1);
  }
  assert(field('h') === 'nikkecollection.com' && field('visit_scheme') === 'https', 'wrong trace origin');
  assert(['warp','gateway','rbi'].every(k => field(k) === 'off'), 'non-direct trace');
  const ts = field('ts');
  assert(/^\d{10}(?:\.\d+)?$/.test(ts) && Math.abs(Number(ts) * 1000 - now) <= 30_000, 'stale edge trace');
  const loc = field('loc');
  if (eu.has(loc)) return 'EU';
  assert(nonEU.has(loc), 'unreviewed/unknown browser egress');
  return 'non-EU';
}
// A random per-transition key permits equality checks without recording the IP, country or a reusable identifier.
export function traceIdentity(body,key,now=Date.now()) {
  const egress=traceClass(body,now);
  const field=name=>{const xs=body.split('\n').filter(line=>line.startsWith(name+'='));assert(xs.length===1,'ambiguous egress');return xs[0].slice(name.length+1);};
  const ip=field('ip');assert(isIP(ip),'missing direct edge identity');
  return {egress,id:createHmac('sha256',key).update(JSON.stringify([ip,field('loc')])).digest('hex')};
}
export function checkPreview(bytes,cache,csp,attempts) {
  const directives=cache.toLowerCase().split(',').map(x=>x.trim());
  assert(directives.includes('no-store') && directives.includes('no-transform') && typeof csp==='string' && csp.includes('/preview/'),'preview no-transform/CSP missing');
  assert(!hasBeaconMarker(bytes) && attempts===0,'preview RUM leakage');
}
export function assertPin(bytes, pin) {
  assert(pin && Number.isSafeInteger(pin.bytes) && pin.bytes > 0 && /^[0-9a-f]{64}$/.test(pin.sha256), 'missing or invalid pin');
  assert(bytes.length === pin.bytes && hash('sha256', bytes) === pin.sha256, 'bytes differ from sealed pin');
}
export function verifyRootDocument(original, pin, observed, egress, tag=beacon) {
  assertPin(original, pin);
  const pos = original.length - suffix.length;
  assert(pos >= 0 && original.indexOf('</body>') === pos && original.subarray(pos).equals(suffix), 'unreviewed document insertion point');
  assert(!hasBeaconMarker(original), 'origin already embeds a beacon');
  if (egress === 'EU') return assertPin(observed, pin);
  assert(egress === 'non-EU', 'independent egress classification required');
  assert(observed.length === original.length + tag.length &&
    observed.subarray(0, pos).equals(original.subarray(0, pos)) &&
    observed.subarray(pos, pos + tag.length).equals(tag) &&
    observed.subarray(pos + tag.length).equals(suffix), 'unexpected non-EU document bytes');
}
