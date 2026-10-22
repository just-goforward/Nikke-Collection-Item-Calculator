import { expect, it, vi } from "vitest";
import { CERTIFIED_EVIDENCE_COVERAGE } from "../../shared/certifiedEvidenceCoverage.ts";
import { initializePublication } from "../../shared/forecast-publication/store.ts";
import { TEST_PUBLICATION_COVERAGE } from "../../shared/forecast-publication/test-coverage.ts";
import { CERTIFIED_ENGINE_CODE_HASH } from "../../shared/generated/certifiedEngineBuild.ts";
import { admitCandidates } from "./admission.ts";

vi.mock("../../shared/forecast-publication/store.ts", () => ({
  sealCandidate: vi.fn(async () => ({ hash: "sealed" })),
  createReview: vi.fn(async () => "review"),
  initializePublication: vi.fn(async () => ({ environment: "staging", sequence: 0 })),
}));

it.each([
  ["observed-median-v2", undefined, false],
  ["observed-median-v2", CERTIFIED_ENGINE_CODE_HASH, true],
  ["observed-median-v2", "0".repeat(64), false],
  ["observed-mean-thursday-v1", undefined, false],
  // The real registry now includes the reviewed v11 engine; unknown cadences still fail closed.
  ["observed-median-v2", "sealed", true],
  ["unknown-cadence", "sealed", false],
  ["", "sealed", false],
  [null, "sealed", false],
  [undefined, "sealed", false],
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
          return {
            results: [
              {
                candidate_id: "one",
                created_at: "2026-10-07T03:00:00.000Z",
                cadence_version: cadence,
              },
            ],
          };
        },
        async first() {
          // The supersession probe is a separate statement; by default no newer candidate.
          if (sql.includes("c.created_at>?")) return null;
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
    hash === "sealed"
      ? CERTIFIED_EVIDENCE_COVERAGE
      : hash
        ? [
            {
              cadenceVersion: cadence ?? "",
              engineBuildHash: hash,
              panelAnchorSha256: "a".repeat(64),
            },
          ]
        : [],
  );
  expect(store.sealCandidate).toHaveBeenCalledTimes(allowed ? 1 : 0);
  expect(store.createReview).toHaveBeenCalledTimes(allowed ? 1 : 0);
  expect(completions[0]?.slice(0, 2)).toEqual(
    allowed
      ? ["ready", null]
      : cadence === "observed-median-v2"
        ? ["pending", "awaiting_evidence_panel"]
        : ["dead", "unsupported_cadence"],
  );
  expect(completions[0]?.[2]).toBe(
    1000 + (!allowed && cadence === "observed-median-v2" ? 6 * 60 * 60_000 : 5 * 60_000),
  );
});

/** A fake D1 whose statements are matched by shape, so one fixture can model the page,
 * the claim, the supersession probe and the completion write. */
function fakeDb(options: {
  candidate?: { candidate_id: string; created_at: string; cadence_version: string } | null;
  newer?: { candidate_id: string } | null;
}) {
  const completions: unknown[][] = [];
  const probes: unknown[][] = [];
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
          return { results: options.candidate ? [options.candidate] : [] };
        },
        async first() {
          if (sql.includes("c.created_at>?")) {
            probes.push(values);
            return options.newer ?? null;
          }
          return { attempts: 1 };
        },
      };
    },
    async batch(statements: { all(): Promise<unknown> }[]) {
      return Promise.all(statements.map((statement) => statement.all()));
    },
  } as D1Database;
  return { db, completions, probes };
}
const POLICY_ACTIVE = {
  environment: "staging" as const,
  sequence: 3,
  candidate_id: "forecast-active",
  operation_id: null,
  signed_pointer_json: null,
};

it("supersedes an older candidate when a newer one already has a live review", async () => {
  const store = await import("../../shared/forecast-publication/store.ts");
  vi.mocked(store.sealCandidate).mockClear();
  vi.mocked(store.createReview).mockClear();
  const { db, completions, probes } = fakeDb({
    candidate: {
      candidate_id: "forecast-old",
      created_at: "2026-10-07T03:00:00.000Z",
      cadence_version: "observed-median-v2",
    },
    newer: { candidate_id: "forecast-new" },
  });
  await admitCandidates(db, POLICY_ACTIVE, 1000, TEST_PUBLICATION_COVERAGE);
  // No second approval request is created for the same sequence.
  expect(store.createReview).not.toHaveBeenCalled();
  expect(store.sealCandidate).not.toHaveBeenCalled();
  // Terminal, so a later run cannot renew it either; the code is registered and persisted.
  expect(completions[0]?.slice(0, 2)).toEqual(["dead", "publication_review_superseded"]);
  expect(probes).toHaveLength(1);
});

it("still admits the newest candidate, which has nothing newer to defer to", async () => {
  const store = await import("../../shared/forecast-publication/store.ts");
  vi.mocked(store.sealCandidate).mockClear();
  vi.mocked(store.createReview).mockClear();
  const { db, completions } = fakeDb({
    candidate: {
      candidate_id: "forecast-new",
      created_at: "2026-10-07T03:01:00.000Z",
      cadence_version: "observed-median-v2",
    },
    newer: null,
  });
  await admitCandidates(db, POLICY_ACTIVE, 1000, TEST_PUBLICATION_COVERAGE);
  expect(store.sealCandidate).toHaveBeenCalledTimes(1);
  expect(store.createReview).toHaveBeenCalledTimes(1);
  expect(completions[0]?.slice(0, 2)).toEqual(["ready", null]);
});

it("logs the supersession with its registered code and the terminal state", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const { db } = fakeDb({
      candidate: {
        candidate_id: "forecast-old",
        created_at: "2026-10-07T03:00:00.000Z",
        cadence_version: "observed-median-v2",
      },
      newer: { candidate_id: "forecast-new" },
    });
    await admitCandidates(db, POLICY_ACTIVE, 1000, TEST_PUBLICATION_COVERAGE);
    const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain('"event":"publication_candidate_review_failed"');
    expect(logged).toContain('"code":"publication_review_superseded"');
    expect(logged).toContain('"state":"dead"');
    expect(logged).toContain('"candidateId":"forecast-old"');
  } finally {
    warn.mockRestore();
  }
});

it("compares the supersession candidate with the same order the page selects with", async () => {
  const { db, probes } = fakeDb({
    candidate: {
      candidate_id: "forecast-old",
      created_at: "2026-10-07T03:00:00.000Z",
      cadence_version: "observed-median-v2",
    },
    newer: null,
  });
  await admitCandidates(db, POLICY_ACTIVE, 1000, TEST_PUBLICATION_COVERAGE);
  // created_at (TEXT), created_at, candidate_id, active candidate, environment, sequence, now
  expect(probes[0]).toEqual([
    "2026-10-07T03:00:00.000Z",
    "2026-10-07T03:00:00.000Z",
    "forecast-old",
    "forecast-active",
    "staging",
    3,
    1000,
  ]);
});
