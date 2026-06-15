const MAX_SOURCE_HOST_LENGTH = 80;
const STRATEGY_ORDER = ["single", "supply"] as const;

export type Strategy = (typeof STRATEGY_ORDER)[number] | "unknown";

export function normalizeSourceHost(value: unknown) {
  const raw =
    typeof value === "string"
      ? value
          .trim()
          .toLowerCase()
          .replace(/^www\./, "")
      : "";
  if (!raw) return "unknown";
  if (raw === "direct" || raw === "same-site" || raw === "unknown") return raw;
  if (raw.length > MAX_SOURCE_HOST_LENGTH) return "unknown";
  if (!/^[a-z0-9.-]+$/.test(raw)) return "unknown";
  if (
    raw.includes("..") ||
    raw.startsWith(".") ||
    raw.endsWith(".") ||
    raw.startsWith("-") ||
    raw.endsWith("-")
  ) {
    return "unknown";
  }
  return raw;
}

export function normalizeStrategy(value: unknown): Strategy {
  return STRATEGY_ORDER.includes(value as (typeof STRATEGY_ORDER)[number])
    ? (value as (typeof STRATEGY_ORDER)[number])
    : "unknown";
}

export function normalizeDiagnosticToken(value: unknown) {
  const token = String(value || "").trim();
  return /^[a-zA-Z0-9_.-]{1,64}$/.test(token) ? token : "unknown";
}
