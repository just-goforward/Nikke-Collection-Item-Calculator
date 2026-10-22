import type { Locator, Page } from "@playwright/test";
import type { SupplyForecastProfile } from "../shared/generated/supplyForecast";
import { STAGING_SUPPLY_FORECAST } from "../shared/generated/supplyForecastRuntime";
import { recordPinRefusal, registeredRoutePatterns } from "./test";

/**
 * Replaces `Date` in the current realm with a function over the native Date whose current time
 * is the native time plus `shiftMs`. Everything else stays native: `Date()` still returns a
 * string, construction with arguments and subclassing work, `Date.parse`/`Date.UTC` are the
 * native ones, and the prototype is shared, so `instanceof Date` holds for structured-cloned
 * Dates. Timers are untouched. It is serialized into pages and Worker scripts, so it must stay
 * self-contained, and it installs at most once per realm.
 */
function installShiftedDate(shiftMs: number) {
  const marker = Symbol.for("e2e.shiftedDate");
  if (Reflect.has(globalThis, marker)) return;
  const NativeDate = Date;
  const now = () => NativeDate.now() + shiftMs;
  function ShiftedDate(...args: unknown[]) {
    if (!new.target) return new NativeDate(now()).toString();
    return Reflect.construct(NativeDate, args.length === 0 ? [now()] : args, new.target);
  }
  // Copies statics from the whole constructor chain, in case `Date` is already a subclass.
  const copied = new Set<PropertyKey>(["prototype"]);
  for (
    let source: object | null = NativeDate;
    source && source !== Function.prototype;
    source = Object.getPrototypeOf(source)
  ) {
    for (const key of Reflect.ownKeys(source)) {
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (copied.has(key) || !descriptor) continue;
      copied.add(key);
      Object.defineProperty(ShiftedDate, key, descriptor);
    }
  }
  Object.defineProperty(ShiftedDate, "now", { value: now });
  Object.defineProperty(ShiftedDate, "prototype", { value: NativeDate.prototype, writable: false });
  Object.defineProperty(NativeDate.prototype, "constructor", { value: ShiftedDate });
  Object.defineProperty(globalThis, "Date", { value: ShiftedDate });
  Object.defineProperty(globalThis, marker, { value: true });
}

const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

/**
 * Index of the script's first token, after an optional BOM, a `#!` first line, whitespace and
 * standard `//` and `/* *\/` comments: the shift inserted there runs before any of the script's
 * code. A script whose first token is not a string literal has no directive prologue, so the
 * insertion cannot change its strictness. Returns null (refused) when the first token starts a
 * string literal (a possible "use strict") or when `<!--` or `-->` (Annex-B HTML-like comments,
 * which this does not skip) occurs before or at the first token; it parses no directive grammar.
 */
export function shiftInsertionPoint(source: string): number | null {
  let index = source.startsWith("\uFEFF") ? 1 : 0;
  if (source.startsWith("#!", index)) index = lineEndFrom(source, index);
  let next = skipOneTrivia(source, index);
  while (next !== index) {
    index = next;
    next = skipOneTrivia(source, index);
  }
  if (source.charAt(index) === '"' || source.charAt(index) === "'") return null;
  return /<!--|-->/.test(source.slice(0, index + 4)) ? null : index;
}

function lineEndFrom(source: string, index: number) {
  const lineEnd = source.slice(index).search(LINE_TERMINATOR);
  return lineEnd === -1 ? source.length : index + lineEnd;
}

/** Index after one whitespace character or standard comment at `index`; `index` itself if none. */
function skipOneTrivia(source: string, index: number) {
  if (index >= source.length) return index;
  if (/\s/.test(source.charAt(index))) return index + 1;
  if (source.startsWith("//", index)) return lineEndFrom(source, index);
  if (!source.startsWith("/*", index)) return index;
  const close = source.indexOf("*/", index + 2);
  return close === -1 ? source.length : close + 2;
}

