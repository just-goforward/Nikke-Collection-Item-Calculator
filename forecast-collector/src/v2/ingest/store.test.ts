import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTestSql } from "../../../../shared/testD1Sql";
import schemaSql from "../../test-schema";
import type { Metadata } from "./client";
import { IngestFailure } from "./client";
import { MonitorStore } from "./store";
import { attempts, boundary, budget, count, hits, seedBudget, state } from "./test-support/v2-db";
import { advanceScan, startScan } from "./traversal";

const db = env.FORECAST_DB;
const now = Date.parse("2026-10-18T03:00:00.000Z");
const at = (ms: number) => new Date(now + ms).toISOString();
const row = (feedId: number, createdAt: string): Metadata => ({
  feedId: String(feedId),
  title: "t",
  createdAt,
  updatedAt: createdAt,
});

async function insertRun(runId: string, stream = "A") {
  await db
    .prepare(`INSERT INTO forecast_v2_monitor_runs(run_id,stream_id,generation,kind,status,started_at)
    VALUES(?,?,1,'new','running',?)`)
    .bind(runId, stream, at(0))
    .run();
}

beforeEach(async () => {
  await reset();
  await executeTestSql(db, schemaSql, applyD1Migrations);
});
afterEach(() => vi.restoreAllMocks());

describe("T03 leases", () => {
  it("grants one of two concurrent acquisitions", async () => {
    const store = new MonitorStore(db);
    const leases = await Promise.all([
      store.acquire("A", now),
      store.acquire("A", now),
      store.acquire("A", now),
    ]);
    expect(leases.filter(Boolean)).toHaveLength(1);
    const winner = leases.find(Boolean)!;
    expect((await state(db, "A")).lease_owner).toBe(winner.owner);
    // Other streams are independent.
    expect(await store.acquire("B", now)).not.toBeNull();
  });

  it("lets a new owner take over only at or after expiry (120 s)", async () => {
    const store = new MonitorStore(db);
    const first = await store.acquire("A", now);
    expect(first?.expiresAt).toBe(at(120_000));
    expect(await store.acquire("A", now + 119_999)).toBeNull();
    const second = await store.acquire("A", now + 120_000);
    expect(second).not.toBeNull();
    expect(second!.owner).not.toBe(first!.owner);
    // The previous owner's release is a no-op.
    await store.release(first!);
    expect((await state(db, "A")).lease_owner).toBe(second!.owner);
    await store.release(second!);
    expect((await state(db, "A")).lease_owner).toBeNull();
  });

  it("fences page commits of an owner whose lease was taken over", async () => {
    const store = new MonitorStore(db);
    await insertRun("r1");
    const stale = (await store.acquire("A", now))!;
    await store.acquire("A", now + 120_000);
    const scan = advanceScan(
      startScan({ createdAt: at(-86_400_000), feedIds: [] }),
      [row(2, at(-1000)), row(1, at(-90_000_000))],
      "A",
    );
    await expect(store.commitPage(stale, "r1", scan, now + 1000)).rejects.toMatchObject({
      code: "lease_lost",
    });
    expect(await hits(db)).toEqual([]);
    expect(await boundary(db, "A")).toEqual({ createdAt: null, feedIds: [] });
  });

  it("fences budget reservations by lease", async () => {
    const store = new MonitorStore(db);
    await insertRun("r1");
    const lease = (await store.acquire("A", now))!;
    await expect(store.reserve(lease, "r1", "metadata", now + 120_000)).rejects.toMatchObject({
      code: "budget_or_lease",
    });
    expect(await budget(db, "2026-10-18")).toEqual({ metadata_used: 0, detail_used: 0 });
    expect(await attempts(db)).toEqual([]);
  });
});

describe("T03 request budget", () => {
  it.each([
    ["metadata", 240],
    ["detail", 48],
  ] as const)("admits exactly %s %s requests per game day", async (kind, limit) => {
    const store = new MonitorStore(db);
    await insertRun("r1");
    const lease = (await store.acquire("A", now))!;
    await seedBudget(db, "2026-10-18", { [kind]: limit - 1 });
    await store.reserve(lease, "r1", kind, now, kind === "detail" ? "1" : null);
    await expect(store.reserve(lease, "r1", kind, now)).rejects.toMatchObject({
      code: "budget_or_lease",
    });
    const used = await budget(db, "2026-10-18");
    expect(kind === "metadata" ? used?.metadata_used : used?.detail_used).toBe(limit);
    expect(await attempts(db)).toHaveLength(1);
  });

  it("rolls over at 05:00 KST and counts failed attempts", async () => {
    const store = new MonitorStore(db);
    await insertRun("r1");
    await seedBudget(db, "2026-10-18", { metadata: 240 });
    const before = Date.parse("2026-10-18T19:59:59.000Z");
    const lease = (await store.acquire("A", before))!;
    await expect(store.reserve(lease, "r1", "metadata", before)).rejects.toMatchObject({
      code: "budget_or_lease",
    });
    const after = Date.parse("2026-10-18T20:00:00.000Z");
    const id = await store.reserve(lease, "r1", "metadata", after);
    await store.finishAttempt(id, new IngestFailure("http_503", true), after);
    await store.reserve(lease, "r1", "metadata", after);
    expect(await budget(db, "2026-10-19")).toEqual({ metadata_used: 2, detail_used: 0 });
    expect(await attempts(db)).toMatchObject([
      {
        game_day: "2026-10-19",
        outcome: "failure",
        error_code: "http_503",
        next_attempt_at: "2026-10-18T20:03:00.000Z",
      },
      { game_day: "2026-10-19", outcome: "reserved" },
    ]);
  });

  it("records non-retryable failures without a retry time and finishes an attempt once", async () => {
    const store = new MonitorStore(db);
    await insertRun("r1");
    const lease = (await store.acquire("A", now))!;
    const id = await store.reserve(lease, "r1", "metadata", now);
    await store.finishAttempt(id, new IngestFailure("identity"), now);
    await store.finishAttempt(id, null, now);
    expect(await attempts(db)).toMatchObject([
      { outcome: "failure", error_code: "identity", next_attempt_at: null },
    ]);
  });
});

describe("T03 holds", () => {
  it("counts consecutive holds, alerts from the third, and resets on completion", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new MonitorStore(db);
    await insertRun("r1");
    const lease = (await store.acquire("A", now))!;
    await store.hold(lease, "http_500", now);
    await store.hold(lease, "http_500", now);
    expect(error).not.toHaveBeenCalled();
    await store.hold(lease, "page_cap", now);
    expect(error).toHaveBeenCalledOnce();
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
      event: "forecast_v2_stale_coverage",
      stream: "A",
      reason: "page_cap",
      holds: 3,
    });
    const scan = advanceScan(
      startScan({ createdAt: at(-86_400_000), feedIds: [] }),
      [row(1, at(-90_000_000))],
      "A",
    );
    await store.commitPage(lease, "r1", scan, now);
    expect((await state(db, "A")).consecutive_holds).toBe(0);
    expect(await count(db, "forecast_v2_search_hits")).toBe(0);
  });
});
