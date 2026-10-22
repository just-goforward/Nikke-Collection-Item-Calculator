import { type BrowserContext, test as base, type Page } from "@playwright/test";
import type { PreviewServer } from "vite";

export function createGate() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export async function closePreviewServer(server: PreviewServer | null) {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.httpServer.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function waitForSignal(signal: Promise<void>, label: string, timeoutMs = 10_000) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export async function withCleanup<T>(task: () => Promise<T>, cleanup: () => void) {
  try {
    return await task();
  } finally {
    cleanup();
  }
}

const routePatterns = new WeakMap<Page | BrowserContext, unknown[]>();

/** Records the URL pattern of every later route()/routeFromHAR() call on `target`. */
function recordRoutePatterns(target: Page | BrowserContext) {
  if (routePatterns.has(target)) return;
  const patterns: unknown[] = [];
  routePatterns.set(target, patterns);
  const original = { route: target.route, routeFromHAR: target.routeFromHAR };
  // Traces now show this wrapper as the user frame of route()/routeFromHAR(); the caller is next.
  Object.assign(target, {
    route: (url: unknown, ...rest: unknown[]) => {
      patterns.push(url);
      return Reflect.apply(original.route, target, [url, ...rest]);
    },
    routeFromHAR: (har: unknown, options?: { url?: unknown }) => {
      patterns.push(options?.url ?? "**/*");
      return Reflect.apply(original.routeFromHAR, target, [har, options]);
    },
  });
}

/**
 * URL patterns routed so far (unroutes not subtracted) on the fixture `page` and its context,
 * or null for a page the fixture did not create.
 */
export function registeredRoutePatterns(page: Page): unknown[] | null {
  const own = routePatterns.get(page);
  const shared = routePatterns.get(page.context());
  return own && shared ? [...shared, ...own] : null;
}

const pinRefusals = new WeakMap<Page, string[]>();

/** Records a script URL that pinWallClock refused to shift; the fixture page fails on it. */
export function recordPinRefusal(page: Page, url: string) {
  pinRefusals.set(page, [...(pinRefusals.get(page) ?? []), url]);
}

/** Returns and clears the script URLs that pinWallClock refused to shift on `page`. */
export function takePinRefusals(page: Page): string[] {
  const urls = pinRefusals.get(page) ?? [];
  pinRefusals.delete(page);
  return urls;
}

const test = base.extend<{ localeFontRoute: undefined }>({
  // Tracks context routes from creation, before any other fixture can register one.
  context: async ({ context }, use) => {
    recordRoutePatterns(context);
    await use(context);
  },
  page: async ({ page }, use) => {
    recordRoutePatterns(page);
    await use(page);
    const refused = takePinRefusals(page);
    if (refused.length > 0) {
      throw new Error(
        `pinWallClock refused to shift these scripts, which ran as throwing stubs: ${refused.join(", ")}`,
      );
    }
  },
  localeFontRoute: [
    async ({ page }, use) => {
      await page.route("https://cdn.jsdelivr.net/**", (route) =>
        route.fulfill({ body: "", contentType: "text/css", status: 200 }),
      );
      await use(undefined);
    },
    { auto: true },
  ],
});

export { test };
