import assert from "node:assert/strict";
import { readV6Evidence, V6_ROOT } from "../v6/evidence.ts";
import { pinnedBytes } from "../v6/history.ts";

export const V6_PINS_SHA = "68a77bc0b8737b24c08ae83625d548a20ca751156f28642fe67370254fc19525";

/** V6 and its entry points remain byte-identical, executable historical evidence.
 * Do not repoint the old reader: its source bytes are part of the V6 seal. */
export function readHistoricalPublication(root = process.cwd()) {
  pinnedBytes({ path: `${V6_ROOT}/pins.json`, sha256: V6_PINS_SHA }, root);
  const publication = readV6Evidence(root);
  assert.equal(publication.provenance.version, "approved24-independent-evidence-v6");
  return publication;
}
