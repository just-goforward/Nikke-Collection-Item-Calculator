import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertServiceH14Build } from './service-h14-integrity.ts';
import { assertServiceH14Node, serviceH14BaseURL, serviceH14Environment, serviceH14Root, serviceH14Run } from './service-h14-paths.ts';

assertServiceH14Node();
if (process.argv.length !== 2) throw new Error('service_h14_preview_unknown_arguments');
const root = serviceH14Root(), run = serviceH14Run(root), selected = serviceH14BaseURL();
const identity = await assertServiceH14Build(root);
const receipt = JSON.parse(readFileSync(join(run, 'dist/.vite/service-h14.json'), 'utf8'));
if (receipt.identity?.codeHash !== identity.codeHash || receipt.identity?.exactWasmHash !== identity.exactWasmHash ||
    receipt.status !== 'NONDEPLOYABLE_SERVICE_CANDIDATE' || receipt.publicationApproved !== false)
  throw new Error('service_h14_preview_artifact_identity_mismatch');
// --port overrides the config default 4330, so an occupied 4330 is never reused or killed (--strictPort).
const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--configLoader', 'native', '--config', 'scripts/service-h14.vite.config.ts', '--host', '127.0.0.1', '--port', selected.port, '--strictPort'],
  { cwd: root, env: { ...serviceH14Environment(root, run), SERVICE_H14_BASE_URL: selected.origin }, stdio: 'inherit' });
console.log(JSON.stringify({ preview: selected.origin, status: 'NONDEPLOYABLE_SERVICE_CANDIDATE' }));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
