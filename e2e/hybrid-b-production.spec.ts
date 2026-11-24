import assert from 'node:assert/strict';
import { expect, test as base, type Page } from '@playwright/test';
import { readPolicyPackage } from '../scripts/ci/hybrid-b-policy-package.mjs';
import { enMessages } from '../src/i18n/messages.en';
import { koMessages } from '../src/i18n/messages.ko';
import type { ServiceH14Request, ServiceH14WorkerMessage } from '../src/serviceH14/types';
import { installPersistenceAudit } from './decision-analytics-persistence';
import { instrumentWorker, origin, productNetwork } from './hybrid-b-product-harness.mjs';
import type { ProductNetwork } from './hybrid-b-product-harness.mjs';

type RequestObservation = Pick<ServiceH14Request, 'id'|'generation'|'sessionId'|'inputSha256'|'forecastIdentity'> &
  Pick<ServiceH14Request['input'], 'grade'|'level'|'exp'|'stock'>;
declare global {
  interface Window { hybridProduct: { forbidden: number; count: number; requests: RequestObservation[]; finals: ServiceH14WorkerMessage[] } }
}
type Product = { net: ProductNetwork; service: string; native: string };
const test = base.extend<{ product: Product }>({
  product: [async ({ context, page }, use, info) => {
    const pkg = await readPolicyPackage(process.env.ROOT_POLICY_CANDIDATE_DIR);
    const mode = ({ BP006: 'stats-offline', BP008: 'missing-wasm', BP009: 'bad-signature' } as Record<string,string>)[info.title];
    const net = await productNetwork(context, pkg, mode);
    await context.addInitScript(installPersistenceAudit);
    await context.addInitScript(instrumentWorker, net.worker);
    await context.addInitScript(() => window.addEventListener('pagehide', () => {
      if (window.hybridProduct.forbidden || window.decisionPersistence.evidence().forbidden.length) console.error('HYBRID_B_PRIVACY_VIOLATION');
    }));
    let browserFailure = false;
    page.on('console', m => { if (m.text() === 'HYBRID_B_PRIVACY_VIOLATION') browserFailure = true; });
    page.on('pageerror', () => { browserFailure = true; });
    try { await use({ net, service: pkg.receipt.review.serviceCodeHash, native: pkg.receipt.review.nativeWasmSha256 }); }
    finally {
      if (page.url() !== 'about:blank') {
        assert(await page.evaluate(() => window.hybridProduct.forbidden === 0 && window.decisionPersistence.evidence().forbidden.length === 0));
      }
      await context.unrouteAll({ behavior: 'wait' });
      net.assertClean(); assert(!browserFailure, 'unexpected browser error or private storage effect');
    }
  }, { auto: true }],
});

async function boot(page: Page, path = '/en/') {
  await page.goto(origin + path);
  await expect(page).toHaveURL(origin + path);
  await expect(page.locator('#calculateButton')).toBeVisible();
  await expect(page.locator('[data-account-trigger], [data-account-checking]')).toHaveCount(0);
  assert(await page.evaluate(() => Reflect.get(window, 'COLLECTION_ACCOUNT_CONFIG') === undefined &&
    Reflect.get(window, 'COLLECTION_STATS_CONFIG')?.endpoint === location.origin));
}
type Input = readonly ['SR'|'R', number, number, number, number, number];
const terminal: Input = ['SR',14,2900,10,0,0];
async function submit(page: Page, [grade,level,...values]: Input) {
  await page.locator(`[data-grade="${grade}"]`).click(); await page.locator(`[data-level="${level}"]`).click();
  for (const [i, id] of ['currentExp','blueStock','purpleStock','yellowStock'].entries()) {
    await page.locator('#' + id).fill(String(values[i])); await page.locator('#' + id).blur();
  }
  await page.locator('#calculateButton').click();
}

async function completed(page: Page, product: Product, expected: Input) {
  await submit(page, expected);
  await expect(page.getByTestId('preview-verification')).toContainText('D0–D14');
  const audit = await page.evaluate(() => window.hybridProduct);
  assert.equal(audit.count, 1); assert.equal(audit.requests.length, 1); assert.equal(audit.finals.length, 1);
  const [q] = audit.requests, [{ output: o, ...response }] = audit.finals;
  assert.deepEqual([q.grade,q.level,q.exp,...q.stock], expected);
  assert.equal(response.type, 'result');
  for (const k of ['id','generation','sessionId'] as const) { assert.equal(response[k], q[k]); assert.equal(o.request[k], q[k]); }
  assert.match(q.inputSha256, /^[a-f0-9]{64}$/); assert.equal(o.inputSha256, q.inputSha256);
  assert.deepEqual(o.forecastIdentity, q.forecastIdentity);
  assert.equal(product.net.heads.get(o.forecastIdentity.sourceHash), o.forecastIdentity.forecastId);
  assert.match(o.forecastIdentity.forecastId, /^production-conditional-\d+$/);
  for (const path of [product.net.worker, product.net.wasm,'/api/forecast/version','/api/forecast','/api/joint-supply/v2']) assert(product.net.seen.has(path));
  assert.equal(o.profile.id, 'service-fused-h14-v1'); assert.equal(o.profile.policy, 'adaptive-next-batch-balanced-v1');
  assert.equal(o.profile.codeHash, product.service); assert.equal(o.profile.exactWasmHash, product.native);
  assert.equal(o.status, 'complete'); assert.equal(o.reason, null); assert.equal(o.accuracy.practical, true);
  assert.equal(o.numericalContract, 'bounded-error-h14-v1'); assert(typeof o.diagnostics.wasmLinearBytes === 'number' && o.diagnostics.wasmLinearBytes > 0);
  assert.deepEqual(o.records.map(row => row.day), Array.from({length:15}, (_,d) => d));
  assert.equal(o.sourceCertificate?.completedThrough, 14);
  await expect(page.getByTestId('preview-verification')).toContainText(o.forecastIdentity.forecastId);
  return o;
}

