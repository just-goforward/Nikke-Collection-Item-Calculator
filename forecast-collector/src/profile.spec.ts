import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { profileIngestionAdmitted, profilePhase } from "./profile";

describe("staging profiling", () => {
  it.each([
    ["completed", 359_000, "normal", true],
    ["failure", 359_000, "normal", false],
    ["running", 359_000, "normal", false],
    ["completed", -1, "normal", false],
    ["completed", 360_001, "normal", false],
    ["completed", 359_000, "profile-board-48:deploy", false],
  ])("checks durable status and freshness: %s %s %s", async (status, time, id, expected) => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec(`CREATE TABLE collector_invocations
        (invocation_id TEXT, status TEXT, finished_at TEXT,
         scheduled_at TEXT, started_at TEXT);
        CREATE TABLE runtime_ingestion_runs (started_at TEXT, token TEXT DEFAULT 'ingestion');`);
      sqlite
        .prepare("INSERT INTO collector_invocations VALUES (?,?,?,?,?)")
        .run(id, status, new Date(time).toISOString(), "slot", "start");
      const db = {
        prepare: (sql: string) => ({
          bind: (...values: string[]) => ({
            first: async () => sqlite.prepare(sql).get(...values),
          }),
        }),
      };
      expect(await profileIngestionAdmitted(db, 360_000)).toBe(expected);
    } finally {
      sqlite.close();
    }
  });
  it.each(["poll-only", "ingest-only", "board-48", "board-56", "alternate"])(
    "accepts %s only in staging",
    (phase) => {
      expect(profilePhase({ ENVIRONMENT: "staging", COLLECTOR_PROFILE_PHASE: phase })).toBe(phase);
      expect(profilePhase({ ENVIRONMENT: "production", COLLECTOR_PROFILE_PHASE: phase })).toBe(
        "off",
      );
    },
  );
  it.each(["failure", "running", "circuit_open", "consumed", "stale"])(
    "rejects mixed history: %s",
    async (history) => {
      const sqlite = new DatabaseSync(":memory:");
      try {
        sqlite.exec(`CREATE TABLE collector_invocations
          (invocation_id TEXT, status TEXT, finished_at TEXT,
           scheduled_at TEXT, started_at TEXT);
          CREATE TABLE runtime_ingestion_runs (started_at TEXT, token TEXT DEFAULT 'ingestion');`);
        const insert = sqlite.prepare("INSERT INTO collector_invocations VALUES (?,?,?,?,?)");
        const finished = new Date(history === "stale" ? -1 : 300_000).toISOString();
        insert.run("success", "completed", finished, "a", "a");
        if (history === "consumed") {
          sqlite.prepare("INSERT INTO runtime_ingestion_runs(started_at) VALUES (?)").run(finished);
        } else if (history !== "stale") {
          insert.run("newer", history, null, "b", "b");
        }
        const db = {
          prepare: (sql: string) => ({
            bind: (...values: string[]) => ({
              first: async () => sqlite.prepare(sql).get(...values),
            }),
          }),
        };
        expect(await profileIngestionAdmitted(db, 360_000)).toBe(false);
      } finally {
        sqlite.close();
      }
    },
  );
  it.each([undefined, "off", "invalid"])("defaults %s to unchanged behavior", (phase) => {
    expect(
      profilePhase({
        ENVIRONMENT: "staging",
        ...(phase === undefined ? {} : { COLLECTOR_PROFILE_PHASE: phase }),
      }),
    ).toBe("off");
  });
  it.each([null, { invocation_id: "completed" }])("requires durable admission %j", async (row) => {
    const first = vi.fn().mockResolvedValue(row);
    const bind = vi.fn().mockReturnValue({ first });
    const prepare = vi.fn().mockReturnValue({ bind });
    expect(await profileIngestionAdmitted({ prepare }, 360_000)).toBe(Boolean(row));
    expect(bind).toHaveBeenCalledWith("1970-01-01T00:00:00.000Z", "1970-01-01T00:06:00.000Z");
  });
});
