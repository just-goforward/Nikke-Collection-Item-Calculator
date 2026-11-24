import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { defineConfig } from '@playwright/test';

// Never let Playwright clean the evidence root itself, a symlink or a general-purpose directory.
function artifactDir() {
  const root = process.env.ROOT_POLICY_EVIDENCE_DIR;
  if (!root && process.argv.includes('--list')) return mkdtempSync(join(tmpdir(), 'hybrid-b-discovery-'));
  assert(root && isAbsolute(root) && resolve(root) === root && realpathSync(root) === root);
  const rel = relative(import.meta.dirname, root);
  assert(rel.startsWith('..' + sep) && root !== dirname(root) && lstatSync(root).isDirectory());
  const path = join(root, 'product-artifacts');
  const st = lstatSync(path, { throwIfNoEntry: false });
  assert(!st || (st.isDirectory() && !st.isSymbolicLink()));
  return path;
}
export default defineConfig({
  testDir: './e2e', testMatch: 'hybrid-b-production.spec.ts', projects: [{ name: 'chromium' }],
  workers: 1, fullyParallel: false, retries: 0, repeatEach: 1, forbidOnly: true,
  timeout: 90_000, expect: { timeout: 30_000 }, outputDir: artifactDir(),
  reporter: [['./scripts/ci/hybrid-b-policy-reporter.mjs', { suite: 'product' }]],
  use: { browserName: 'chromium', serviceWorkers: 'block', headless: true, reducedMotion: 'reduce',
    viewport: { width:1280, height:900 }, screenshot: 'off', trace: 'off', video: 'off',
    launchOptions: { chromiumSandbox: true, args: ['--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND'] } },
});
