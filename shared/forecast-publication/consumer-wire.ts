import { canonicalPublicationJson, type PublicationEnvelope } from "../forecastPublication.ts";
import type { PublicationBytes } from "../forecastPublicationBytes.ts";

/** Server only: stored candidate JSON may have original collector key order.
 * Reconstruct the exact canonical bytes hashed/signed by the existing v1 publisher.
 * This changes transport representation, not either signed statement or domain.
 */
export function publicationWire(envelope: PublicationEnvelope): PublicationBytes {
  const signed = (
    value:
      | PublicationEnvelope["pointer"]
      | NonNullable<PublicationEnvelope["artifact"]>["authorization"],
  ) => ({
    statement: canonicalPublicationJson(value.statement),
    signature: value.signature,
  });
  return {
    pointer: signed(envelope.pointer),
    artifact: envelope.artifact
      ? {
          authorization: signed(envelope.artifact.authorization),
          candidate: canonicalPublicationJson(envelope.artifact.candidate),
        }
      : null,
  };
}
