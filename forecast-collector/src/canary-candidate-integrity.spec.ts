import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as candidateValidation from "../../shared/supplyForecastCandidate";
import * as projection from "../../shared/supplyForecastProjection";
import { readV2CandidateIntegrity } from "./canary-v2-evidence";
import { buildForecastCandidate, resolveSoloSchedule } from "./candidate";
import { persistCandidate, persistSourceItemsAndEvents, readCanaryReport } from "./db";
import { runtimeTestDb } from "./test-runtime-db";
import type { CandidateBuildResult, NormalizedSourceItem, ScheduleEvent } from "./types";

const schema = readFileSync(new URL("../fixtures/schema-v27-test.sql", import.meta.url), "utf8");
const now = Date.parse("2026-08-24T00:00:00.000Z");
const source: NormalizedSourceItem = {
  source: "naver-board-56",
  itemId: "8060044",
  url: "https://game.naver.com/lounge/nikke/board/detail/8060044",
  title: "8월 솔로 레이드",
  excerpt: "솔로 레이드 8월 20일 12:00 ~ 8월 27일 4:59",
  normalizedText: "솔로 레이드 8월 20일 12:00 ~ 8월 27일 4:59",
  publishedAt: "2026-08-18T03:00:00.000Z",
  contentHash: "a".repeat(64),
  structured: true,
  official: true,
};
const event: ScheduleEvent = {
  eventId: "naver-board-56:8060044:solo",
  eventType: "solo",
  sourceItem: source,
  startsAt: "2026-08-20T03:00:00.000Z",
  endsAt: "2026-08-26T19:59:00.000Z",
  scheduleStatus: "confirmed",
  manualReview: false,
  reason: null,
};
let fixture: CandidateBuildResult;
let sqlite: DatabaseSync;
let db: D1Database;
class ValidatorDefect extends Error {}
const unexpectedFailures = [
  { name: "TypeError", failure: new TypeError("private validator details") },
  { name: "ReferenceError", failure: new ReferenceError("private validator details") },
  { name: "RangeError", failure: new RangeError("private validator details") },
  { name: "SyntaxError", failure: new SyntaxError("private validator details") },
  { name: "EvalError", failure: new EvalError("private validator details") },
  { name: "URIError", failure: new URIError("private validator details") },
  { name: "AggregateError", failure: new AggregateError([], "private validator details") },
  { name: "custom Error subclass", failure: new ValidatorDefect("private validator details") },
  { name: "string", failure: "private validator details" },
  { name: "object", failure: { message: "private validator details", constructor: Error } },
  { name: "null", failure: null },
  { name: "undefined", failure: undefined },
];

beforeAll(async () => {
  const resolved = resolveSoloSchedule([event], now);
  if (!resolved) throw new Error("fixture_schedule_missing");
  fixture = await buildForecastCandidate(
    resolved,
    [],
    { status: "x_unavailable", sourceItem: null, reason: "test" },
    now,
    1,
  );
});
beforeEach(async () => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(schema);
  db = runtimeTestDb(sqlite);
  await persistSourceItemsAndEvents(db, [source], [event], new Date(now).toISOString());
  await persistCandidate(db, fixture, event.eventId, "2026-08-24", 1);
});
afterEach(() => {
  vi.restoreAllMocks();
  sqlite.close();
});

describe("candidate schema admission rejection contract", () => {
  it("accepts the existing fixture and reports a plain Error from a validator as invalid", () => {
    expect(
      candidateValidation.supplyForecastCandidateSchema.safeParse(fixture.candidate).success,
    ).toBe(true);
    vi.spyOn(projection, "assertLedgerForecastProfiles").mockImplementation(() => {
      throw new Error("forecast_profiles_do_not_match_ledger");
    });
    expect(
      candidateValidation.supplyForecastCandidateSchema.safeParse(fixture.candidate).success,
    ).toBe(false);
  });

  it.each(unexpectedFailures)(
    "propagates $name from inside admitsCandidate",
    async ({ failure }) => {
      vi.spyOn(projection, "assertLedgerForecastProfiles").mockImplementation(() => {
        throw failure;
      });
      await expect(
        (async () =>
          candidateValidation.supplyForecastCandidateSchema.safeParse(fixture.candidate))(),
      ).rejects.toBe(failure);
    },
  );
});

