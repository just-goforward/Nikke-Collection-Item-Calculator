import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CertifiedOutput } from "../src/certified/types.ts";
import { APPROVED_PANEL_DIRECTORY, fileSha256 } from "./certified-staging-approved-panel.ts";
import type { OracleInput } from "./certified-staging-oracle.ts";

export const PILOT_ENDPOINT_FIXTURE_PATH = `${APPROVED_PANEL_DIRECTORY}/pilot-endpoints.json`;
const provenancePath = `${APPROVED_PANEL_DIRECTORY}/pilot-endpoints-provenance.json`;
export const PILOT_ENDPOINT_IDS = [
  "original-2",
  "original-6",
  "original-8",
  "original-10",
  "original-12",
  "original-18",
] as const;
export type FrozenPilotEndpointRow = {
  id: string;
  input: Pick<OracleInput, "grade" | "level" | "exp" | "stock">;
  output: CertifiedOutput;
};
/** Frozen historical witness rows are replay inputs, never new proof results. */
export function loadFrozenPilotEndpoints() {
  assert.equal(
    fileSha256(PILOT_ENDPOINT_FIXTURE_PATH),
    "301483c331d467a0d8c53568f271c5a893d941340a8bb0238012af9821f10b45",
  );
  assert.equal(
    fileSha256(provenancePath),
    "4c5286593cff0000b6e8b5ef7cf5fe51fd39bdd4e11a3bbf1c77198649e46f42",
  );
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8")) as {
    original: { path: string; sha256: string; bytes: number };
    selectedIds: string[];
    fixture: { path: string; sha256: string; rows: number };
    rowSha256: { id: string; sha256: string }[];
  };
  assert.equal(
    provenance.original.sha256,
    "372d7263d0778304d5c5195d014553d70c8dc744892988b8523d9380fe60e88b",
  );
  assert.deepEqual(provenance.selectedIds, PILOT_ENDPOINT_IDS);
  assert.equal(provenance.fixture.rows, 6);
  assert.equal(provenance.fixture.path, PILOT_ENDPOINT_FIXTURE_PATH);
  assert.equal(provenance.fixture.sha256, fileSha256(PILOT_ENDPOINT_FIXTURE_PATH));
  const rows = JSON.parse(
    readFileSync(PILOT_ENDPOINT_FIXTURE_PATH, "utf8"),
  ) as FrozenPilotEndpointRow[];
  assert.deepEqual(
    rows.map((row) => row.id),
    PILOT_ENDPOINT_IDS,
  );
  assert.ok(rows.every((row) => row.output.waiting.strictBoundaryWitness));
  assert.deepEqual(
    rows.map((row) => ({
      id: row.id,
      sha256: createHash("sha256").update(JSON.stringify(row)).digest("hex"),
    })),
    provenance.rowSha256,
  );
  return { rows, provenance, provenancePath };
}
