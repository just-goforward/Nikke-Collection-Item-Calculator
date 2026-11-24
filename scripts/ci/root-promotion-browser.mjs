import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { hash } from 'node:crypto';

// Each required TLS endpoint is enrolled in the protected direction grant.
export function regionalBrowsers(grant, env) {
  const hosts = new Set();
  const classes = grant.euAssurance === 'config-substitute-v1' ? ['non-EU'] : ['EU','non-EU'];
  assert(['config-substitute-v1','two-region-v1'].includes(grant.euAssurance), 'explicit EU policy required');
  assert.deepEqual(Object.keys(grant.regionalBrowsers).sort(), classes);
  return classes.map(egress => {
    const endpoint = env[egress === 'EU' ? 'ROOT_BROWSER_EU' : 'ROOT_BROWSER_NON_EU'];
    assert(typeof endpoint === 'string' && URL.canParse(endpoint), 'missing enrolled browser');
    const u = new URL(endpoint);
    assert(u.protocol === 'wss:' && !u.username && !u.password && !u.hash && !hosts.has(u.hostname), 'invalid or duplicate browser origin');
    hosts.add(u.hostname);
    const pin = hash('sha256', endpoint);
    assert(pin === grant.regionalBrowsers?.[egress], 'independent regional browser enrollment required');
    return {egress,endpoint,pin};
  });
}

export function witnessPair(browsers, packet, source, packetSha256, role, mode, cwd, cleanEnv) {
  return browsers.map(({egress,endpoint,pin}) => {
    let bytes;
    try {
      bytes = execFileSync(process.execPath, ['scripts/ci/root-rum-witness.mjs',packet,role,mode], {
        cwd, env:{...cleanEnv,ROOT_REGIONAL_BROWSER:endpoint,ROOT_EXPECTED_EGRESS:egress},
        stdio:['ignore','pipe','pipe'],timeout:180000,maxBuffer:256*1024,
      });
    } catch { throw Error(`Regional browser check failed: ${egress} ${role} ${mode}`); }
    const report = JSON.parse(bytes);
    assert.equal(report.egress,egress); assert.equal(report.source,source); assert.equal(report.role,role);
    assert(mode==='full' || mode==='restore-preflight' && role==='forward');assert.equal(report.mode,mode);
    assert.equal(report.packetSha256,packetSha256); assert.equal(report.rows.length,mode==='full'?12:0); assert.equal(report.previews.length,3); assert.match(report.egressId,/^[0-9a-f]{64}$/);
    return {runnerSha256:pin,mode,...report};
  });
}
