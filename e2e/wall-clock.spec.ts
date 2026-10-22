import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { pinWallClock, shiftInsertionPoint } from "./smoke.helpers";
import { takePinRefusals, test } from "./test";

const PINNED_AT_MS = Date.parse("2031-05-06T07:08:09.000Z");
const SAMPLE_UTC_MS = 1_577_934_245_006; // 2020-01-02T03:04:05.006Z
const CLONED_MS = 1_000_000_000_000;
const CLOCK_TOLERANCE_MS = 50;

/** Runs in the page and inside Workers (served as source), so it must stay self-contained. */
function dateProbe(cloned: Date) {
  class LaterDate extends Date {}
  const created = new Date();
  const subclassed = new LaterDate();
  const called: unknown = Date();
  return {
    nowMs: Date.now(),
    createdMs: created.getTime(),
    subclassMs: subclassed.getTime(),
    calledType: typeof called,
    calledMs: Date.parse(String(called)),
    explicitMs: new Date(0).getTime(),
    stringArgMs: new Date("2020-01-02T03:04:05.006Z").getTime(),
    parsedMs: Date.parse("2020-01-02T03:04:05.006Z"),
    utcMs: Date.UTC(2020, 0, 2, 3, 4, 5, 6),
    createdIsDate: created instanceof Date,
    clonedIsDate: cloned instanceof Date,
    clonedMs: cloned.getTime(),
    clonedTag: Object.prototype.toString.call(cloned),
    sharedPrototype: Object.getPrototypeOf(created) === Date.prototype,
    constructorIsDate: created.constructor === Date,
    subclassIsDate: subclassed instanceof LaterDate && subclassed instanceof Date,
    name: Date.name,
    length: Date.length,
  };
}

const workerReply = (importedAt: string) =>
  [
    "self.onmessage = async (event) => {",
    "  postMessage({",
    "    probe: dateProbe(event.data),",
    `    importedAtMs: ${importedAt},`,
    "    href: location.href,",
    '    fetched: await (await fetch("./data.txt")).text(),',
    "  });",
    "};",
  ].join("\n");

const strictnessReply = [
  "self.onmessage = () => {",
  "  postMessage({ strict: (function () { return this === undefined; })(), nowMs: Date.now() });",
  "};",
].join("\n");

const files: Record<string, { body: string; type: string }> = {
  "/app/index.html": {
    body: '<!doctype html><base href="/lib/"><title>clock</title><script src="probe.js"></script>',
    type: "text/html",
  },
  "/lib/probe.js": { body: dateProbe.toString(), type: "text/javascript" },
  "/lib/module-worker.js": {
    body: [
      'import { importedAtMs } from "./module-dep.js";',
      dateProbe.toString(),
      workerReply("importedAtMs"),
    ].join("\n"),
    type: "text/javascript",
  },
  "/lib/module-dep.js": {
    body: "export const importedAtMs = Date.now();",
    type: "text/javascript",
  },
  "/lib/classic-worker.js": {
    body: [
      'importScripts("./classic-dep.js");',
      dateProbe.toString(),
      workerReply("self.importedAtMs"),
    ].join("\n"),
    type: "text/javascript",
  },
  "/lib/classic-dep.js": { body: "self.importedAtMs = Date.now();", type: "text/javascript" },
  "/lib/data.txt": { body: "relative fetch ok", type: "text/plain" },
  // Shifted: the first token is no string literal, so there is no directive prologue.
  "/lib/plain-classic-worker.js": { body: strictnessReply, type: "text/javascript" },
  "/lib/hashbang-plain-classic-worker.js": {
    body: ["#!/usr/bin/env node", strictnessReply].join("\n"),
    type: "text/javascript",
  },
  // `;` is the first token, so the later "use strict" is an expression statement: sloppy.
  "/lib/late-string-classic-worker.js": {
    body: ["\uFEFF/* leading */ // comment", ';"use strict";', strictnessReply].join("\n"),
    type: "text/javascript",
  },
  "/lib/strictness-module-worker.js": { body: strictnessReply, type: "text/javascript" },
  // Refused: a string literal or an HTML-like comment comes at or before the first token.
  "/lib/strict-classic-worker.js": {
    body: ["\uFEFF/* leading */ // comment", "'use strict'", '"second";', strictnessReply].join(
      "\n",
    ),
    type: "text/javascript",
  },
  "/lib/hashbang-strict-classic-worker.js": {
    body: ["#!/usr/bin/env node", '"use strict";', strictnessReply].join("\n"),
    type: "text/javascript",
  },
  // R2-82: a decimal literal and an identifier starting with "instanceof" do not continue the
  // directive, and an HTML-like comment before it is trivia: all three are strict.
  "/lib/decimal-strict-classic-worker.js": {
    body: ['"use strict"', ".5;", strictnessReply].join("\n"),
    type: "text/javascript",
  },
  "/lib/identifier-strict-classic-worker.js": {
    body: ['"use strict"', "instanceofπ: ;", strictnessReply].join("\n"),
    type: "text/javascript",
  },
  "/lib/html-open-comment-strict-classic-worker.js": {
    body: ["<!-- html open comment", '"use strict";', strictnessReply].join("\n"),
    type: "text/javascript",
  },
  "/lib/html-close-comment-classic-worker.js": {
    body: ["// line", "--> html close comment", strictnessReply].join("\n"),
    type: "text/ecmascript",
  },
  // `"use strict"\n.length` continues an expression, so it is no directive: sloppy, but refused.
  "/lib/string-first-sloppy-classic-worker.js": {
    body: ['"use loose";', '"use strict"', ".length;", strictnessReply].join("\n"),
    type: "text/javascript",
  },
};