describe.each([
  {
    name: "legacy canary",
    readInvalid: async (database: D1Database) =>
      (await readCanaryReport(database, now, "test-sha")).candidates.invalid,
    failureEvent: "canary_candidate_invariant_check_failed",
  },
  {
    name: "v2 canary",
    readInvalid: async (database: D1Database) =>
      (await readV2CandidateIntegrity(database)).candidates,
    failureEvent: "canary_v2_candidate_invariant_check_failed",
  },
])("$name candidate integrity", ({ readInvalid, failureEvent }) => {
  it("accepts a valid candidate and counts a hash mismatch as invalid", async () => {
    expect(await readInvalid(db)).toBe(0);
    await db.prepare("UPDATE forecast_candidates SET payload_hash=?").bind("0".repeat(64)).run();
    expect(await readInvalid(db)).toBe(1);
  });

  it.each(["{", "{}"])(
    "counts expected JSON/schema rejection without an error log: %s",
    async (payload) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      await db.prepare("UPDATE forecast_candidates SET payload_json=?").bind(payload).run();
      expect(await readInvalid(db)).toBe(1);
      expect(error).not.toHaveBeenCalled();
    },
  );

  it("keeps invariant rejection fail-closed and logs only its fixed code", async () => {
    const rejected = {
      ...fixture.candidate,
      sourceEvidence: fixture.candidate.sourceEvidence.map((evidence) => ({
        ...evidence,
        url: "https://invalid.example/private-candidate-data",
      })),
    };
    expect(candidateValidation.supplyForecastCandidateSchema.safeParse(rejected).success).toBe(
      true,
    );
    await db
      .prepare("UPDATE forecast_candidates SET payload_json=?")
      .bind(JSON.stringify(rejected))
      .run();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await readInvalid(db)).toBe(1);
    expect(error.mock.calls).toEqual([[JSON.stringify({ event: failureEvent })]]);
  });

  it.each(unexpectedFailures)(
    "propagates invariant $name instead of counting invalid candidates or logging private data",
    async ({ failure }) => {
      vi.spyOn(candidateValidation, "assertForecastCandidateInvariants").mockImplementation(() => {
        throw failure;
      });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(readInvalid(db)).rejects.toBe(failure);
      expect(error).not.toHaveBeenCalled();
    },
  );

  it("propagates a TypeError from inside schema admission as unavailable evidence", async () => {
    const failure = new TypeError("private validator details");
    vi.spyOn(projection, "assertLedgerForecastProfiles").mockImplementation(() => {
      throw failure;
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(readInvalid(db)).rejects.toBe(failure);
    expect(error).not.toHaveBeenCalled();
  });

  it("propagates unexpected schema-check failures instead of counting invalid candidates", async () => {
    const failure = new Error("private schema failure");
    vi.spyOn(candidateValidation.supplyForecastCandidateSchema, "safeParse").mockImplementation(
      () => {
        throw failure;
      },
    );
    await expect(readInvalid(db)).rejects.toBe(failure);
  });

  it("propagates crypto failures instead of counting invalid candidates", async () => {
    const failure = new Error("private crypto failure");
    vi.spyOn(crypto.subtle, "digest").mockRejectedValue(failure);
    await expect(readInvalid(db)).rejects.toBe(failure);
  });

  it("propagates D1 failures instead of counting invalid candidates", async () => {
    const failure = new Error("private database failure");
    vi.spyOn(db, "prepare").mockImplementation(() => {
      throw failure;
    });
    await expect(readInvalid(db)).rejects.toBe(failure);
  });
});
