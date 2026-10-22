// Site-local typing: do not import the backend Worker or its runtime declarations.
type TimingSafeSubtle = SubtleCrypto & {
  timingSafeEqual?: (left: ArrayBuffer, right: ArrayBuffer) => boolean;
};

// A format check is not an entropy check. Provision 32 random bytes as unpadded base64url.
export function validProbeSecret(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43,}$/.test(value);
}

// Same fixed-size hash comparison pattern as the backend's tokensMatch.
export async function tokensMatch(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const subtle: TimingSafeSubtle = crypto.subtle;
  if (subtle.timingSafeEqual) return subtle.timingSafeEqual(left, right);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}