const SHIFTED_CASES = [
  { url: "plain-classic-worker.js", type: "classic", strict: false },
  { url: "hashbang-plain-classic-worker.js", type: "classic", strict: false },
  { url: "late-string-classic-worker.js", type: "classic", strict: false },
  { url: "strictness-module-worker.js", type: "module", strict: true },
] as const;

const REFUSED_CASES = [
  { url: "strict-classic-worker.js", type: "classic", strict: true },
  { url: "hashbang-strict-classic-worker.js", type: "classic", strict: true },
  { url: "decimal-strict-classic-worker.js", type: "classic", strict: true },
  { url: "identifier-strict-classic-worker.js", type: "classic", strict: true },
  { url: "html-open-comment-strict-classic-worker.js", type: "classic", strict: true },
  { url: "html-close-comment-classic-worker.js", type: "classic", strict: false },
  { url: "string-first-sloppy-classic-worker.js", type: "classic", strict: false },
] as const;

type StrictnessResult = { strict: boolean; nowMs: number } | { error: string };

async function workerStrictness(
  page: Page,
  cases: readonly { url: string; type: WorkerType }[],
): Promise<StrictnessResult[]> {
  await page.goto(`${origin}/app/index.html`);
  return page.evaluate(
    (workers) =>
      Promise.all(
        workers.map(
          ({ url, type }) =>
            new Promise<StrictnessResult>((resolve) => {
              const worker = new Worker(url, { type });
              worker.onmessage = (event) => {
                resolve(event.data);
                worker.terminate();
              };
              worker.onerror = (event) => {
                event.preventDefault();
                resolve({ error: event.message });
                worker.terminate();
              };
              worker.postMessage(null);
            }),
        ),
      ),
    cases.map(({ url, type }) => ({ url, type })),
  );
}

function expectBetween(valueMs: unknown, fromMs: number, toMs: number, label: string) {
  expect(valueMs, label).toBeGreaterThanOrEqual(fromMs - CLOCK_TOLERANCE_MS);
  expect(valueMs, label).toBeLessThanOrEqual(toMs + CLOCK_TOLERANCE_MS);
}

