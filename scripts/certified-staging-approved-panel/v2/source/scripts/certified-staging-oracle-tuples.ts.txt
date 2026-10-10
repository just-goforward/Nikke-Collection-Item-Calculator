import {
  makeTriple as originalMakeTriple,
  mapTriple as originalMapTriple,
} from "./certified-staging-oracle.ts";

// The frozen oracle calls these callbacks at exactly 0, 1 and 2. Keep its
// provenance-bound source and runtime function identities unchanged.
export const mapTriple = originalMapTriple as <T, U>(
  values: readonly [T, T, T],
  transform: (value: T, index: 0 | 1 | 2) => U,
) => [U, U, U];
export const makeTriple = originalMakeTriple as <T>(
  transform: (index: 0 | 1 | 2) => T,
) => [T, T, T];