const pinnedPages = new WeakSet<Page>();

/** Whether a route URL pattern is a glob whose literal origin differs from `origin`. */
function routesOtherOriginOnly(pattern: unknown, origin: string) {
  if (typeof pattern !== "string") return false;
  const prefix = /^[a-z][a-z\d+.-]*:\/\/[^/?#*{}[\]\\]+(?=\/|$)/i.exec(pattern)?.[0];
  return prefix !== undefined && new URL(prefix).origin !== origin;
}

/**
 * Pins the wall clock (`Date` only) of `page` and of every Worker it starts from `appOrigin` to
 * `atMs`; time keeps flowing in real time from there. The page gets the shift from an init
 * script. Worker scripts get it inserted before the first token (see `shiftInsertionPoint`) of
 * every JavaScript/ECMAScript response from `appOrigin` (module imports and importScripts
 * included, so it runs before any of their code), because page.route sees dedicated-worker
 * requests but cannot tell them from page scripts; page scripts skip the already installed
 * shift. Workers keep their own URL, `<base>` resolution and relative fetches. Not shifted:
 * blob:/data: Workers and scripts from other origins.
 * Refused scripts (first token a string literal, or an HTML-like comment before it) fail loudly
 * instead of running on the real clock: they are served as a script that throws an error naming
 * the URL, and the URL is recorded so the fixture page fails the test at teardown unless the
 * test takes it with `takePinRefusals`.
 * Those app-origin script responses are fetched by Node (`route.fetch()`) and fulfilled whole:
 * no streaming and no browser HTTP cache. That fetch skips route handlers registered before the
 * pin, so it throws if the fixture page or its context already routed anything but a literal
 * other origin; it also throws for pages the fixture did not create and on a second pin.
 * Later `page.route` handlers that `continue()` app scripts bypass this one; use `fallback()`.
 */
export async function pinWallClock(page: Page, appOrigin: string, atMs: number) {
  if (pinnedPages.has(page)) throw new Error("pinWallClock already pinned this page.");
  const routed = registeredRoutePatterns(page);
  if (!routed) throw new Error("pinWallClock only supports the test fixture's page.");
  const origin = new URL(appOrigin).origin;
  const bypassed = routed.filter((pattern) => !routesOtherOriginOnly(pattern, origin));
  if (bypassed.length > 0) {
    throw new Error(
      `pinWallClock must precede every page/context route that can match ${origin}; ` +
        `its route.fetch() would bypass: ${bypassed.map(String).join(", ")}`,
    );
  }
  pinnedPages.add(page);
  const shiftMs = atMs - Date.now();
  await page.addInitScript(installShiftedDate, shiftMs);
  const workerShift = `\n;(${installShiftedDate.toString()})(${shiftMs});\n`;
  await page.route(`${origin}/**`, async (route) => {
    if (!["script", "other"].includes(route.request().resourceType())) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    if (!/(?:java|ecma)script/i.test(response.headers()["content-type"] ?? "")) {
      await route.fulfill({ response });
      return;
    }
    const source = await response.text();
    const at = shiftInsertionPoint(source);
    if (at === null) {
      const url = route.request().url();
      recordPinRefusal(page, url);
      const message = `pinWallClock refused to shift ${url}: it starts with a string literal or an HTML-like comment.`;
      await route.fulfill({ response, body: `throw new Error(${JSON.stringify(message)});\n` });
      return;
    }
    await route.fulfill({ response, body: source.slice(0, at) + workerShift + source.slice(at) });
  });
}

const stagingForecastProfiles: readonly SupplyForecastProfile[] = STAGING_SUPPLY_FORECAST.profiles;

/**
 * The staging forecast fixture only covers some KST game days (05:00 KST boundaries), has
 * gaps, and may end in an open-ended profile, so its UI depends on the wall clock. This pins
 * the page and its Workers to the middle of the fixture's first bounded profile.
 */
export async function pinStagingForecastClock(page: Page, appOrigin: string) {
  const profile = stagingForecastProfiles.find((entry) => entry.effectiveUntil !== null);
  if (!profile?.effectiveUntil) {
    throw new Error("The staging forecast fixture has no bounded profile to pin the clock to.");
  }
  const fromMs = Date.parse(profile.effectiveFrom);
  const untilMs = Date.parse(profile.effectiveUntil);
  await pinWallClock(page, appOrigin, fromMs + Math.floor((untilMs - fromMs) / 2));
  return profile;
}

/** The fixture's last open-ended profile (no `effectiveUntil`), if it has one. */
export function stagingForecastOpenEndedProfile() {
  return stagingForecastProfiles.findLast((entry) => entry.effectiveUntil === null) ?? null;
}

/** The first interval between two consecutive fixture profiles that no profile covers. */
export function stagingForecastCoverageGap() {
  const ordered = [...stagingForecastProfiles].sort(
    (left, right) => Date.parse(left.effectiveFrom) - Date.parse(right.effectiveFrom),
  );
  for (const [index, profile] of ordered.entries()) {
    const next = ordered[index + 1];
    if (!next || profile.effectiveUntil === null) continue;
    const fromMs = Date.parse(profile.effectiveUntil);
    const untilMs = Date.parse(next.effectiveFrom);
    if (fromMs < untilMs) return { fromMs, untilMs };
  }
  return null;
}

export async function maxBackgroundChannel(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    const channels = getComputedStyle(element).backgroundColor.match(/\d+/g)?.map(Number) ?? [255];
    return Math.max(...channels.slice(0, 3));
  });
}

