export function envValue(name: string): string | undefined {
  return process.env[name];
}

export function setEnvValue(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

export function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

export function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

export function parseBoolean(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

export function parseList(value: string | undefined, fallback: readonly string[]): string[] {
  const parsed = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : [...fallback];
}

export function parseSeeds(value: string | undefined, fallback: readonly number[]): number[] {
  return parseList(value, fallback.map(String)).map((seed) => parseNonNegativeInteger(seed, 0));
}

export function isErrorWithCode(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error;
}

export function ignoreExpectedRunnerError(reason: string, error?: unknown): void {
  if (!parseBoolean(envValue("BENCHMARK_DEBUG"))) return;

  if (error instanceof Error) {
    console.debug("[benchmark expected-error]", reason, error.message);
    return;
  }

  console.debug("[benchmark expected-error]", reason);
}

export function csvEscape(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
