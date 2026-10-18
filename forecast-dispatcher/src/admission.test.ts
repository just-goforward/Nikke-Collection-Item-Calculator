import { expect, it, vi } from "vitest";
import { initializePublication } from "../../shared/forecast-publication/store.ts";
import { CERTIFIED_ENGINE_CODE_HASH } from "../../shared/generated/certifiedEngineBuild.ts";
import { admitCandidates } from "./admission.ts";

vi.mock("../../shared/forecast-publication/store.ts", () => ({
  sealCandidate: vi.fn(async () => ({ hash: "sealed" })),
  createReview: vi.fn(async () => "review"),
  publicationErrorCode: () => "publication_operation_failed",
  initializePublication: vi.fn(async () => ({ environment: "staging", sequence: 0 })),
}));

it.each([
  ["observed-median-v2", undefined, false],
  ["observed-median-v2", CERTIFIED_ENGINE_CODE_HASH, true],
  ["observed-median-v2", "0".repeat(64), false],
  ["observed-mean-thursday-v1", undefined, true],
] as const)("gates %s with engine coverage %s", async (cadence, hash, allowed) => {
  const store = await import("../../shared/forecast-publication/store.ts");
  vi.mocked(store.sealCandidate).mockClear();
  vi.mocked(store.createReview).mockClear();
  const completions: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...args: unknown[]) {
          values = args;
          return this;
        },
        async run() {
          if (sql.includes("SET state=?")) completions.push(values);
          return { meta: { changes: 1 } };
        },
        async all() {
          return { results: [{ candidate_id: "one", cadence_version: cadence }] };
        },
        async first() {
          return { attempts: 1 };
        },
      };
    },
  } as D1Database;
  const active = await initializePublication(db, "staging");
  await admitCandidates(
    db,
    active,
    1000,
    hash
      ? [
          {
            cadenceVersion: cadence,
            engineBuildHash: hash,
            panelAnchorSha256: "a".repeat(64),
          },
        ]
      : [],
  );
  expect(store.sealCandidate).toHaveBeenCalledTimes(allowed ? 1 : 0);
  expect(store.createReview).toHaveBeenCalledTimes(allowed ? 1 : 0);
  expect(completions[0]?.slice(0, 3)).toEqual(
    allowed ? ["ready", null, 0] : ["pending", "awaiting_evidence_panel", 1],
  );
  expect(completions[0]?.[3]).toBe(1000 + (allowed ? 5 * 60_000 : 6 * 60 * 60_000));
});
