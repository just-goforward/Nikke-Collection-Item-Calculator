import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const sources = [
  html,
  html.replace(/<script>/gi, "<SCRIPT>").replace(/<\/script>/gi, "</ScRiPt \t>"),
].map((value) => {
  const source = value.match(/<script>([\s\S]*?)<\/script\s*>/i)?.[1];
  assert.ok(source, "Locale initializer must exist");
  return source;
});

for (const [path, locale] of [
  ["/?keep=1#anchor", "ko"],
  ["/en/?keep=1#anchor", "en"],
  ["/ja/?keep=1#anchor", "ja"],
  ["/unknown/?keep=1#anchor", "ko"],
]) {
  for (const unavailable of [false, true]) {
    test(`URL locale ${locale} preserves legacy preferences (${path}, storage unavailable: ${unavailable})`, () => {
      const url = new URL(path, "https://example.invalid");
      const records = new Map([
        ["collection-kit-calculator.language", "en"],
        ["TEST-ONLY-existing-personal-record", "preserve"],
      ]);
      const before = [...records];
      const calls = [];
      const storage = {
        getItem(key) { calls.push(["getItem", key]); return records.get(key) ?? null; },
        removeItem(key) { calls.push(["removeItem", key]); records.delete(key); },
        setItem(key, value) { calls.push(["setItem", key]); records.set(key, value); },
      };
      const window = {
        location: url,
        history: {
          replaceState(_state, _title, target) {
            calls.push(["replaceState", target]);
            window.location = new URL(target, url);
          },
        },
        get localStorage() {
          calls.push(["localStorage"]);
          if (unavailable) throw new Error("TEST-ONLY storage unavailable");
          return storage;
        },
      };
      const root = { lang: "", dataset: {} };
      const document = {
        documentElement: root,
        createElement: () => ({ dataset: {}, addEventListener() {} }),
        head: { append() {} },
      };
      for (const source of sources) {
        runInNewContext(source, { window, document }, { timeout: 1000 });
      }
      assert.equal(root.lang, locale);
      assert.equal(root.dataset.locale, locale);
      assert.equal(window.location.href, url.href);
      assert.deepEqual(calls, []);
      assert.deepEqual([...records], before);
    });
  }
}
