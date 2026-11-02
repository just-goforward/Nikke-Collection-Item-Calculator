import { mkdir, writeFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { assertOperationalExecutionAllowed } from './operational-admission.mjs';

// Even module-load/bootstrap failures are private. The workflow captures this
// process's streams as a second boundary; only this one bounded JSON is public.
const hash = value => createHash('sha256').update(value).digest('hex');
async function publicOutputPath() {
  const parent = resolve(process.env.RUNNER_TEMP);
  if ((await lstat(parent)).isSymbolicLink()) throw new Error();
  const directory = join(parent, 'operational-public');
  await mkdir(directory, { mode: 0o700 });
  return join(directory, 'result.json');
}
let output;
let failure = 'INCOMPLETE';
try {
  assertOperationalExecutionAllowed();
  output = await publicOutputPath();
  const allowed = ['RUNNER_TEMP', 'GITHUB_WORKSPACE', 'GITHUB_SHA', 'GITHUB_EVENT_NAME',
    'EXPECTED_CANDIDATE_SHA', 'R65_EXPECTED_SHA', 'OPERATIONAL_APPROVAL_URL',
    'OPERATIONAL_APPROVAL_DIGEST', 'OPERATIONAL_APPROVAL_BYTES', 'OPERATIONAL_PROVISION_DIR'];
  const env = Object.fromEntries(allowed.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const child = spawn(process.execPath, [join(import.meta.dirname, 'operational-entry.mjs')], {
    env: { ...env, OPERATIONAL_PUBLIC_RESULT: output }, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  });
  let stopping, hardStop;
  const stop = code => {
    if (stopping) return;
    failure = code; stopping = true;
    child.kill('SIGTERM');
    hardStop = setTimeout(() => child.kill('SIGKILL'), 120000);
  };
  const cancel = () => stop('CANCELLED');
  process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
  const deadline = setTimeout(() => stop('TIMEOUT'), 84 * 60_000);
  for (const stream of ['stdout', 'stderr']) {
    let size = 0;
    child[stream].on('data', bytes => { size += bytes.length; if (size > 2 * 1024 * 1024) stop('OVERFLOW'); });
  }
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve(code === 0 && !signal && !stopping ? 0 : 1));
    });
  } finally {
    clearTimeout(deadline); clearTimeout(hardStop);
    process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel);
  }
  if (process.exitCode) throw new Error();
} catch (error) {
  process.exitCode = 1;
  if (error?.message === 'ADMISSION_BLOCKED') {
    failure = 'ADMISSION_BLOCKED';
    if (!output) {
      try { output = await publicOutputPath(); } catch { /* A blocked run never overwrites prior output. */ }
    }
  }
  if (output) {
    try {
      await writeFile(output, JSON.stringify({
        schemaVersion: 1, candidateDigest: hash(process.env.EXPECTED_CANDIDATE_SHA ?? ''),
        manifestDigest: hash(''), inventoryDigest: hash(''), status: 'failed', failure,
        stages: [{ id: 'S01', durationMs: 0, passed: 0, status: 'incomplete' }],
      }), { flag: 'wx', mode: 0o600 });
    } catch { /* Never replace an existing result, including a first failure. */ }
  }
}
