import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertServiceH14Node, serviceH14BaseURL, serviceH14Environment, serviceH14Root, serviceH14Run } from './service-h14-paths.ts';

const commands = {
  types: ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.service-h14.json'],
  unit: ['node_modules/vitest/vitest.mjs', 'run', '--config', 'scripts/service-h14.vitest.config.ts', '--configLoader', 'runner'],
  foreground: ['--test', '--test-concurrency=1', 'src/hooks/serviceH14Frontend.test.mjs', 'src/components/waitingMetric.test.mjs', 'scripts/local-service-profile.test.mjs'],
  ui: ['node_modules/@playwright/test/cli.js', 'test', '--config', 'scripts/service-h14.playwright.config.ts'],
};
assertServiceH14Node();
const kind = process.argv[2];
if (process.argv.length !== 3 || !Object.hasOwn(commands, kind)) throw new Error('Usage: node scripts/service-h14-check.mjs types|unit|foreground|ui');
const root = serviceH14Root(), run = serviceH14Run(root), env = serviceH14Environment(root, run);
if (kind === 'ui') {
  env.SERVICE_H14_BASE_URL = serviceH14BaseURL().origin;
  // Playwright-managed Chromium by default (repo convention); an explicit executable is opt-in.
  for (const name of ['PLAYWRIGHT_BROWSERS_PATH', 'SERVICE_H14_CHROMIUM_EXECUTABLE'])
    if (process.env[name]) env[name] = process.env[name];
}
const attempt = mkdtempSync(join(run, `${kind}-check.`));
const result = spawnSync(process.execPath, commands[kind], { cwd: root, env, encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
writeFileSync(join(attempt, 'stdout'), result.stdout ?? '', { flag: 'wx', mode: 0o600 });
writeFileSync(join(attempt, 'stderr'), result.stderr ?? '', { flag: 'wx', mode: 0o600 });
writeFileSync(join(attempt, 'execution.json'), JSON.stringify({ command: [process.execPath, ...commands[kind]], root, status: result.status, signal: result.signal, error: result.error?.message ?? null }, null, 2), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ kind, attempt, status: result.status, signal: result.signal, error: result.error?.message ?? null }));
process.exitCode = result.error ? 1 : result.status ?? 1;
