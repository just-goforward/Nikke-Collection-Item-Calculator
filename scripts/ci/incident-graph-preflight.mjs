import {readFileSync} from 'node:fs';
import {client, graph, immutable, requireThat, root} from './incident-provider.mjs';

// No GitHub access, writable provider capability, files or install receipt.
try {
  requireThat(process.argv.length === 2 && !process.stdin.isTTY, 'supply credential on redirected stdin');
  const expected = process.env.INCIDENT_GRAPH_TOKEN_ID;
  requireThat(typeof expected === 'string' && immutable.test(expected), 'expected reader ID missing');
  const cf = client(readFileSync(0,'utf8').replace(/\r?\n$/, ''));
  const identity = await cf(`${root}/tokens/verify`);
  requireThat(identity.status === 'active' && identity.id === expected, 'reader identity mismatch');
  let gets = 0;
  await graph(async path => { const result = await cf(path); gets++; return result; });
  console.log(JSON.stringify({schema:1, readerIdEqual:true, graphEqual:true, graphGets:gets}));
} catch {
  console.error('Graph preflight failed; no install receipt or write.');
  process.exitCode = 1;
}
