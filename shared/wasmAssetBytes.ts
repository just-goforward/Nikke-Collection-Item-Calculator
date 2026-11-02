export type WasmAssetPin = { bytes: number; sha256: string };

export async function assertWasmAssetBytes(
  bytes: Uint8Array, asset: WasmAssetPin, prefix: string,
): Promise<Uint8Array> {
  if (bytes.byteLength !== asset.bytes) throw new Error(`${prefix}_hash_mismatch`);
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  const actual = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  if (actual !== asset.sha256) throw new Error(`${prefix}_hash_mismatch`);
  return bytes;
}

/** The declared artifact size bounds the read; verification precedes native loading.
 * No stale alias, redirected latest artifact or second fetch is an integrity fallback.
 */
export async function fetchVerifiedWasmAsset(
  url: string | URL, asset: WasmAssetPin, prefix: string, options?: RequestInit,
): Promise<Uint8Array> {
  const response = options === undefined ? await fetch(url) : await fetch(url, options);
  if (!response.ok || !response.body) throw new Error(`${prefix}_fetch_failed`);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > asset.bytes) throw new Error(`${prefix}_hash_mismatch`);
      parts.push(item.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  if (length !== asset.bytes) throw new Error(`${prefix}_hash_mismatch`);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return assertWasmAssetBytes(bytes, asset, prefix);
}
