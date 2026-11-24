import assert from 'node:assert/strict';
import { hash } from 'node:crypto';
import test from 'node:test';
import { checkPreview, traceClass, traceIdentity, restoreBeacon, verifyRootDocument } from './root-rum-bytes.mjs';

// Test fixture only; never geographic or release evidence. Byte identity independently captured from v14.
const tag = `<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js/vce701823e78c4301a35b7e07294d87301792088814092" integrity="sha512-UKNk8GbxkABxKcXYuLkO16EleLGUkcvJWtpSNmExE0Too3ZaFAxTscNWEc1OdAv5/BikHawapSCaiD2XCmp+Bw==" data-cf-beacon='{"version":"2024.11.0","token":"af412f42bf1145eea47507d378249625","r":1,"spa":2}' crossorigin="anonymous"></script>\n`;
const head = '<!doctype html>\n<body>한글 日本語\n  ', tail = '</body>\n</html>\n', make = (s='') => Buffer.from(head+s+tail);
const raw = make(), wire = make(tag), pin = b => ({bytes:b.length,sha256:hash('sha256',b)});
const compare = (b, cohort) => verifyRootDocument(raw, pin(raw), b, cohort);
test('each observed egress admits one representation, never an either/or fallback', () => {
  assert.equal(Buffer.byteLength(tag),367); assert.equal(hash('sha256',tag),'5d0c86a333804956d238cc35a887ddf1883d511bbd521f0bff377ebef7b49ee6');
  compare(raw,'EU'); compare(wire,'non-EU');
  for (const [b,c] of [[raw,'non-EU'],[wire,'EU'],[raw,undefined],[wire,'unknown']]) assert.throws(()=>compare(b,c));
});
test('tag, position and all other bytes are inseparable; origin and roles cannot be substituted', () => {
  for (const b of [make(tag+tag), make(tag.trimEnd()), make(tag.replace('af412','af413')), make(tag.replace('sha512-U','sha512-V')),
    make(tag.replace('/beacon.min','/other.min')), make(tag.replace('"spa":2','"spa":1')), make(tag.replace('anonymous','use-credentials')),
    Buffer.from(tag+raw), Buffer.from(head+tail+tag), Buffer.concat([wire,Buffer.from('\n')]),
    Buffer.from(wire.toString().replace('日本語','日本国')), make(tag+'<script>evil()</script>')]) assert.throws(()=>compare(b,'non-EU'));
  for (const orig of [make(tag), make('</body>'), Buffer.from('<p>x</p>')]) assert.throws(()=>verifyRootDocument(orig,pin(orig),orig,'EU'));
  assert.throws(()=>verifyRootDocument(raw,pin(wire),wire,'non-EU')); assert.throws(()=>verifyRootDocument(raw,{...pin(raw),bytes:1},raw,'EU'));
});
test('only unique, fresh, direct and explicitly recognized Cloudflare trace values classify', () => {
  const t = 'h=nikkecollection.com\nvisit_scheme=https\nts=1795470000.000\nwarp=off\ngateway=off\nrbi=off\nloc=KR\n';
  const classify = s => traceClass(s,1795470000000);
  assert.equal(classify(t),'non-EU'); assert.equal(classify(t.replace('KR','DE')),'EU');
  for(const bad of [t+'loc=DE\n',t.replace('KR','XX'),t.replace('KR','T1'),t.replace('KR','ZZ'),t.replace('loc','country'),t.replace('https','http'),
    t.replace('nikkecollection.com','other.test'),t.replace('warp=off','warp=on'),t.replace('1795470000','1795469900')]) assert.throws(()=>classify(bad));
});
test('two allowed IPs or countries in the same class are not the same egress',()=>{
  const t='h=nikkecollection.com\nvisit_scheme=https\nts=1795470000\nwarp=off\ngateway=off\nrbi=off\nloc=KR\ncolo=ICN\nip=192.0.2.1\n';
  const sample=s=>traceIdentity(s,'fixture',1795470000000); for(const other of [t.replace('KR','US'),t.replace('2.1','2.2')]) assert.notDeepEqual(sample(t),sample(other));
  assert.deepEqual(sample(t),sample(t.replace('ICN','LAX')),'anycast colo is not the visitor identity');
  assert.throws(()=>sample(t+'ip=192.0.2.1\n')); assert.throws(()=>sample(t.replace('192.0.2.1','unknown')));
});
test('protected preview never permits an inserted tag, request, or missing no-transform',()=>{
  const cache='no-store, no-transform',csp="script-src https://nikkecollection.com/preview/";
  checkPreview(raw,cache,csp,0);for(const args of [[wire,cache,csp,0],[raw,cache,csp,1],[raw,'no-store',csp,0],[raw,cache,'',0]]) assert.throws(()=>checkPreview(...args));
  for(const marker of ['data-cf-beacon','cloudflareinsights.com','text: prefix-cloudflareinsights.com.example/suffix']){
    const bytes=make(marker);assert.throws(()=>checkPreview(bytes,cache,csp,0),/RUM leakage/);
    assert.throws(()=>verifyRootDocument(bytes,pin(bytes),bytes,'EU'),/already embeds/);
  }
});
test('rotated rollback representation is exact, does not change the default forward pin',()=>{
  const rotated=tag.replace('vce701823e78c4301a35b7e07294d87301792088814092','v'+'b'.repeat(40)).replace('2024.11.0','2026.11.1');
  const proof={url:rotated.match(/src="([^"]+)"/)[1],version:'2026.11.1',integrity:rotated.match(/integrity="([^"]+)"/)[1],tagSha256:hash('sha256',rotated),configSha256:'c'.repeat(64),evidenceSha256:'d'.repeat(64),observedAt:1};
  const approved=restoreBeacon(proof);verifyRootDocument(raw,pin(raw),make(rotated),'non-EU',approved);
  for(const body of [make(tag),make(rotated+rotated),make(rotated.replace('spa":2','spa":1')),Buffer.from(make(rotated).toString().replace('日本語','日本国'))])
    assert.throws(()=>verifyRootDocument(raw,pin(raw),body,'non-EU',approved));
  assert.throws(()=>compare(make(rotated),'non-EU'));assert.throws(()=>verifyRootDocument(raw,pin(raw),make(rotated),'EU',approved));
  for(const patch of [{url:proof.url+'?x'},{tagSha256:'0'.repeat(64)},{version:'x'},{extra:true}])assert.throws(()=>restoreBeacon({...proof,...patch}));
});
