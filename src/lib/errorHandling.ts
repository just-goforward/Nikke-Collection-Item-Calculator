export function ignoreExpectedError(reason: string, error?: unknown): void {
  if (import.meta.env?.DEV !== true) return;

  if (error instanceof Error) {
    console.debug("[expected-error]", reason, error.message);
    return;
  }

  console.debug("[expected-error]", reason);
}
