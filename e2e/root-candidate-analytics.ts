import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { installPersistenceAudit } from './decision-analytics-persistence';
import {signedGet} from './hybrid-b-product-harness.mjs';

const origin = 'https://nikkecollection.com';
const publicReads = new Map([['/api/forecast/version', 4096], ['/api/forecast', 524288], ['/api/joint-supply/v2', 65536]]);
const catalog = '/decision-production-catalog.json';
const mime: Record<string, string> = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png' };
type Package = { forward: string; receipt: { worker: string; files: { forward: Record<string, { bytes: number; sha256: string }> }; review: { source: string; nativeWasmSha256: string } } };


type Audit = { seen: Set<string>; violations: string[] };
async function storage(page: Page) {
  const [audit, inventory] = await page.evaluate(async () => [window.decisionPersistence.evidence(), await window.decisionPersistence.inventory()] as const);
  expect(audit.forbidden, 'no app access to personal stores').toEqual([]);
  return inventory;
}
async function threeColumns(page: Page, selector: string) {
  const rects = await page.locator(selector).evaluateAll(nodes => nodes.map(node => {
    const {left,right,top} = node.getBoundingClientRect(); return {left,right,top};
  }));
  expect(rects).toHaveLength(3);
  expect(Math.max(...rects.map(r=>r.top)) - Math.min(...rects.map(r=>r.top))).toBeLessThanOrEqual(1);
  for (const [i,r] of rects.entries()) {
    expect(r.left).toBeGreaterThanOrEqual(i ? rects[i-1]!.right : 0);
    expect(r.right).toBeGreaterThan(r.left); expect(r.right).toBeLessThanOrEqual(375);
  }
}
async function boot(page: Page, source: string) {
  const response = await page.goto(origin + '/');
  expect(response?.status()).toBe(200);
  await expect(page.locator('html')).toHaveAttribute('data-build-revision', source);
  await expect(page.locator('#blueStock')).toBeVisible();
}
async function calculate(page: Page, audit: Audit, pkg: Package, mode: 'wait' | 'mobile' | 'batch' = 'wait') {
  const batch = mode === 'batch';
  await page.locator('[data-grade="R"]').click();
  await page.locator(`[data-level="${batch ? 0 : 14}"]`).click();
  const ids = ['currentExp', 'blueStock', 'purpleStock', 'yellowStock'];
  const amounts = batch ? ['0', '50', '20', '10'] : ['800', '0', '0', '30'];
  for (const [index, id] of ids.entries()) {
    const field = page.locator('#' + id); await field.fill(amounts[index]!); await field.blur();
  }
  await page.locator(mode === 'mobile' ? '.mobile-action-bar.mode-calculate button.primary-button' : '#calculateButton').click();
  await expect(page.getByTestId('preview-verification')).toContainText('D0–D14', { timeout: 25_000 });
  if (!batch) await expect(page.getByTestId('waiting-metric').locator('time')).toBeVisible();
  await expect(page.getByTestId('preview-current-candidate')).toBeVisible();
  await expect(page.getByTestId('preview-current-candidate')).toContainText(batch ? /×\s*4/ : /×\s*1/);
  for (const path of [...publicReads.keys(), '/' + pkg.receipt.worker, `/wasm/service-fused-h14-${pkg.receipt.review.nativeWasmSha256}.wasm`]) expect(audit.seen.has(path), path).toBe(true);
}

async function confirm(page: Page, success: boolean) {
  const result = page.locator('#resultBox');
  await result.locator(success ? '.success-button' : '.fail-button').click();
  await result.getByRole('button', { name: success ? '대성공 O 확정' : '대성공 X 확정', exact: true }).click();
}

