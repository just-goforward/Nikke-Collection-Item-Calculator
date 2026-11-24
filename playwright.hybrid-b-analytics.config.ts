import { defineConfig } from '@playwright/test';
import { join } from 'node:path';

const evidence = process.env.ROOT_POLICY_EVIDENCE_DIR;
if (!evidence) throw new Error('ROOT_POLICY_EVIDENCE_DIR required');
export default defineConfig({
  testDir: './e2e', testMatch: 'root-candidate-analytics.spec.ts', workers: 1,
  retries: 0, repeatEach: 1, fullyParallel: false, forbidOnly: true, timeout: 60_000,
  expect: { timeout: 10_000 }, outputDir: join(evidence, 'analytics-artifacts'),
  reporter: [['./scripts/ci/hybrid-b-policy-reporter.mjs', { suite: 'analytics' }]],
  projects: [{ name: 'chromium', use: { browserName: 'chromium', serviceWorkers: 'block',
    launchOptions: { chromiumSandbox: true, args: ['--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] },
    trace: 'off', video: 'off', screenshot: 'off' } }],
});
