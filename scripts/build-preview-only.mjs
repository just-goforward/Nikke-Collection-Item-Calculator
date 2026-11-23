import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_LOCALES } from '../shared/siteLocales.ts';
import trust from '../preview-gateway/trust.json' with { type: 'json' };
import { portablePath,portablePins } from '../src/serviceH14/portablePins.ts';
import legacy from '../site-worker/production-forecast.proposed.json' with {type:'json'};

// This command has no deployment capability. It imports only public trust bytes.
const root = fileURLToPath(new URL('../', import.meta.url));
assert.equal(resolve(process.cwd()), resolve(root));
assert.equal(process.version, 'v26.13.1');
assert.equal(process.argv.length, 3, 'pass independently generated candidate identity receipt; trust is pinned in source');
const expected=JSON.parse(await readFile(process.argv[2],'utf8'));
const synthetic = trust.keyId === 'adaptive-smoke-ephemeral';
if (!synthetic) assert.deepEqual(trust, {environment:'staging',channel:'timed-v1',
  keyId:'preview-collected-timed-v1',publicKeyBase64:'vcdhuMhEy5YvAeBe623ptckFODhwZJc+qdOLWOFJczQ='});
const run = await mkdtemp(join(root, '.artifacts/service-h14-run.'));
const build = join(run, 'build');
const output = join(run, 'dist-preview');
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, SERVICE_H14_RUN: run,
  GITHUB_SHA: 'e9379b92-preview', VITE_SERVICE_CERTIFIED_SOLVER: 'true', VITE_FORECAST_RUNTIME: 'staging',
  VITE_PREVIEW_LEGACY_D0: 'true', VITE_FORECAST_PUBLIC_KEY_ID: legacy.keyId, VITE_FORECAST_PUBLIC_KEY_BASE64: legacy.publicKeyBase64,
  VITE_FORECAST_TIMED_V1_PUBLIC_KEY_ID: trust.keyId, VITE_FORECAST_TIMED_V1_PUBLIC_KEY_BASE64: trust.publicKeyBase64,
};
function invoke(args) {
  const child = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  if (child.error) throw child.error;
  if (child.status !== 0) throw Error(child.stdout + child.stderr);
  return child.stdout;
}
const identity = JSON.parse(invoke(['scripts/service-h14-build.ts', '--identity']));
assert.equal(expected.status,'NONDEPLOYABLE_SERVICE_CANDIDATE');
assert.equal(expected.policy,'adaptive-next-batch-balanced-v1');
assert.equal(identity.policy,expected.policy);
assert.equal(identity.codeHash,expected.codeHash);
const wasmHash = expected.exactWasmHash;
assert.equal(wasmHash,'9d1f05f5bfee2b2e317c778741aedbaab179f1897a645770d9854d3bc6be8bc5');
assert.equal(identity.nativeSourceHash,expected.nativeSourceHash);
assert.equal(identity.exactWasmHash, wasmHash);
await writeFile(join(run, 'vite.log'), invoke(['node_modules/vite/bin/vite.js', 'build', '--configLoader', 'native', '--outDir', build]));
const runtime = JSON.parse(await readFile(join(build,'.vite/forecast-runtime.json')));
assert.equal(runtime.mode,'staging');
assert.deepEqual(runtime.timedV1, { keyId: trust.keyId, publicKeyBase64: trust.publicKeyBase64 });
assert.equal(runtime.keyId,'production-v1'); assert.equal(runtime.publicKeyBase64,legacy.publicKeyBase64);
const graph = JSON.parse(await readFile(join(build,'.vite/worker-boundary/src_serviceH14_browserWorker.ts.json')));
for(const path of ['workerHandler','controller','source','aggregate','fusedEndpoint','adaptiveSource','adaptiveDecision','binding'])assert(graph.modules.includes(`src/serviceH14/${path}.ts`),`candidate Worker graph missing ${path}`);
for(const name of ['forecastRead','runtimeForecastConfig','certifiedForecastTrust'])assert(graph.modules.includes(`src/lib/${name}.ts`),`candidate Worker trust graph missing ${name}`);
// Vite emits the legacy Worker during source transformation of a module whose
// shared error class is used; its Worker constructor is subsequently tree-shaken.
// Refuse the package if any executable in the actual output refers to that file.
const emitted = await readdir(join(build,'assets'));
const orphans = emitted.filter(name=>/^worker-[\w-]+\.js$/.test(name));
const assets = emitted.filter(name=>!orphans.includes(name));
for (const file of ['index.html', ...assets.map(name=>`assets/${name}`)]) {
  const text = await readFile(join(build,file),'utf8');
  for (const orphan of orphans) assert(!text.includes(orphan),`legacy Worker reachable from ${file}`);
}
assert.deepEqual(assets.filter(s=>/^(?:browserWorker-|worker-)/.test(s)),[graph.entryFile.slice('assets/'.length)]);
assert(!assets.some(s=>/^(?:AccountEntry-|CertifiedCalculator-)/.test(s)));
// Package the complete original unicode-range map, not only the subsets used by today's UI.
const fontFiles = [];
for (const { fontStylesheet } of Object.values(SITE_LOCALES)) {
  assert(fontStylesheet.startsWith('/preview/fonts/'));
  const sheet = fontStylesheet.slice('/preview/'.length), directory = dirname(sheet);
  const css = await readFile(join(build, sheet), 'utf8');
  const urls = [...css.matchAll(/url\(([^)]+)\)/g)];
  assert(urls.length > 0, `No web fonts in ${sheet}`);
  fontFiles.push(sheet, join(directory, 'LICENSE.txt'));
  for (const [, url] of urls) {
    assert(/^\.\/woff2-dynamic-subset\/Pretendard(?:Std|JP)?Variable\.subset\.\d+\.woff2$/.test(url), `Unexpected font URL: ${url}`);
    fontFiles.push(join(directory, url));
  }
}
const files = [ ...assets.map(s=>`assets/${s}`), ...['','en/','ja/'].flatMap(dir=>['index','privacy','terms','licenses'].map(page=>`${dir}${page}.html`)),
  ...['ko','en','ja'].map(locale=>`og/collection-calculator-${locale}.png`),...fontFiles,'favicon-32.png','icon-192.png','third-party-licenses.md',
  `wasm/service-fused-h14-${wasmHash}.wasm`, ...portablePins.map(portablePath) ];
