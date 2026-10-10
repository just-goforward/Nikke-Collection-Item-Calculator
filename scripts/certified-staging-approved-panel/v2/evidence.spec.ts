import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  ARCHIVED_SOURCES,
  FIRST_PINS_SHA,
  readFirstPublication,
  readHistorical,
  sha256,
  V2_ROOT,
} from "../v5/history.ts";
import { authenticateHistoricalArchive, readV2Evidence } from "./evidence.ts";

it("preserves first v2 pins, complete generation sources and original historical bytes as data", () => {
  const first = readFirstPublication();
  expect(readV2Evidence()).toEqual(first);
  expect(sha256(readFileSync(`${V2_ROOT}/pins.json.txt`))).toBe(FIRST_PINS_SHA);
  expect(first.provenance.generation.sources).toHaveLength(10);
  expect(first.provenance.generation.sourceHash).toBe(
    "5db534bae8f66e54d872a84595b22e8c92321a46fe60476ef0b4b7088809c96b",
  );
  expect(sha256(first.physicalBytes)).toBe(
    "690bf2510d4f92885719b12e86309501118ac6e71d6c81817c5ff41f0216ccb2",
  );
  expect(authenticateHistoricalArchive()).toEqual(readHistorical().physical);
  expect(ARCHIVED_SOURCES.map(({ path }) => path)).toEqual([
    "scripts/certified-staging-oracle-physical-supply.ts",
    "scripts/certified-staging-oracle.ts",
    "shared/game.ts",
  ]);
});
