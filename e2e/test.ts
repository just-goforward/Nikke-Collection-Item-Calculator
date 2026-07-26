import { test as base } from "@playwright/test";

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

const test = base.extend<{ localeFontRoute: undefined }>({
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