let server: Server;
let origin: string;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const file = files[new URL(request.url ?? "/", "http://localhost").pathname];
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "cache-control": "no-store", "content-type": file.type });
    response.end(file.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test("pinWallClock keeps native Date semantics and Worker URLs in the page and in module and classic Workers", async ({
  page,
}) => {
  const startedAtMs = Date.now();
  await pinWallClock(page, origin, PINNED_AT_MS);
  await page.goto(`${origin}/app/index.html`);

  const result = await page.evaluate(async (clonedMs) => {
    const probe = Reflect.get(window, "dateProbe") as (cloned: Date) => unknown;
    const cloned = new Date(clonedMs);
    const run = (url: string, options?: WorkerOptions) =>
      new Promise<unknown>((resolve, reject) => {
        const worker = new Worker(url, options);
        worker.onmessage = (event) => {
          resolve(event.data);
          worker.terminate();
        };
        worker.onerror = (event) => reject(new Error(`${url}: ${event.message}`));
        worker.postMessage(cloned);
      });
    const blobUrl = URL.createObjectURL(
      new Blob(["postMessage(Date.now());"], { type: "text/javascript" }),
    );
    return {
      page: probe(structuredClone(cloned)),
      nativeWorkerConstructor: Function.prototype.toString.call(Worker).includes("[native code]"),
      module: await run("module-worker.js", { type: "module" }),
      classic: await run("classic-worker.js"),
      explicitClassic: await run("classic-worker.js", { type: "classic" }),
      blobNowMs: await run(blobUrl),
    };
  }, CLONED_MS);
  const elapsedMs = Date.now() - startedAtMs;

  // Pinned clocks read PINNED_AT_MS plus at most the real time this test has run.
  const expectPinned = (valueMs: unknown, label: string, resolutionMs = 0) => {
    expect(valueMs, label).toBeGreaterThanOrEqual(PINNED_AT_MS - resolutionMs - CLOCK_TOLERANCE_MS);
    expect(valueMs, label).toBeLessThanOrEqual(PINNED_AT_MS + elapsedMs + CLOCK_TOLERANCE_MS);
  };
  const expectNativeDate = (probe: unknown, label: string) => {
    expect(probe, label).toEqual({
      ...nativeDate,
      nowMs: expect.any(Number),
      createdMs: expect.any(Number),
      subclassMs: expect.any(Number),
      calledMs: expect.any(Number),
    });
    const times = probe as Record<"nowMs" | "createdMs" | "subclassMs" | "calledMs", number>;
    expectPinned(times.nowMs, `${label} Date.now()`);
    expectPinned(times.createdMs, `${label} new Date()`);
    expectPinned(times.subclassMs, `${label} subclass`);
    // Date() has whole-second resolution.
    expectPinned(times.calledMs, `${label} Date()`, 1000);
  };
  const nativeDate = {
    calledType: "string",
    explicitMs: 0,
    stringArgMs: SAMPLE_UTC_MS,
    parsedMs: SAMPLE_UTC_MS,
    utcMs: SAMPLE_UTC_MS,
    createdIsDate: true,
    clonedIsDate: true,
    clonedMs: CLONED_MS,
    clonedTag: "[object Date]",
    sharedPrototype: true,
    constructorIsDate: true,
    subclassIsDate: true,
    name: "Date",
    length: 7,
  };
  expectNativeDate(result.page, "page");
  expect(result.nativeWorkerConstructor).toBe(true);
  for (const [label, script] of [
    ["module", "module-worker.js"],
    ["classic", "classic-worker.js"],
    ["explicitClassic", "classic-worker.js"],
  ] as const) {
    const reply = result[label] as Record<string, unknown>;
    expect(reply, label).toEqual({
      probe: expect.any(Object),
      importedAtMs: expect.any(Number),
      // Resolved against the page's <base>; the Worker keeps that URL for its own fetches.
      href: `${origin}/lib/${script}`,
      fetched: "relative fetch ok",
    });
    expectNativeDate(reply["probe"], label);
    // The shift is in place before the Worker's imports (static or importScripts) evaluate.
    expectPinned(reply["importedAtMs"], `${label} import`);
  }
  // Documented limitation: blob: Workers load no script from the app origin and stay unshifted.
  expect(result.blobNowMs).toBeGreaterThanOrEqual(startedAtMs - CLOCK_TOLERANCE_MS);
  expect(result.blobNowMs).toBeLessThanOrEqual(startedAtMs + elapsedMs + CLOCK_TOLERANCE_MS);
});

test("pinWallClock shifts classic and module Workers whose first token is no string literal and keeps their strictness", async ({
  page,
}) => {
  const nativeStartedAtMs = Date.now();
  const native = await workerStrictness(await page.context().newPage(), SHIFTED_CASES);
  const nativeEndedAtMs = Date.now();
  await pinWallClock(page, origin, PINNED_AT_MS);
  const pinned = await workerStrictness(page, SHIFTED_CASES);
  const pinnedElapsedMs = Date.now() - nativeEndedAtMs;

  for (const [index, { url, strict }] of SHIFTED_CASES.entries()) {
    expect(native[index], `${url} native`).toEqual({ strict, nowMs: expect.any(Number) });
    expect(pinned[index], `${url} pinned`).toEqual({ strict, nowMs: expect.any(Number) });
    const nativeNow = native[index] as { nowMs: number };
    const pinnedNow = pinned[index] as { nowMs: number };
    expectBetween(nativeNow.nowMs, nativeStartedAtMs, nativeEndedAtMs, `${url} native now`);
    expectBetween(
      pinnedNow.nowMs,
      PINNED_AT_MS,
      PINNED_AT_MS + pinnedElapsedMs,
      `${url} pinned now`,
    );
  }
  expect(takePinRefusals(page)).toEqual([]);
});

test("pinWallClock refuses loudly to shift scripts that start with a string literal or an HTML-like comment", async ({
  page,
}) => {
  const native = await workerStrictness(await page.context().newPage(), REFUSED_CASES);
  await pinWallClock(page, origin, PINNED_AT_MS);
  const pinned = await workerStrictness(page, REFUSED_CASES);

  for (const [index, { url, strict }] of REFUSED_CASES.entries()) {
    // The inputs are what they claim to be in Chromium without the pin.
    expect(native[index], `${url} native`).toEqual({ strict, nowMs: expect.any(Number) });
    // Pinned, the script never runs on the real clock: it throws an error naming its URL.
    expect(pinned[index], `${url} pinned`).toEqual({
      error: expect.stringContaining(`pinWallClock refused to shift ${origin}/lib/${url}`),
    });
  }
  expect(takePinRefusals(page).sort()).toEqual(
    REFUSED_CASES.map(({ url }) => `${origin}/lib/${url}`).sort(),
  );
});

test("the fixture page fails a test that leaves a pinWallClock refusal untaken", async ({
  page,
}) => {
  test.fail(true, "the page fixture teardown must fail on the untaken refusal");
  await pinWallClock(page, origin, PINNED_AT_MS);
  const [result] = await workerStrictness(page, [REFUSED_CASES[0]]);
  expect(result).toEqual({ error: expect.stringContaining("pinWallClock refused to shift") });
});

test("every shipped app bundle in dist/assets gets the shift; none is refused", () => {
  const assets = join(process.cwd(), "dist", "assets");
  const bundles = readdirSync(assets).filter((name) => name.endsWith(".js"));
  expect(bundles.length).toBeGreaterThan(0);
  const refused = bundles.filter(
    (name) => shiftInsertionPoint(readFileSync(join(assets, name), "utf8")) === null,
  );
  expect(refused).toEqual([]);
});

const routedDuringContextSetup = test.extend({
  context: async ({ context }, use) => {
    await context.route("**/*.js", (route) => route.fallback());
    await use(context);
  },
});

routedDuringContextSetup(
  "pinWallClock refuses to bypass a context route registered during context setup",
  async ({ page }) => {
    await expect(pinWallClock(page, origin, PINNED_AT_MS)).rejects.toThrow(
      `pinWallClock must precede every page/context route that can match ${origin}`,
    );
  },
);

for (const [label, routeEarlier] of [
  [
    "a same-origin page route",
    (page: Page) => page.route(`${origin}/lib/*.js`, (route) => route.fallback()),
  ],
  [
    "a regex context route",
    (page: Page) => page.context().route(/\.js$/, (route) => route.fallback()),
  ],
  ["a relative page route", (page: Page) => page.route("/lib/**", (route) => route.fallback())],
] as const) {
  test(`pinWallClock refuses to bypass ${label} registered before it`, async ({ page }) => {
    await routeEarlier(page);
    await expect(pinWallClock(page, origin, PINNED_AT_MS)).rejects.toThrow(
      `pinWallClock must precede every page/context route that can match ${origin}`,
    );
  });
}

test("pinWallClock accepts earlier other-origin routes and rejects a second pin or an untracked page", async ({
  page,
}) => {
  await page.route("https://other.example.test/**", (route) => route.abort());
  const startedAtMs = Date.now();
  await pinWallClock(page, origin, PINNED_AT_MS);
  await expect(pinWallClock(page, origin, PINNED_AT_MS + 86_400_000)).rejects.toThrow(
    "pinWallClock already pinned this page.",
  );
  await page.goto(`${origin}/app/index.html`);
  const pageNowMs = await page.evaluate(() => Date.now());
  expectBetween(pageNowMs, PINNED_AT_MS, PINNED_AT_MS + Date.now() - startedAtMs, "first pin");
  await expect(pinWallClock(await page.context().newPage(), origin, PINNED_AT_MS)).rejects.toThrow(
    "pinWallClock only supports the test fixture's page.",
  );
});
