// Component regression, not a production-policy case. No Worker, service, packet or calculation.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';

test('Undo restores editable stock before a queued focus, edit or Calculate can consume it', async t => {
  const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('./stock-undo.fixture.tsx', import.meta.url))],
    bundle: true, write: false, jsx: 'automatic', format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' } });
  const browser = await chromium.launch({ chromiumSandbox: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ offline: true, serviceWorkers: 'block' });
  await page.setContent('<main id="root"></main>');
  await page.addScriptTag({ content: outputFiles[0].text });
  const session = await page.context().newCDPSession(page);
  const yellow = page.locator('#yellowStock');
  const point = async id => {
    const b = await page.locator(id).boundingBox();
    assert(b);
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const click = pt => ['mousePressed', 'mouseReleased'].map(type => session.send('Input.dispatchMouseEvent',
    { ...pt, type, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }));
  const key = (name, code) => ['keyDown', 'keyUp'].map(type => session.send('Input.dispatchKeyEvent',
    { type, key: name, code: name, windowsVirtualKeyCode: code }));
  const original = { blue: 13, purple: 31, yellow: 42 };
  for (const action of ['focus-only', 'append', 'backspace', 'invalid']) {
    await page.locator('#seed').click();
    await expect(yellow).toHaveValue('42');
    await page.locator('#resetButton').click();
    await expect(yellow).toHaveValue('');
    const undo = await point('#undo'), field = await point('#yellowStock'), calculate = await point('#calculateButton');
    // No retry or actionability wait between Undo and the trusted native inputs.
    await Promise.all([...click(undo), ...click(field), ...(action === 'focus-only' ? click(calculate) : [
      ...key('End', 35), ...(action === 'backspace' ? key('Backspace', 8) : [session.send('Input.insertText', { text: action === 'invalid' ? 'x' : '7' })])
    ])]);
    const expected = { ...original, yellow: action === 'append' ? 427 : action === 'backspace' ? 4 : 42 };
    if (action === 'invalid') {
      await expect(yellow).toHaveValue('42x');
      await expect(yellow).toHaveAttribute('aria-invalid', 'true');
      await yellow.blur();
    }
    await expect(yellow).toHaveValue(String(expected.yellow));
    await expect(page.locator('#model')).toHaveText(JSON.stringify(expected));
    if (action === 'focus-only') await expect(page.locator('#submitted')).toHaveText(JSON.stringify(original));
  }
});
