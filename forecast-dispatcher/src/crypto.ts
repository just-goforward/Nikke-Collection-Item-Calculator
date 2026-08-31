export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function base64Url(value: Uint8Array | string) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export async function importGithubAppPrivateKey(pem: string) {
  const normalized = pem.replace(/\\n/g, "\n").trim();
  const pkcs8 = normalized.includes("BEGIN RSA PRIVATE KEY")
    ? wrapPkcs1AsPkcs8(readPem(normalized, "RSA PRIVATE KEY"))
    : readPem(normalized, "PRIVATE KEY");
  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function readPem(pem: string, label: string) {
  const begin = `-----BEGIN ${label}-----`;
  const end = `-----END ${label}-----`;
  if (!pem.includes(begin) || !pem.includes(end)) throw new Error("github_app_private_key_format");
  const body = pem.slice(pem.indexOf(begin) + begin.length, pem.indexOf(end)).replace(/\s/g, "");
  if (!body || !/^[A-Za-z0-9+/=]+$/.test(body)) throw new Error("github_app_private_key_format");
  const binary = atob(body);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}

function wrapPkcs1AsPkcs8(pkcs1: ArrayBuffer) {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaAlgorithm = Uint8Array.of(
    0x30,
    0x0d,
    0x06,
    0x09,
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01,
    0x05,
    0x00,
  );
  const privateKey = encodeDer(0x04, new Uint8Array(pkcs1));
  return encodeDer(0x30, concat(version, rsaAlgorithm, privateKey)).buffer;
}

function encodeDer(tag: number, body: Uint8Array) {
  return concat(Uint8Array.of(tag), encodeDerLength(body.length), body);
}

function encodeDerLength(length: number) {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>>= 8;
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concat(...parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
