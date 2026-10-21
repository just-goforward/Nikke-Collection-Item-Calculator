import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runtimeTestDb } from "../../test-runtime-db";
import type { RulesPort } from "./rules-port";
import { runV2Invocation, type V2Env } from "./run";
import type { Stream } from "./schedule";
import { MonitorStore } from "./store";
import { FakeNaver, iso, page, pagePayload } from "./test-support/naver";
import {
  alerts,
  budget,
  hits,
  preferEditScan,
  runs,
  seedBoundary,
  seedVersion,
  state,
} from "./test-support/v2-db";

// The whole-day and four-page workloads use the existing SQLite D1 adapter,
// exercising real transactional SQL without thousands of workerd RPC round trips.
// Refresh, pending-body continuation and retry boundaries also run in workerd.
const schema = readFileSync(
  new URL("../../../fixtures/schema-v27-test.sql", import.meta.url),
  "utf8",
);
let sqlite: DatabaseSync;
let db: D1Database;
const cutoff = "2026-10-15T00:00:00.000Z";
const at = (hhmm: string) => `2026-10-18T${hhmm}:00.000Z`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(schema);
  db = runtimeTestDb(sqlite);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  sqlite.close();
});

function createHarness() {
  const naver = new FakeNaver();
  const environment: V2Env = {
    FORECAST_DB: db,
    USAGE_GUARD_DB: db,
    ADMIN_TOKEN: "local",
    ENVIRONMENT: "staging",
    DEPLOY_SHA: "local",
    POLL_MODE: "both",
    FORECAST_V2_MODE: "on",
    FORECAST_V2_BOOTSTRAP_CUTOFF: cutoff,
  };
  const rules = {
    applyPendingDecisions: vi.fn(async () => ({ applied: 0 })),
    processPostVersion: vi.fn(async () => ({
      calendarDirty: false,
      decisionRequests: 0,
      grants: 0,
    })),
    rebuildCalendar: vi.fn(async () => ({ snapshotId: null, changed: false })),
    dueEFollowUps: vi.fn(async () => 0),
  } satisfies RulesPort;
  const guard = vi.fn(async () => {});
  const invoke = async (instant: string) => {
    const now = Date.parse(instant);
    vi.setSystemTime(now);
    return runV2Invocation(environment, now, { fetcher: naver.fetcher, rules, guard });
  };
  return { naver, environment, rules, guard, invoke };
}

it("keeps all fixed slots and uses 220 metadata requests over 480 quiet game-day invocations", async () => {
  const monitored = ["A", "B", "C-open", "C-reopen", "D", "F", "G"] as const;
  const fixed: Record<number, Stream> = {
    0: "A",
    3: "G",
    6: "B",
    12: "C-open",
    18: "C-reopen",
    24: "D",
    33: "G",
    36: "F",
  };
  const { naver, environment, rules, guard } = createHarness();
  for (const stream of monitored) {
    await seedBoundary(db, stream, cutoff, []);
    naver.page(stream, 0, pagePayload([]));
  }
  const candidate = vi.fn(async () => ({ sealed: 0 }));
  const start = Date.parse("2026-10-18T20:00:00.000Z"); // 05:00 KST game-day boundary
  let fixedChecks = 0;
  let idleSlots = 0;
  for (let slot = 0; slot < 480; slot++) {
    const now = start + slot * 3 * 60_000;
    vi.setSystemTime(now);
    const before = naver.calls.length;
    const result = await runV2Invocation(environment, now, {
      fetcher: naver.fetcher,
      guard,
      rules,
      candidate,
    });
    const expected = fixed[new Date(now).getUTCMinutes()];
    if (expected) {
      expect(result).toEqual({ outcome: "completed" });
      expect(naver.calls.slice(before)).toMatchObject([{ kind: "metadata", stream: expected }]);
      fixedChecks++;
    }
    if (result.outcome === "idle") {
      expect(naver.calls).toHaveLength(before);
      idleSlots++;
    }
  }
  const completed = await db
    .prepare(`SELECT stream_id,kind,started_at FROM forecast_v2_monitor_runs
      WHERE status='completed' ORDER BY started_at`)
    .all<{ stream_id: Stream; kind: string; started_at: string }>();
  for (const stream of monitored) {
    const edits = completed.results.filter(
      (run) => run.stream_id === stream && run.kind === "edit",
    );
    expect(edits, stream).toHaveLength(4);
    let previous: number | null = null;
    for (const edit of edits) {
      const time = Date.parse(edit.started_at);
      if (previous !== null) expect(time - previous).toBe(6 * 60 * 60_000);
      previous = time;
    }
    expect(
      completed.results.filter((run) => run.stream_id === stream && run.kind === "new"),
    ).toHaveLength(stream === "G" ? 48 : 24);
  }
  expect(fixedChecks).toBe(192);
  expect(idleSlots).toBe(188);
  expect(naver.metadataCalls()).toHaveLength(220);
  expect(naver.metadataCalls().length).toBeLessThanOrEqual(240);
  expect(naver.detailCalls()).toEqual([]);
  expect(naver.metadataCalls("E")).toEqual([]);
  expect(await budget(db, "2026-10-19")).toEqual({ metadata_used: 220, detail_used: 0 });
  expect(await alerts(db)).toEqual([]);
  expect(candidate).toHaveBeenCalledTimes(24);
  expect(rules.applyPendingDecisions).toHaveBeenCalledTimes(24);
  expect(rules.rebuildCalendar).toHaveBeenCalledTimes(24);
  expect(rules.processPostVersion).not.toHaveBeenCalled();
});

