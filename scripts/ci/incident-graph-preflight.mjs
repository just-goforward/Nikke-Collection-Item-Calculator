import {readFileSync} from 'node:fs';
import {client, graph, recoveryGraph, immutable, requireThat, root} from './incident-provider.mjs';
import {gh, repo, graphEnv, verifyHistorical} from './incident-receipt.mjs';
import {recoveryMode} from './incident-recovery-id.mjs';

// Informational only. No writable provider capability, journal or install receipt.
try {
  const mode = process.argv[2];
  requireThat(!process.stdin.isTTY && (process.argv.length === 2 || (process.argv.length === 3 && mode === recoveryMode)), 'supply credential on redirected stdin');
  const expected = process.env.INCIDENT_GRAPH_TOKEN_ID;
  requireThat(typeof expected === 'string' && immutable.test(expected), 'expected reader ID missing');
  if (mode === recoveryMode) {
    requireThat(expected === gh('variable','get','INCIDENT_GRAPH_TOKEN_ID','--env',graphEnv,'--repo',repo),'not the enrolled reader');
    verifyHistorical();
  }
  const cf = client(readFileSync(0,'utf8').replace(/\r?\n$/, ''));
  const identity = await cf(`${root}/tokens/verify`);
  requireThat(identity.status === 'active' && identity.id === expected, 'reader identity mismatch');
  let gets = 0;
  const read = async path => { gets++; return cf(path); };
  if (mode === recoveryMode) {
    const graphDigest = await recoveryGraph(read);
    console.log(JSON.stringify({schema:1,mode,readerIdEqual:true,graphDigest,graphGets:gets}));
  } else {
    await graph(read);
    console.log(JSON.stringify({schema:1,readerIdEqual:true,graphEqual:true,graphGets:gets}));
  }
} catch {
  console.error('Graph preflight failed; no install receipt or write. Preserve the reservation. Deletion/recreation requires separate owner consent.');
  process.exitCode = 1;
}
