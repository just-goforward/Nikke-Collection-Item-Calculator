import { test as base } from "@playwright/test";

const test = base.extend<{ localeFontRoute: undefined }>({
  localeFontRoute: [
    async ({ page }, use) => {
      await page.route("https://cdn.jsdelivr.net/**", (route) =>
        route.fulfill({ body: "", contentType: "text/css", status: 200 }),
      );
      await use();
    },
    { auto: true },
  ],
});

export { test };