async function seedFourPageEdit(naver: FakeNaver) {
  await seedBoundary(db, "A", cutoff, []);
  await preferEditScan(db, "A", at("03:00"));
  // Same 120 distinct versions as the workerd scenario: KST wall-clock values,
  // newest first, one minute apart. Stored bodies prevent pending-detail work.
  const all = Array.from({ length: 120 }, (_, index) => ({
    feedId: 5000 - index,
    created: new Date(Date.parse("2026-10-18T11:00:00.000Z") - index * 60_000)
      .toISOString()
      .slice(0, 19),
  }));
  for (const post of all)
    await seedVersion(db, String(post.feedId), iso(post.created), iso(post.created));
  for (let pageIndex = 0; pageIndex < 4; pageIndex++)
    naver.page("A", pageIndex, page("A", all.slice(pageIndex * 30, (pageIndex + 1) * 30)));
  return all;
}

it.each([false, true])(
  "cools down a capped edit for six hours without blocking continuation or fixed new scans (interrupted after commit: %s)",
  async (interrupted) => {
    const { naver, invoke } = createHarness();
    await seedFourPageEdit(naver);
    if (interrupted) {
      const commitPage = MonitorStore.prototype.commitPage;
      vi.spyOn(MonitorStore.prototype, "commitPage").mockImplementation(async function (
        this: MonitorStore,
        ...args
      ) {
        await commitPage.apply(this, args);
        if (args[2].kind === "edit" && args[2].reason === "page_cap")
          throw new Error("interrupted_after_commit");
      });
    }
    expect(await invoke(at("03:09"))).toEqual({ outcome: "running" });
    // An existing run must continue even when its stream is not due for a new edit.
    await db
      .prepare("UPDATE forecast_v2_monitor_state SET edit_scan_completed_at=? WHERE stream_id='A'")
      .bind(at("03:09"))
      .run();
    expect(await invoke(at("03:15"))).toEqual({ outcome: "running" });
    expect(await invoke(at("03:21"))).toEqual({ outcome: "running" });
    expect(await invoke(at("03:27"))).toEqual({
      outcome: "held",
      reason: interrupted ? "unit_failed" : "page_cap",
    });
    expect(await state(db, "A")).toMatchObject({
      edit_scan_completed_at: at("03:27"),
      edit_scan_cutoff: null,
      edit_scan_cursor: 0,
    });
    expect(await runs(db, "A")).toMatchObject([
      { kind: "edit", status: "held", pages_used: 4, error_code: "page_cap" },
    ]);
    expect(await invoke(at("03:30"))).toEqual({ outcome: "idle" });
    expect(naver.metadataCalls("A").map((call) => call.page)).toEqual([0, 1, 2, 3]);
    naver.page("A", 0, pagePayload([]));
    expect(await invoke(at("04:00"))).toEqual({ outcome: "completed" });
    expect((await runs(db, "A")).at(-1)).toMatchObject({ kind: "new", status: "completed" });
    expect(await invoke(at("04:09"))).toEqual({ outcome: "idle" });
    await db
      .prepare("UPDATE forecast_v2_monitor_state SET edit_scan_completed_at=? WHERE stream_id<>'A'")
      .bind(at("09:21"))
      .run();
    expect(await invoke(at("09:21"))).toEqual({ outcome: "idle" });
    expect(naver.metadataCalls("A")).toHaveLength(5);
    expect(await invoke(at("09:27"))).toEqual({ outcome: "completed" });
    expect((await runs(db, "A")).at(-1)).toMatchObject({ kind: "edit", status: "completed" });
    expect(naver.metadataCalls("A")).toHaveLength(6);
  },
);

it("does not commit a capped edit or its cooldown after the invocation lease expires", async () => {
  const { naver, invoke } = createHarness();
  const all = await seedFourPageEdit(naver);
  expect(await invoke(at("03:09"))).toEqual({ outcome: "running" });
  expect(await invoke(at("03:15"))).toEqual({ outcome: "running" });
  expect(await invoke(at("03:21"))).toEqual({ outcome: "running" });
  const elapsed = vi.spyOn(performance, "now").mockReturnValue(0);
  naver.page("A", 3, () => {
    // The reservation was admitted, but the lease expires before page commit.
    elapsed.mockReturnValue(120_000);
    return Response.json(page("A", all.slice(90)));
  });
  const result = await invoke(at("03:27"));
  elapsed.mockRestore();
  expect(result).toEqual({ outcome: "held", reason: "lease_lost" });
  expect(await state(db, "A")).toMatchObject({
    edit_scan_completed_at: null,
    edit_scan_cursor: 3,
  });
  expect(await runs(db, "A")).toMatchObject([
    { kind: "edit", status: "running", pages_used: 3, error_code: null },
  ]);
  expect(await hits(db)).toHaveLength(90);
  expect(naver.metadataCalls("A").map((call) => call.page)).toEqual([0, 1, 2, 3]);
});
