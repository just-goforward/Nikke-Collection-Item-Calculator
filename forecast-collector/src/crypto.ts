import { isDeeplyFrozen } from "../../shared/certifiedSupplyModel.ts";

export async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Only registered deeply-frozen values are memoized; weak keys retain neither
// mutable input state nor completed invocation graphs.
const canonicalJsonCache = new WeakMap<object, string>();
export function stableJson(
  value: unknown,
  cache: WeakMap<object, string> = canonicalJsonCache,
): string {
  const memoizable = cache && typeof value === "object" && value !== null && isDeeplyFrozen(value);
  if (memoizable) {
    const cached = cache.get(value);
    if (cached !== undefined) return cached;
  }
  let result: string;
  if (Array.isArray(value))
    result = `[${value.map((entry) => stableJson(entry, cache)).join(",")}]`;
  else if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    result = `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry, cache)}`).join(",")}}`;
  } else result = JSON.stringify(value);
  if (memoizable) cache.set(value, result);
  return result;
}

export async function timingSafeBearer(request: Request, expectedToken: string) {
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!provided || !expectedToken) return false;
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(provided)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expectedToken)),
  ]);
  const left = new Uint8Array(providedHash);
  const right = new Uint8Array(expectedHash);
  let different = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    different |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return different === 0;
}
