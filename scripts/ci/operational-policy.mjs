import { createHash } from 'node:crypto';
import { commandFor } from './run-checked-command.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const HEX = /^[a-f0-9]{64}$/;
export const NPM_SRI = 'sha512-bKCmFRVT/BB+YPEYbZwQ1XUI3N5t4xKSpU1MxOjo7z3iWzKBJ0ZXRC1xFdEN+TC7N5TdywaBzf2dMXGJq/e2PQ==';
export const fail = (code = 'ADMISSION_BLOCKED') => { throw new Error(code); };
export const safePath = value => typeof value === 'string' && value.length > 0 &&
  !/[\\\0:\r\n]/.test(value) && !value.startsWith('/') &&
  value.split('/').every(p => p && p !== '.' && p !== '..');
export const STAGES = Object.freeze({
  S01: 4, S02: 5, S03: 12, S04: 2, S05: 7, S06: 5, S07: 3,
  S08: 10, S09: 2, S10: 7, S11: 8, S12: 6, S13: 6, S14: 2,
  S15: 2, S16: 2,
});
export const EXECUTION_STAGES = Object.freeze(Object.keys(STAGES).slice(3, 14));
export const SUITE_STAGES = Object.freeze({
  S07: 'profile-policy', S10: 'node-runtime', S11: 'numerical-boundary',
  S12: 'production-policy', S13: 'analytics-policy',
});
export const GENERATED = Object.freeze([
  'node_modules', 'dist', 'cloudflare/node_modules', 'forecast-collector/node_modules',
  'forecast-dispatcher/node_modules', 'forecast-interactions/node_modules',
  'personal-data/node_modules', 'stats-observer/node_modules', 'usage-guard/node_modules',
]);
export function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) fail();
}
export function cleanEnvironment(sha, { install = false } = {}) {
  if (!/^[a-f0-9]{40}$/.test(sha)) fail();
  const temporary = install ? '/tmp' : '/home/node/results/tmp';
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/node',
    TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    LANG: 'C.UTF-8', TZ: 'UTC', CI: 'true', GITHUB_SHA: sha,
    EXPECTED_CANDIDATE_SHA: sha, R65_EXPECTED_SHA: sha,
    R65_NPM_CLI: '/work/npm/package/bin/npm-cli.js',
    OPERATIONAL_PRIVATE_RESULTS_DIR: '/home/node/results',
    PLAYWRIGHT_BROWSERS_PATH: '/work/browsers', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    DO_NOT_TRACK: '1', WRANGLER_SEND_METRICS: 'false',
    WRANGLER_SEND_ERROR_REPORTS: 'false', CLOUDFLARE_CF_FETCH_ENABLED: 'false',
    npm_config_cache: '/work/cache', npm_config_offline: 'true',
    npm_config_ignore_scripts: 'true', npm_config_audit: 'false',
    npm_config_fund: 'false', npm_config_update_notifier: 'false',
    npm_config_userconfig: '/dev/null', npm_config_globalconfig: '/dev/null',
    SOLVER_A_VITE_CACHE_DIR: '/home/node/results/vite-cache',
  };
}
const commands = Object.freeze({
  S06: ['node', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.operational-ci.json']],
  S07: ['node', ['--test', '--test-reporter=./scripts/ci/operational-node-reporter.mjs',
    'scripts/operational-boundary.test.mjs', 'scripts/local-service-profile.test.mjs',
    'scripts/build-production-service.test.mjs', 'scripts/smoke-site-production.test.mjs',
    'scripts/locale-storage-boundary.test.mjs', 'e2e/operational-console-flood.test.mjs',
    'e2e/operational-type-config.test.mjs']],
  S08: ['npm', ['run', 'build:site-production']],
  S09: ['npm', ['run', 'check:site-production']],
  S10: ['node', ['--test', '--test-reporter=./scripts/ci/operational-node-reporter.mjs',
    'src/certifiedRuntime/nodeRuntime.test.mjs']],
  S11: ['node', ['node_modules/vitest/vitest.mjs', 'run', '--config',
    'vitest.operational-ci.config.ts', '--configLoader', 'runner']],
  S12: ['playwright', ['test', '--config', 'playwright.operational-ci.config.ts']],
  S13: ['playwright', ['test', '--config', 'playwright.analytics-ci.config.ts']],
});
// Only these sealed descriptors can reach the process supervisor.
const sealed = new WeakSet();
export function sealedCommand(stage, context) {
  if (!Object.hasOwn(commands, stage)) fail();
  const [kind, args] = commands[stage];
  const [executable, argv] = commandFor(kind, [...args], context);
  const command = Object.freeze({ id: stage, executable,
    args: Object.freeze(argv.map(arg => context.platform === 'linux' ? arg.replaceAll('\\', '/') : arg)),
    durationMs: STAGES[stage] * 60_000 });
  sealed.add(command);
  return command;
}
export function trustedNodeCommand(id, context) {
  // Bootstrap commands are fixed here, not supplied by an approval document.
  const approved = {
    S04: ['/source/scripts/ci/operational-container.mjs', 'source'],
    S05: ['/source/scripts/ci/operational-container.mjs', 'install'],
    S14: ['/source/scripts/ci/operational-finalizer.mjs'],
  };
  if (!Object.hasOwn(approved, id)) fail();
  const command = Object.freeze({ id, executable: context.node,
    args: Object.freeze([...approved[id]]), durationMs: STAGES[id] * 60_000 });
  sealed.add(command);
  return command;
}
export function assertSealed(command) {
  if (!sealed.has(command)) fail();
}
export function validateBrowserConfig(config, production) {
  if (!config || config.workers !== 1 || config.retries !== 0 || config.repeatEach !== 1 ||
      config.forbidOnly !== true || (config.use?.browserName ?? 'chromium') !== 'chromium' ||
      config.use?.serviceWorkers !== 'block' || config.use?.launchOptions?.chromiumSandbox !== true ||
      config.use?.trace !== 'off' || config.use?.video !== 'off' || config.use?.screenshot !== 'off' ||
      !Array.isArray(config.projects) || config.projects.length !== 1 ||
      Object.keys(config.projects[0]).some(key => key !== 'name')) fail();
  if (production && (config.use.baseURL !== 'http://127.0.0.1:4290' ||
      config.webServer?.url !== 'http://127.0.0.1:4290' || config.webServer.reuseExistingServer !== false)) fail();
  if (!production && config.webServer !== undefined) fail();
}
