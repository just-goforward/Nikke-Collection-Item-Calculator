/** JSON-only, UTF-16 code-unit key order; arrays retain order; no whitespace.
 * SHA-256 and Ed25519 always consume UTF-8 of this serialization. No locale sorting.
 * Unsupported JSON values are rejected, not silently omitted.
 */
export function canonicalPublicationJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, canonicalPublicationJson).join(",")}]`;
  if (typeof value === "object" && value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalPublicationJson(Reflect.get(value, key))}`)
      .join(",")}}`;
  }
  throw new Error("publication_not_json");
}
