// Historical-reader compatibility only. First-publication generator sources and
// seals are authenticated data; this module never presents them as active v5 proof.
import { HISTORICAL_ROOT, readFirstPublication, readHistorical } from "../v5/history.ts";

export const V2_ROOT = `${HISTORICAL_ROOT}/v2`;
export function readV2Evidence(root = process.cwd()) {
  return readFirstPublication(root);
}
export function authenticateHistoricalArchive(root = process.cwd()) {
  return readHistorical(root).physical;
}
