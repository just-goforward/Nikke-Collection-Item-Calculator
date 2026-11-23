import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
import { serviceH14BaseURL, serviceH14Directory, serviceH14Root, serviceH14Run } from './service-h14-paths.ts';

const root = serviceH14Root(), run = serviceH14Run(root);
// Default: Playwright-managed Chromium, as the repository CI configs use. An
// explicit absolute executable may be selected without editing tracked files.
const executablePath = process.env['SERVICE_H14_CHROMIUM_EXECUTABLE'];
if (executablePath !== undefined && (!isAbsolute(executablePath) || !existsSync(executablePath) || !statSync(executablePath).isFile()))
  throw new Error('service_h14_chromium_executable_absolute_file_required');
const baseURL = serviceH14BaseURL().origin;
// The migrated shared spec keeps 4290 without this explicit service-lane env.
process.env['SERVICE_H14_BASE_URL'] = baseURL;
export default defineConfig({
  testDir: resolve(root, 'e2e'), testMatch: ['operational-production.spec.ts', 'service-h14*.spec.ts'],
  workers: 1, retries: 0, repeatEach: 1, fullyParallel: false, forbidOnly: true,
  timeout: 60000, expect: { timeout: 10000 },
  outputDir: serviceH14Directory(root, resolve(run, 'playwright-artifacts')),
  reporter: [['list'], ['json', { outputFile: resolve(run, 'playwright-results.json') }]],
  use: {
    browserName: 'chromium', baseURL, headless: true,
    launchOptions: { ...(executablePath ? { executablePath } : {}), chromiumSandbox: true }, viewport: { width: 1280, height: 900 },
    reducedMotion: 'reduce', serviceWorkers: 'block', screenshot: 'only-on-failure', trace: 'off', video: 'off',
  },
  projects: [{ name: 'chromium-service-h14' }],
  // Start separately after the real build. Never launch a build, generator or a
  // replacement dev Worker implicitly from the browser verification config.
});
