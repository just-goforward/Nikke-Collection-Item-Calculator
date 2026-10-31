import { publicationBytesHash } from "../../shared/forecastPublicationBytes.ts";

/** Lowercase hex SHA-256 of the exact UTF-8 bytes, from the shared publication hasher. */
export async function sha256Hex(value: string) {
  return publicationBytesHash(value);
}