export async function confirmOutcome(
  page: Page,
  locator: Locator,
  outcome: "대성공 O" | "대성공 X",
) {
  await locator.click();
  await page
    .getByRole("button", { name: `${outcome} 확정`, exact: true })
    .first()
    .click();
}

export async function serveStagingDocument(
  page: Page,
  staging?: { endpoint: string; turnstileSiteKey: string },
) {
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.resourceType() !== "document" || url.searchParams.get("statsEnv") !== "staging") {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const replacement = [
      "      window.COLLECTION_STATS_CONFIG = {",
      '        endpoint: "https://production.example.test",',
      '        turnstileSiteKey: "production-site-key",',
      ...(staging
        ? [
            "        staging: {",
            `          endpoint: "${staging.endpoint}",`,
            `          turnstileSiteKey: "${staging.turnstileSiteKey}",`,
            "        },",
          ]
        : []),
      "      };",
    ].join("\n");
    const body = (await response.text()).replace(
      / {6}window\.COLLECTION_STATS_CONFIG = \{[\s\S]*? {6}\};/,
      replacement,
    );
    await route.fulfill({ response, body, contentType: "text/html" });
  });
}

export async function mockStagingStatsEndpoints(page: Page, origin = "http://127.0.0.1:4173") {
  await page.route("https://staging.example.test/api/stats", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "Access-Control-Allow-Origin": origin },
      body: '{"summary":null}',
    });
  });
  await page.route("https://staging.example.test/api/events", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "Access-Control-Allow-Origin": origin },
      body: '{"ok":true}',
    });
  });
}

export async function installTurnstileStub(page: Page) {
  await page.addInitScript(() => {
    const widgets = new Map<string, Record<string, unknown>>();
    let nextId = 0;
    Reflect.set(window, "turnstile", {
      execute(widgetId: string) {
        const callback = widgets.get(widgetId)?.["callback"];
        if (typeof callback === "function") {
          window.setTimeout(() => callback("valid-turnstile-token-for-e2e"), 0);
        }
      },
      remove(widgetId: string) {
        widgets.delete(widgetId);
      },
      render(_container: HTMLElement, options: Record<string, unknown>) {
        nextId += 1;
        const widgetId = `widget-${nextId}`;
        widgets.set(widgetId, options);
        return widgetId;
      },
      reset() {},
    });
  });
}