const manifest = {};
// Own a fresh output directory. A partial tree has no verified receipt.
await mkdir(output);
for (const file of [...new Set(files)].sort()) {
  const src = join(build,file), dest = join(output,'preview',file);
  const data = await readFile(src), sha256 = createHash('sha256').update(data).digest('hex');
  if (file.endsWith('.wasm')) assert.equal(sha256, wasmHash);
  if(file.endsWith('.bin'))assert.equal(sha256,portablePins.find(pin=>portablePath(pin)===file)?.sha256);
  await mkdir(dirname(dest),{recursive:true});
  await writeFile(dest,data,{flag:'wx'});
  manifest[`/preview/${file}`] = { bytes:data.length, sha256 };
}
// Verify the paths the browser will read after every file is in place.
for (const [path,expectedFile] of Object.entries(manifest)) {
  const bytes = await readFile(join(output,path));
  assert.equal(bytes.length,expectedFile.bytes,path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),expectedFile.sha256,path);
}
const receipt = { baseCommit:'e9379b92d6ab18d91b0ab46fb59cbd8048660c7a',scope:'/preview/',environment:'staging',syntheticForecast:synthetic,
  publication:synthetic?'local-disposable-signature-only':'collected-preview-only', calendarRead:'/preview/api/collected-calendar', timedRead:'/preview/api/collected-forecast/timed-v1', runtime,
  conditionalJoint:{read:'/preview/api/joint-supply/v2',domain:'nikke.preview.conditional-joint-supply.v2',status:'partial',solverAuthority:'scoped-model-only'},
  conditionalSupply:{read:'/preview/api/supply',domain:'nikke.preview.conditional-supply.v1',solverAuthority:false},
  currentOnly:{environment:'production',channel:'legacy',keyId:legacy.keyId,publicKeyBase64:legacy.publicKeyBase64,read:'/preview/api/current-forecast/legacy'},
  policy:identity.policy,serviceCodeHash:identity.codeHash,nativeWasmSha256:wasmHash,worker:graph.entryFile, files:manifest, output, run };
await writeFile(join(run,'preview-assets.json'),JSON.stringify(receipt,null,2),{flag:'wx'});
console.log(JSON.stringify({output,receipt:join(run,'preview-assets.json'),count:Object.keys(manifest).length,serviceCodeHash:identity.codeHash}));