type Scenario = (args: { page: Page; audit: Audit }) => Promise<void>;
type Register = (suite: (title: string, scenario: Scenario) => void, title: string, scenario: Scenario) => void;
declare global { interface Window { __forbiddenCandidateStorage(): Promise<void> } }
export function candidateAnalytics(load: () => Promise<Package>, register: Register) {
  let pkg: Package;
  test.beforeAll(async () => { pkg = await load(); });
  const suite = test.extend<{ audit: Audit }>({
    audit: async ({ page, context }, use, info) => {
      const audit: Audit = { seen: new Set(), violations: [] };
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.name));
      await context.routeWebSocket(/.*/, ws => { audit.violations.push('websocket'); ws.close(); });
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        try {
          assert(url.origin === origin && !url.search && !url.hash && !url.username && !url.password && request.method() === 'GET' && !request.postDataBuffer(), 'unapproved request');
          const path = ['/', '/en/'].includes(url.pathname) ? url.pathname + 'index.html' : url.pathname;
          let bytes: Buffer;
          const limit = publicReads.get(path);
          if (limit) {
            const headers = await request.allHeaders();
            assert(!headers.cookie && !headers.authorization, 'credentialed public read');
            bytes = await signedGet(path,pkg.receipt.review,false,new Map());
            assert(bytes.length<=limit);
          } else {
            assert(['/index.html', '/en/index.html', catalog, '/favicon-32.png'].includes(path) || ['/assets/', '/fonts/', '/wasm/', '/proofs/'].some(prefix => path.startsWith(prefix)), 'unapproved local resource');
            const pin = pkg.receipt.files.forward[path]; assert(pin, 'not in approved package');
            bytes = await readFile(join(pkg.forward, path));
            assert.equal(bytes.length, pin.bytes);
            assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.sha256);
            if (path === catalog) assert.deepEqual(JSON.parse(bytes.toString()), { enabled: false, producer: { producerVersion: '', producerCodeHash: '' }, allowedProducers: [], turnstileSiteKey: '', publications: [] });
          }
          audit.seen.add(path);
          await route.fulfill({ body: bytes, contentType: limit ? 'application/json' : mime[extname(path)] ?? 'application/octet-stream', headers: { 'cache-control': 'no-store' } });
        } catch (err) {
          // Never record URL queries, payloads, request headers, cookies or storage values.
          audit.violations.push(`${request.method()} ${publicReads.has(url.pathname) ? url.pathname : request.resourceType()}: ${err instanceof Error ? err.message.split('\n')[0] : 'rejected'}`);
          await route.abort().catch(() => {});
        }
      });
      const denied = info.title.startsWith('denied storage ');
      // Cache/OPFS writes are not legitimate calculator output. Report before denying access.
      await context.exposeBinding('__forbiddenCandidateStorage', () => { audit.violations.push('cache or filesystem storage'); });
      function guardStorage() {
        const deny = () => { void window.__forbiddenCandidateStorage(); throw new Error('external storage denied'); };
        // The seed/inventory helper uses native cache APIs for its own sentinel. Guard app access only.
        Object.defineProperty(globalThis, 'caches', { get: deny });
        Object.defineProperty(navigator.storage, 'getDirectory', { value: deny });
      }
      await context.addInitScript({ content: `(${installPersistenceAudit.toString()})(); window.decisionPersistence.configure(${denied}); (${guardStorage.toString()})();` });
      try { await use(audit); } finally {
        await page.close();
        await context.unrouteAll({ behavior: 'wait' });
        expect(errors, 'page exceptions').toEqual([]);
        expect(audit.violations, 'unapproved network/storage or failed approved read').toEqual([]);
      }
    },
  });
  const run = (title: string, scenario: Scenario) => register(suite, title, scenario);
  run('enrolled disabled catalog boots without analytics transport', async ({ page, audit }) => {
    await boot(page, pkg.receipt.review.source);
    expect(audit.seen.has(catalog)).toBe(true);
    await expect(page.locator('#levelGrid')).toHaveCSS('display','grid');
    await expect(page.locator('#calculateButton')).toBeDisabled();
    expect(audit.seen.has('/' + pkg.receipt.worker)).toBe(false);
    expect([...audit.seen].some(path => path.startsWith('/wasm/'))).toBe(false);
    const inventory = await storage(page);
    expect(inventory).toEqual({ local: {}, session: {}, cookie: '', database: null, publicCache: null });
  });
  run('verified WAIT and Current never emit decision telemetry', async ({ page, audit }) => {
    await boot(page, pkg.receipt.review.source); await calculate(page, audit, pkg); await storage(page);
  });
  run('unanswered recommendation is not restored after reload', async ({ page, audit }) => {
    await boot(page, pkg.receipt.review.source); const initial = await page.locator('#yellowStock').inputValue();
    await calculate(page, audit, pkg); expect(await page.locator('#yellowStock').inputValue()).not.toBe(initial);
    const before = await storage(page); await page.reload();
    await expect(page.locator('#yellowStock')).toHaveValue(initial);
    await expect(page.getByTestId('waiting-metric').locator('time')).toHaveCount(0);
    await expect(page.getByTestId('preview-verification')).toHaveCount(0);
    expect(await storage(page)).toEqual(before);
  });
  run('denied storage does not prevent verified calculation', async ({ page, audit }) => {
    await boot(page, pkg.receipt.review.source);
    expect(await page.evaluate(() => window.decisionPersistence.evidence().calls.some(call => call.denied))).toBe(true);
    await calculate(page, audit, pkg); await storage(page);
    await confirm(page,true); await expect(page.locator('#yellowStock')).toHaveValue('20');
    await page.locator('#resultBox .convert-button').click();
    await expect(page.locator('[data-grade="SR"]')).toHaveAttribute('aria-pressed','true');
    await expect(page.locator('[data-level="5"]')).toHaveAttribute('aria-pressed','true');
    await expect(page.getByTestId('preview-verification')).toContainText('D0–D14',{timeout:25_000});
    await page.reload(); await expect(page.locator('#yellowStock')).toHaveValue('');
    await expect(page.locator('[data-grade="R"]')).toHaveAttribute('aria-pressed','true');
    await expect(page.locator('[data-level="0"]')).toHaveAttribute('aria-pressed','true');
    expect(await storage(page)).toEqual({local:{},session:{},cookie:'',database:null,publicCache:null});
  });
  run('legacy personal records remain untouched by calculation', async ({ page, audit }) => {
    await boot(page, pkg.receipt.review.source); await storage(page);
    const before = await page.evaluate(() => window.decisionPersistence.seed(new Date().toISOString()));
    await page.reload(); await calculate(page, audit, pkg); await storage(page);
    expect(await page.evaluate(() => window.decisionPersistence.inventory(true))).toEqual(before);
  });
  run('theme alone persists across locale navigation and reload', async ({ page, audit }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await boot(page, pkg.receipt.review.source);
    expect(await storage(page)).toEqual({local:{},session:{},cookie:'',database:null,publicCache:null});
    await page.locator('[data-theme-mode="dark"]').click();
    await expect(page.locator('body')).toHaveClass(/theme-dark/);
    await storage(page);
    await page.locator('#language-menu-trigger').click();
    await page.getByRole('menuitemradio', { name: 'English', exact: true }).click();
    await expect(page).toHaveURL(origin + '/en/');
    await page.locator('[data-level="4"]').click();
    await page.locator('#blueStock').fill('73'); await page.locator('#blueStock').blur();
    const saved = await storage(page);
    expect(saved).toEqual({ local: { collectionThemeMode: 'dark' }, session: {}, database: null, cookie: '', publicCache: null });
    await page.reload(); await expect(page).toHaveURL(origin + '/en/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('body')).toHaveClass(/theme-dark/);
    await expect(page.locator('#blueStock')).toHaveValue('');
    await expect(page.locator('[data-level="0"][aria-pressed=true]')).toHaveCount(1);
    expect(audit.seen.has('/en/index.html')).toBe(true); expect(await storage(page)).toEqual(saved);
  });
  run('mobile unanswered Current and WAIT leave no durable state', async ({ page, audit }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await boot(page, pkg.receipt.review.source); const initial = await storage(page);
    await threeColumns(page,'#blueStock, #purpleStock, #yellowStock');
    await calculate(page, audit, pkg, 'mobile');
    await expect(page.locator('.mobile-action-bar.mode-outcome .success-button')).toBeEnabled();
    await threeColumns(page,'#detailBox .metric-grid > .metric');
    expect(await storage(page)).toEqual(initial);
    await page.reload(); await expect(page.locator('#yellowStock')).toHaveValue('');
    await expect(page.locator('.mobile-action-bar.mode-calculate button.primary-button')).toBeDisabled();
    await expect(page.getByTestId('waiting-metric').locator('time')).toHaveCount(0);
    expect(await storage(page)).toEqual(initial);
  });
  run('confirmed great success and conversion do not submit conditional outcomes', async ({ page, audit }) => {
    await boot(page, pkg.receipt.review.source); await calculate(page, audit, pkg);
    await confirm(page, true); await expect(page.locator('#yellowStock')).toHaveValue('20');
    await expect(page.locator('[data-level="15"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#resultBox .convert-button').click();
    await expect(page.locator('[data-grade="SR"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-level="5"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('preview-verification')).toContainText('D0–D14', { timeout: 25_000 });
    await storage(page);
  });
  run('confirmed normal batch settles real stock without analytics', async ({ page, audit }) => {
    await boot(page, pkg.receipt.review.source); await calculate(page, audit, pkg, 'batch');
    await confirm(page, false);
    await expect(page.locator('#blueStock')).toHaveValue('10');
    await expect(page.getByTestId('preview-verification')).toContainText('D0–D14', { timeout: 25_000 });
    await storage(page);
  });
  for (const known of [true, false]) {
    run(known ? 'explicit batch attempt settles only actual use without analytics' : 'unknown batch attempt and stock correction remain private', async ({ page, audit }) => {
      await boot(page, pkg.receipt.review.source); await calculate(page, audit, pkg, 'batch');
      await confirm(page, true);
      const modal = page.getByRole('dialog'); await expect(modal).toBeVisible();
      if (known) {
        await modal.locator('.attempt-choice-button').nth(1).click();
      } else {
        await modal.getByRole('button', { name: '취소', exact: true }).click();
        await expect(page.locator('#blueStock')).toHaveValue('50');
        await page.locator('#blueStock').fill('30'); await page.locator('#blueStock').blur();
        await page.locator('#calculateButton').click();
      }
      await expect(modal).toHaveCount(0);
      await expect(page.locator('#blueStock')).toHaveValue('30');
      await expect(page.getByTestId('preview-verification')).toContainText('D0–D14', { timeout: 25_000 });
      await storage(page);
    });
  }
  run('denied storage preserves reset and undo in RAM only', async ({ page, audit }) => {
    await boot(page, pkg.receipt.review.source);
    expect(audit.seen.has(catalog)).toBe(true);
    expect(await page.evaluate(() => window.decisionPersistence.evidence().calls.some(call => call.denied))).toBe(true);
    await page.locator('[data-level="6"]').click();
    await page.locator('#blueStock').fill('66'); await page.locator('#blueStock').blur();
    await page.locator('#resetButton').click(); await expect(page.locator('#blueStock')).toHaveValue('');
    const undo = page.getByRole('button', { name: '입력 초기화 되돌리기', exact: true });
    await undo.click(); await expect(page.locator('#blueStock')).toHaveValue('66');
    await expect(page.locator('[data-level="6"]')).toHaveAttribute('aria-pressed', 'true');
    const initial = await storage(page); await page.reload();
    await expect(undo).toHaveCount(0); await expect(page.locator('#blueStock')).toHaveValue('');
    expect(await storage(page)).toEqual(initial);
  });
}
