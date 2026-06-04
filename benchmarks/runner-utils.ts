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

export function csvEscape(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
