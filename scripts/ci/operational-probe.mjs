import { createServer } from 'node:http';
import { connect } from 'node:net';
import { Resolver } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import { readFile, readlink, writeFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { requireContainmentEvidence } from './operational-admission.mjs';
import { fail } from './operational-policy.mjs';
import { PRODUCER_UID } from './operational-storage.mjs';

export function networkObservation({ interfaces, route4, route6, mounts, namespace, hostNamespace }) {
  const devices = [...new Set(Object.keys(interfaces))].sort();
  const v4 = route4.trim().split('\n').slice(1).filter(Boolean);
  const v6 = route6.trim().split('\n').filter(Boolean);
  const nonLoopbackRoutes = v4.filter(row => row.trim().split(/\s+/)[0] !== 'lo').length +
    v6.filter(row => row.trim().split(/\s+/).at(-1) !== 'lo').length;
  const records = mounts.trim().split('\n').map(line => {
    const [left, right] = line.split(' - ');
    if (!right) fail();
    const fields = left.split(' ');
    return { path: fields[4], options: fields[5].split(','), fs: right.split(' ')[0] };
  });
  const unsafeMounts = records.filter(m => /docker\.sock|containerd\.sock|\/run\/(?:user|docker|podman)/.test(m.path) ||
    (['/source', '/provision'].includes(m.path) && !m.options.includes('ro'))).length;
  for (const path of ['/source', '/provision', '/work', '/tmp', '/dev/shm']) {
    const m = records.find(record => record.path === path);
    if (!m || (['/work', '/tmp', '/dev/shm'].includes(path) && m.fs !== 'tmpfs')) fail();
  }
  return { interfaces: devices, namespace, hostNamespace, nonLoopbackRoutes, unsafeMounts };
}
async function tcp(host) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port: 80 });
    socket.setTimeout(1500);
    socket.once('connect', () => { socket.destroy(); reject(new Error('ADMISSION_BLOCKED')); });
    socket.once('timeout', () => { socket.destroy(); resolve(); });
    socket.once('error', error => {
      socket.destroy();
      if (!['ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'EADDRNOTAVAIL'].includes(error.code)) reject(error);
      else resolve();
    });
  });
}
export async function assertSandboxProcesses() {
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const args = await readFile(`/proc/${pid}/cmdline`, 'utf8');
      if (args.split('\0').includes('--no-sandbox')) fail();
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
export async function runProbes() {
  if (process.platform !== 'linux' || process.getuid() !== PRODUCER_UID) fail();
  const nonce = process.env.OPERATIONAL_NONCE;
  const observation = networkObservation({
    interfaces: networkInterfaces(), route4: await readFile('/proc/net/route', 'utf8'),
    route6: await readFile('/proc/net/ipv6_route', 'utf8'),
    mounts: await readFile('/proc/self/mountinfo', 'utf8'),
    namespace: await readlink('/proc/self/ns/net'), hostNamespace: process.env.OPERATIONAL_HOST_NAMESPACE,
  });
  if (observation.interfaces.join(',') !== 'lo' || observation.nonLoopbackRoutes ||
      observation.unsafeMounts || observation.namespace === observation.hostNamespace) fail();
  const attempts = [];
  const record = (engine, kind) => attempts.push({ engine, kind, transport: 'native',
    outcome: kind === 'loopback' ? 'connected' : 'blocked' });
  const server = createServer((_request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*'); response.end(nonce);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser, worker;
  try {
    if (await (await fetch(origin, { signal: AbortSignal.timeout(3000) })).text() !== nonce) fail();
    record('node', 'loopback');
    for (const [kind, address] of [['ipv4', '192.0.2.1'], ['ipv6', '2001:db8::1'], ['direct', '198.51.100.1']]) {
      await tcp(address); record('node', kind);
    }
    const resolver = new Resolver({ timeout: 1000, tries: 1 });
    resolver.setServers(['192.0.2.53']);
    try { await resolver.resolve4(`${nonce}.invalid`); fail(); }
    catch (error) {
      if (!['ETIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'ENETUNREACH'].includes(error.code)) throw error;
    } finally { resolver.cancel(); }
    record('node', 'dns');
    const { chromium } = await import(pathToFileURL('/work/repo/node_modules/playwright/index.mjs').href);
    browser = await chromium.launch({ headless: true, chromiumSandbox: true });
    const page = await browser.newPage({ serviceWorkers: 'block' });
    if (await (await page.goto(origin)).text() !== nonce) fail();
    record('browser', 'loopback');
    const targets = [['ipv4', 'http://192.0.2.1'], ['ipv6', 'http://[2001:db8::1]'],
      ['direct', 'http://198.51.100.1'], ['dns', `http://${nonce}.invalid`]];
    for (const [kind, target] of targets) {
      try { await page.goto(target, { timeout: 2500 }); fail(); }
      catch (error) {
        if (!/net::ERR_(?:ADDRESS_UNREACHABLE|NETWORK_ACCESS_DENIED|NAME_NOT_RESOLVED|CONNECTION_TIMED_OUT)|Timeout 2500ms/.test(error.message)) throw error;
      }
      record('browser', kind);
    }
    await assertSandboxProcesses();
    await browser.close(); browser = undefined;
    const { Miniflare } = await import(pathToFileURL('/work/repo/node_modules/miniflare/dist/src/index.js').href);
    worker = new Miniflare({
      host: '127.0.0.1', port: 0, cf: false, telemetry: { enabled: false },
      logRequests: false, unsafeRuntimeEnv: {}, unsafeLocalExplorer: false, unsafeObservability: false,
      resourceTmpPath: '/home/node/results/probe-worker',
      workers: [{
        config: {
          name: 'operational-transport', compatibilityDate: '2026-10-13',
          workersDev: false, previewUrls: false, observability: { enabled: false },
          manifest: { mainModule: 'probe.js', modulesRoot: '/work/repo',
            modules: { 'probe.js': { type: 'esm', contents:
              `export default {async fetch(r,e) { const u=new URL(r.url).searchParams.get("u");
                try {const p=await e.NET.fetch(u,{signal:AbortSignal.timeout(2000)});
                  return new Response("connected:"+await p.text());}
                catch {return new Response("blocked");}}}` } } },
          env: { NET: { type: 'network', allow: ['public', 'private'] } },
        },
        dev: { rootPath: '/work/repo', unsafeRegisterWorker: false },
      }],
    });
    const local = await worker.ready;
    const workerFetch = async target => (await fetch(`${local.origin}/?u=${encodeURIComponent(target)}`,
      { signal: AbortSignal.timeout(4000) })).text();
    if (await workerFetch(origin) !== `connected:${nonce}`) fail();
    record('worker', 'loopback');
    for (const [kind, target] of targets) {
      if (await workerFetch(target) !== 'blocked') fail();
      record('worker', kind);
    }
    const evidence = { nonce, ...observation, attempts };
    requireContainmentEvidence(evidence, nonce);
    await writeFile('/home/node/results/containment.json', JSON.stringify(evidence), { flag: 'wx', mode: 0o600 });
  } finally {
    await browser?.close(); await worker?.dispose();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runProbes().catch(() => { process.exitCode = 1; });
}
