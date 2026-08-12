import type { Locator, Page } from "@playwright/test";

export async function maxBackgroundChannel(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    const channels = getComputedStyle(element).backgroundColor.match(/\d+/g)?.map(Number) ?? [255];
    return Math.max(...channels.slice(0, 3));
  });
}

export async function serveStagingDocument(
  page: Page,
  staging?: { endpoint: string; turnstileSiteKey: string },
) {
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.resourceType() !== "document" || url.searchParams.get("statsEnv") !== "staging") {
      await route.continue();
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