// Terminal in one blue on every branch, independent of forecast and pricing.
async function oneBlue(page: Page, product: Product, lang: 'ko'|'en'|'ja' = 'en') {
  const o = await completed(page, product, terminal);
  assert.equal(o.current?.certification, 'exact_rational_finite_inventory_v1'); assert.equal(o.current.status, 'use_certified');
  assert.deepEqual([o.current.kit,o.current.uses,o.current.pieces,o.current.optimalActionMask], ['blue',1,10,1]);
  const rational = (n: number) => ({ numerator: String(n), denominator: '1' });
  assert.deepEqual(o.current.value.successP, rational(1)); assert.deepEqual(o.current.value.expectedTotalConsumptionC, rational(10));
  assert.deepEqual(o.current.value.expectedConsumed, [rational(10),rational(0),rational(0)]);
  for (const row of o.records) for (const [k,n] of [['p',1],['c',10]] as const) {
    const exact = row.exactObjective?.[k]; assert(exact && BigInt(exact.denominator) > 0n);
    assert.equal(BigInt(exact.numerator), BigInt(n) * BigInt(exact.denominator));
    assert(row.value[k].lower <= n && n <= row.value[k].upper);
  }
  assert.deepEqual(o.decision, { status:'no_wait_basis', day:null });
  assert.equal(o.adaptive?.mathematical, 'use_now'); assert.equal(o.adaptive.actionable, 'no_material_wait');
  await expect(page.locator('#resultBox .action-chip.blue')).toBeVisible();
  await expect(page.locator('#resultBox .action-chip-count')).toHaveText({ko:'1회',en:'1 use',ja:'1回'}[lang]);
  await expect(page.locator('#detailBox')).toContainText('100%');
  await expect(page.getByTestId('waiting-metric')).toContainText({ko:'해당 없음',en:'Not applicable',ja:'該当なし'}[lang]);
  await expect(page.getByTestId('waiting-metric').locator('time')).toHaveCount(0);
}
for (const [id,path,lang] of [['BP001','/','ko'],['BP002','/en/','en'],['BP003','/ja/','ja']] as const) {
  test(id, async ({ page, product }) => {
    await boot(page, path); await expect(page.locator('html')).toHaveAttribute('lang', lang);
    await expect(page.locator('#calculateButton')).toBeDisabled(); assert.equal(await page.evaluate(() => window.hybridProduct.count), 0);
    await oneBlue(page, product, lang);
    if (lang === 'ja') return;
    await boot(page, path); // A new document and generation, never reuse the terminal result.
    const batch = lang === 'ko';
    const o = await completed(page, product, batch ? ['R',0,0,50,20,10] : ['R',14,800,0,0,30]);
    const kit = batch ? 'blue' : 'yellow', uses = batch ? 4 : 1;
    assert.deepEqual([o.current?.kit,o.current?.uses,o.current?.pieces], [kit,uses,10*uses]);
    for (const row of o.records.slice(1)) {
      const b = row.batchEvidence; assert(b);
      assert.deepEqual([b.kit,b.uses,b.day,b.prefixKey], [kit,uses,row.day,row.prefixKey]);
    }
    if (batch) {
      await expect(page.locator('#resultBox .action-chip.blue')).toBeVisible();
      await expect(page.locator('#resultBox .action-chip-count')).toHaveText('4회');
      await expect(page.locator('#blueStock')).toHaveValue('50'); // Merely recommending cannot consume stock.
    } else {
      // A positive witness must really be present on the fresh signed supply; never relabel missing evidence.
      assert.equal(o.adaptive?.mathematical,'wait'); assert.equal(o.adaptive.actionable,'wait');
      assert(o.adaptive.delta.lower > 0);
      await expect(page.getByTestId('waiting-metric').locator('time')).toHaveAttribute('datetime',o.adaptive.nextAt);
    }
  });
}
test('BP004', async ({ page }) => {
  await boot(page); await page.locator('[data-theme-mode="dark"]').click(); await page.locator('#language-menu-trigger').click();
  await page.getByRole('menuitemradio',{name:'日本語',exact:true}).click(); await expect(page).toHaveURL(origin+'/ja/');
  await page.locator('[data-level="4"]').click(); await page.locator('#blueStock').fill('73'); await page.locator('#blueStock').blur();
  const before = await page.evaluate(() => window.decisionPersistence.inventory());
  assert.deepEqual(before.local,{collectionThemeMode:'dark'}); assert.deepEqual(before.session,{}); assert.equal(before.cookie,'');
  await page.reload(); await expect(page.locator('html')).toHaveAttribute('lang','ja'); await expect(page.locator('body')).toHaveClass(/theme-dark/);
  await expect(page.locator('[data-grade="R"][aria-pressed="true"], [data-level="0"][aria-pressed="true"]')).toHaveCount(2);
  await expect(page.locator('#blueStock')).toHaveValue(''); assert.deepEqual(await page.evaluate(() => window.decisionPersistence.inventory()),before);
});
test('BP005', async ({ page, product }) => {
  await boot(page); await page.evaluate(() => window.decisionPersistence.configure(true)); await oneBlue(page, product);
  await page.locator('#resultBox .success-button').click();
  await page.locator('#resultBox .outcome-panel').getByRole('button',{name:enMessages['common.superSuccessYesConfirm'],exact:true}).click();
  await expect(page.locator('#blueStock')).toHaveValue(''); await expect(page.locator('[data-level="15"][aria-pressed="true"]')).toHaveCount(1);
  await page.reload(); await expect(page.locator('#blueStock')).toHaveValue('');
  await expect(page.locator('[data-grade="R"][aria-pressed="true"], [data-level="0"][aria-pressed="true"]')).toHaveCount(2);
  const state = await page.evaluate(() => window.decisionPersistence.inventory());
  assert.deepEqual(state.local,{}); assert.deepEqual(state.session,{}); assert.equal(state.cookie,'');
});
test('BP006', async ({ page, product }) => {
  await boot(page); await page.locator('#desktop-tab-stats').click();
  await expect(page.locator('#globalStatsPanel')).toContainText(enMessages['stats.connectionFailed']); assert(product.net.seen.has('/api/stats'));
  await page.locator('#desktop-tab-calc').click(); await oneBlue(page, product);
});
test('BP007', async ({ page, context }) => {
  const name = 'collection-kit-calculator.language';
  await context.setStorageState({ cookies: [], origins:[{ origin, localStorage:[{ name, value:'en' }] }] });
  await boot(page,'/'); await expect(page.locator('html')).toHaveAttribute('lang','ko');
  assert.deepEqual((await page.evaluate(() => window.decisionPersistence.inventory())).local, { [name]:'en' });
  const before = await page.evaluate(() => window.decisionPersistence.seed(new Date().toISOString()));
  for (const [path,lang] of [['/','ko'],['/en/','en'],['/ja/','ja']] as const) {
    await boot(page,path); await expect(page.locator('html')).toHaveAttribute('lang',lang); await expect(page.locator('#blueStock')).toHaveValue('');
    if (lang === 'ko') {
      await page.locator('[data-grade="SR"]').click(); await page.locator('[data-level="15"]').click();
      await expect(page.locator('#resultBox')).toContainText(koMessages['result.finalTarget']); await expect(page.locator('#calculateButton')).toBeDisabled();
    }
    assert.equal(await page.evaluate(() => window.hybridProduct.count),0);
    assert.deepEqual(await page.evaluate(() => window.decisionPersistence.inventory(true)),before);
  }
});
for (const id of ['BP008','BP009'] as const) test(id, async ({ page, product }) => {
  await boot(page); await submit(page, terminal);
  const prefix = id === 'BP009' ? enMessages['result.previewSourceInvalid'].split(' ({code})')[0] : enMessages['result.solverError'];
  await expect(page.locator('#resultBox')).toContainText(prefix);
  await expect(page.locator('#resultBox .action-chip, #resultBox .recommendation')).toHaveCount(0);
  const verification = page.getByTestId('preview-verification'), wait = page.getByTestId('waiting-metric');
  if (id === 'BP008') {
    // The production shell exposes the failed computation, not the legacy shell's empty detail.
    await expect(verification).toContainText('Validated days: None');
    await expect(wait).toContainText(enMessages['detail.wait.error']);
    await expect(wait.locator('time')).toHaveCount(0);
    const finals = await page.evaluate(() => window.hybridProduct.finals.map(({output}) =>
      ({ status:output.status, current:output.current, days:output.records.length, decision:output.decision })));
    assert.deepEqual(finals,[{status:'error',current:null,days:0,decision:{status:'unavailable',day:null}}]);
  } else {
    await expect(verification).toHaveCount(0); await expect(wait).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.hybridProduct.count),0);
  }
  await expect(page.locator('#blueStock')).toHaveValue('10');
  assert(product.net.seen.has(id === 'BP008' ? product.net.wasm : '/api/joint-supply/v2'));
  assert.equal(await page.evaluate(() => window.hybridProduct.finals.some(r => r.output.status === 'complete')),false);
  if (id === 'BP008') assert.equal(await page.evaluate(() => window.hybridProduct.count),1);
});
