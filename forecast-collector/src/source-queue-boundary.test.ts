import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeTestSql } from "../../shared/testD1Sql";
import { runCollection } from "./collector";
import { upsertOpsAlert } from "./ops";
import {
  finishInvocation,
  invocationCircuitState,
  pollNaverSource,
  recoverNaverBoundary,
  startInvocation,
} from "./source-queue";
import schemaSql from "./test-schema";
import type { CollectorEnv } from "./types";

const db = env["FORECAST_DB"] as D1Database;
const testEnv: CollectorEnv = {
  FORECAST_DB: db,
  ADMIN_TOKEN: "test-forecast-admin-token",
  ENVIRONMENT: "test",
  DEPLOY_SHA: "test-deploy-sha",
  POLL_MODE: "both",
};
const source = "naver-board-56";
const marker = "8143799";
const request = {
  mode: "recover-boundary",
  environment: "staging",
  source,
  expectedCommittedItemId: marker,
};
const holdKey = "naver-boundary:staging:56";

beforeEach(async () => {
  await reset();
  await executeTestSql(db, schemaSql, applyD1Migrations);
});

it("does not let sibling board success reset rotation failures", async () => {
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    const failure = await startInvocation(db, "sha", now + i * 2, "both", "", 48);
    const success = await startInvocation(db, "sha", now + i * 2 + 1, "both", "", 56);
    if (!failure || !success) throw new Error("missing_invocation");
    await finishInvocation(
      db,
      failure,
      "failure",
      0,
      "naver_http_503",
      new Date(now + 600_000).toISOString(),
    );
    await finishInvocation(db, success, "completed", 0, null, null);
  }
  expect(await invocationCircuitState(db, now, 48)).toMatchObject({ failures: 3, open: true });
  expect(await invocationCircuitState(db, now, 56)).toMatchObject({ failures: 0, open: false });
});

it("guards concurrent combined and rotation polling of the same board", async () => {
  const originalFetch = globalThis.fetch;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrivals = 0;
  globalThis.fetch = vi.fn<typeof fetch>(async () => {
    arrivals++;
    if (arrivals === 2) release();
    await barrier;
    return response([row("9000", "20260925120049")]);
  });
  try {
    // Alternating combined mode selects board 56 at this slot.
    await Promise.all([
      runCollection({ ...testEnv, POLL_MODE: "alternating" }, { nowMs: 180_000 }),
      runCollection(testEnv, { nowMs: 180_000, board: 56, rotation: true }),
    ]);
    expect((await db.prepare("SELECT * FROM source_queue").all()).results).toHaveLength(1);
    expect((await db.prepare("SELECT * FROM source_poll_state").all()).results).toHaveLength(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function row(id: string, date: string, boardId: 48 | 56 = 56) {
  return {
    feed: { feedId: Number(id), loungeId: "nikke", title: `Official ${id}`, createdDate: date },
    user: { userRoleCode: "game_manager" },
    board: { boardId },
    feedLink: { pc: `https://game.naver.com/lounge/nikke/board/detail/${id}` },
  };
}
type Row = ReturnType<typeof row>;
function response(rows: readonly unknown[]) {
  return Response.json({ code: 200, content: { feeds: rows } });
}
function pages() {
  return [
    Array.from({ length: 10 }, (_, i) => row(String(9000 + i), "20260925120049")),
    Array.from({ length: 10 }, (_, i) => row(String(8000 + i), "20260912120000")),
    [
      row("7000", "20260908120000"),
      row(marker, "20260903180521"),
      ...Array.from({ length: 8 }, (_, i) => row(String(6000 + i), "20260901120000")),
    ],
  ];
}
function pageFetcher(data: readonly Row[][], offsets: number[] = []) {
  return vi.fn<typeof fetch>(async (input) => {
    const offset = Number(new URL(String(input)).searchParams.get("offset"));
    offsets.push(offset);
    return response(data[offset] ?? []);
  });
}
async function seedMarker() {
  await pollNaverSource(db, 56, async () => response([row(marker, "20260903180521")]));
}
async function seedHold() {
  await seedMarker();
  await expect(
    pollNaverSource(db, 56, async () => response([row("8239880", "20260925120049")])),
  ).rejects.toThrow("naver_scan_boundary_missing");
}
async function snapshot() {
  return {
    poll: await db.prepare("SELECT * FROM source_poll_state WHERE source=?").bind(source).first(),
    hold: await db
      .prepare("SELECT * FROM forecast_ops_alerts WHERE alert_key=?")
      .bind(holdKey)
      .first(),
    queue: (await db.prepare("SELECT * FROM source_queue ORDER BY source,item_id").all()).results,
    items: (await db.prepare("SELECT * FROM source_items").all()).results,
    events: (await db.prepare("SELECT * FROM schedule_events").all()).results,
  };
}
async function acceptedEvidence() {
  await db
    .prepare(`INSERT INTO source_queue(source,item_id,url,title,published_at,official,status,attempts,
    error_code,first_seen_at,updated_at) VALUES(?,'9004','https://game.naver.com/lounge/nikke/board/detail/9004',
    'accepted','2026-09-25T03:00:49.000Z',1,'processed',2,'retained','before','before')`)
    .bind(source)
    .run();
  await db
    .prepare(`INSERT INTO source_items(source,item_id,url,title,excerpt,published_at,content_hash,
    structured,official,first_seen_at,last_seen_at) VALUES(?,'9004','https://game.naver.com/lounge/nikke/board/detail/9004',
    'accepted','retained','2026-09-25T03:00:49.000Z',?,1,1,'before','before')`)
    .bind(source, "a".repeat(64))
    .run();
  await db
    .prepare(`INSERT INTO schedule_events(event_id,event_type,source,source_item_id,
    schedule_status,manual_review,reason,observed_at)
    VALUES('accepted','solo',?,'9004','confirmed',0,'retained','before')`)
    .bind(source)
    .run();
}

describe("page-number collection", () => {
  it("walks 0,1,2 to the exact page-two marker without skipping intervening items", async () => {
    await seedMarker();
    const offsets: number[] = [];
    const fetcher = pageFetcher(pages(), offsets);
    for (let i = 0; i < 3; i++) await pollNaverSource(db, 56, fetcher);
    expect(offsets).toEqual([0, 1, 2]);
    expect((await snapshot()).poll).toMatchObject({ committed_item_id: "9000", next_offset: 0 });
    expect((await snapshot()).queue).toHaveLength(22);
  });

  it("retains the database's negative-offset guard", async () => {
    await seedMarker();
    const before = await snapshot();
    await expect(
      db.prepare("UPDATE source_poll_state SET next_offset=-1 WHERE source=?").bind(source).run(),
    ).rejects.toThrow("CHECK constraint failed");
    expect(await snapshot()).toEqual(before);
  });

  it.each([8, 16, 96, 104, 3, 1.5])(
    "rejects incompatible offset %s before network or writes",
    async (offset) => {
      await seedMarker();
      await db
        .prepare("UPDATE source_poll_state SET next_offset=? WHERE source=?")
        .bind(offset, source)
        .run();
      const before = await snapshot(),
        fetcher = pageFetcher(pages());
      await expect(pollNaverSource(db, 56, fetcher)).rejects.toThrow(
        "source_cursor_recovery_required",
      );
      expect(fetcher).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
    },
  );
});

describe("collector invocation ownership", () => {
  it("leaves a running winner untouched and suppresses duplicate work before and after completion", async () => {
    const nowMs = Date.parse("2026-10-09T05:10:00Z");
    let arrive = () => {};
    let release = () => {};
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const boardId = Number(new URL(String(input)).searchParams.get("boardId")) as 48 | 56;
      if (boardId === 48) {
        arrive();
        await barrier;
      }
      return response([row("200", "20260925120049", boardId)]);
    });
    vi.stubGlobal("fetch", fetcher);
    try {
      const winner = runCollection(testEnv, { nowMs });
      await arrived;
      const before = await db
        .prepare("SELECT * FROM collector_invocations WHERE invocation_id = ?")
        .bind(`${testEnv.DEPLOY_SHA}:${nowMs}`)
        .first();
      expect(before).toMatchObject({ status: "running", finished_at: null });
      const prepare = vi.spyOn(db, "prepare");
      try {
        await expect(runCollection(testEnv, { nowMs })).resolves.toEqual({
          outcome: "completed",
          polledSources: 0,
          queuedItems: 0,
        });
        expect(prepare).toHaveBeenCalledTimes(1);
        expect(prepare.mock.calls[0]?.[0]).toContain("INSERT OR IGNORE INTO collector_invocations");
      } finally {
        prepare.mockRestore();
      }
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(await db.prepare("SELECT * FROM collector_invocations").first()).toEqual(before);
      release();
      await expect(winner).resolves.toEqual({
        outcome: "completed",
        polledSources: 2,
        queuedItems: 2,
      });
      const completed = await db.prepare("SELECT * FROM collector_invocations").first();
      await expect(runCollection(testEnv, { nowMs })).resolves.toEqual({
        outcome: "completed",
        polledSources: 0,
        queuedItems: 0,
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(await db.prepare("SELECT * FROM collector_invocations").first()).toEqual(completed);
    } finally {
      release();
      vi.unstubAllGlobals();
    }
  });

  it("claims distinct deployment and scheduled-time identities independently", async () => {
    const nowMs = Date.parse("2026-10-09T05:10:00Z");
    await expect(startInvocation(db, "first", nowMs, "both")).resolves.toBe(`first:${nowMs}`);
    await expect(startInvocation(db, "first", nowMs, "both")).resolves.toBeNull();
    await expect(startInvocation(db, "second", nowMs, "both")).resolves.toBe(`second:${nowMs}`);
    await expect(startInvocation(db, "first", nowMs + 1, "both")).resolves.toBe(
      `first:${nowMs + 1}`,
    );
  });

  it.each(["both", "alternating"] as const)(
    "skips stale %s polls without resolving schema alerts or adding circuit failures",
    async (mode) => {
      const nowMs = Math.floor(Date.parse("2026-10-09T05:10:00Z") / 360_000) * 360_000;
      await pollNaverSource(db, 48, async () => response([row("100", "20260903180521", 48)]));
      await upsertOpsAlert(db, {
        alertKey: "naver-schema:staging:48:existing",
        environment: "staging",
        severity: "critical",
        component: "naver-metadata",
        errorCode: "naver_partial_schema_drift",
        nowMs,
      });
      const id = await startInvocation(db, "prior", nowMs - 60_000, mode);
      if (id === null) throw new Error("Expected a new test invocation");
      await finishInvocation(
        db,
        id,
        "failure",
        0,
        "naver_network",
        new Date(nowMs + 60_000).toISOString(),
      );
      const fetcher = vi.fn<typeof fetch>(async (input) => {
        const boardId = Number(new URL(String(input)).searchParams.get("boardId")) as 48 | 56;
        if (boardId === 48) {
          await pollNaverSource(db, 48, async () =>
            response([row("200", "20260925120049", 48), row("100", "20260903180521", 48)]),
          );
          return response([row("110", "20260912120000", 48), row("100", "20260903180521", 48)]);
        }
        return response([row("300", "20260925120049", boardId)]);
      });
      vi.stubGlobal("fetch", fetcher);
      try {
        await expect(runCollection({ ...testEnv, POLL_MODE: mode }, { nowMs })).resolves.toEqual({
          outcome: "completed",
          polledSources: mode === "both" ? 2 : 1,
          queuedItems: mode === "both" ? 1 : 0,
        });
        expect(fetcher).toHaveBeenCalledTimes(mode === "both" ? 2 : 1);
        expect(
          await db
            .prepare(
              "SELECT committed_item_id FROM source_poll_state WHERE source='naver-board-48'",
            )
            .first(),
        ).toEqual({ committed_item_id: "200" });
        expect(
          await db.prepare("SELECT 1 FROM source_queue WHERE item_id = '110'").first(),
        ).toBeNull();
        expect(
          await db
            .prepare(
              "SELECT state FROM forecast_ops_alerts WHERE alert_key = 'naver-schema:staging:48:existing'",
            )
            .first(),
        ).toEqual({ state: "open" });
        expect(await invocationCircuitState(db, nowMs)).toMatchObject({
          failures: mode === "both" ? 0 : 1,
          open: false,
        });
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
});

describe("ordinary poll snapshot ownership", () => {
  it.each([
    "committed-id",
    "committed-date",
    "head-id",
    "head-date",
    "offset",
    "updated-at",
    "deleted",
    "hold",
  ] as const)("rejects all poll writes after a concurrent %s change", async (kind) => {
    await seedMarker();
    await acceptedEvidence();
    await db
      .prepare(
        `UPDATE source_poll_state SET scan_head_item_id='8239880',
         scan_head_published_at='2026-09-25T03:00:49.000Z', next_offset=1 WHERE source=?`,
      )
      .bind(source)
      .run();
    let raced: Awaited<ReturnType<typeof snapshot>> | undefined;
    const fetcher = vi.fn<typeof fetch>(async () => {
      if (kind === "hold") {
        await upsertOpsAlert(db, {
          alertKey: holdKey,
          environment: "staging",
          severity: "critical",
          component: "naver-metadata",
          errorCode: "naver_scan_boundary_missing",
          context: { board: 56, committedItemId: marker },
        });
      } else {
        const updates = {
          "committed-id": "UPDATE source_poll_state SET committed_item_id='8143800' WHERE source=?",
          "committed-date":
            "UPDATE source_poll_state SET committed_published_at='2026-09-04T09:05:21.000Z' WHERE source=?",
          "head-id": "UPDATE source_poll_state SET scan_head_item_id='8239881' WHERE source=?",
          "head-date":
            "UPDATE source_poll_state SET scan_head_published_at='2026-09-24T03:00:49.000Z' WHERE source=?",
          offset: "UPDATE source_poll_state SET next_offset=2 WHERE source=?",
          "updated-at": "UPDATE source_poll_state SET updated_at='concurrent' WHERE source=?",
          deleted: "DELETE FROM source_poll_state WHERE source=?",
        };
        await db.prepare(updates[kind]).bind(source).run();
      }
      raced = await snapshot();
      return response([row("9004", "20260925120049"), row("9000", "20260925120049")]);
    });
    await expect(pollNaverSource(db, 56, fetcher)).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await snapshot()).toEqual(raced);
  });

  it.each([false, true])(
    "keeps the first winning snapshot when a late poll began with existing-state=%s",
    async (existingState) => {
      if (existingState) await seedMarker();
      await acceptedEvidence();
      let arrive = () => {};
      let release = () => {};
      const arrived = new Promise<void>((resolve) => {
        arrive = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const older = vi.fn<typeof fetch>(async () => {
        arrive();
        await barrier;
        return response([
          row("9004", "20260912120000"),
          row("9001", "20260912120000"),
          ...(existingState ? [row(marker, "20260903180521")] : []),
        ]);
      });
      const loser = pollNaverSource(db, 56, older);
      await arrived;
      try {
        await expect(
          pollNaverSource(db, 56, async () =>
            response([
              row("9004", "20260925120049"),
              row("9000", "20260925120049"),
              ...(existingState ? [row(marker, "20260903180521")] : []),
            ]),
          ),
        ).resolves.toBe(2);
        const won = await snapshot();
        release();
        await expect(loser).resolves.toBeNull();
        expect(older).toHaveBeenCalledTimes(1);
        expect(await snapshot()).toEqual(won);
      } finally {
        release();
      }
    },
  );

  it("has one winner even when the cursor values and wall-clock millisecond are unchanged", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await seedMarker();
      let arrive = () => {};
      let release = () => {};
      const arrived = new Promise<void>((resolve) => {
        arrive = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const loser = pollNaverSource(db, 56, async () => {
        arrive();
        await barrier;
        return response([row(marker, "20260903180521")]);
      });
      await arrived;
      try {
        await expect(
          pollNaverSource(db, 56, async () => response([row(marker, "20260903180521")])),
        ).resolves.toBe(0);
        const won = await snapshot();
        release();
        await expect(loser).resolves.toBeNull();
        expect(await snapshot()).toEqual(won);
      } finally {
        release();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["cursor", "hold"] as const)(
    "rolls back all metadata and cursor writes if the %s statement fails",
    async (kind) => {
      await seedMarker();
      await acceptedEvidence();
      const before = await snapshot();
      await db
        .prepare(
          kind === "cursor"
            ? `CREATE TRIGGER reject_poll_cursor BEFORE UPDATE ON source_poll_state
               BEGIN SELECT RAISE(ABORT,'poll_write_failed'); END`
            : `CREATE TRIGGER reject_poll_hold BEFORE INSERT ON forecast_ops_alerts
               BEGIN SELECT RAISE(ABORT,'poll_write_failed'); END`,
        )
        .run();
      await expect(
        pollNaverSource(db, 56, async () =>
          response([row("9004", "20260925120049"), row("9000", "20260925120049")]),
        ),
      ).rejects.toThrow("poll_write_failed");
      expect(await snapshot()).toEqual(before);
    },
  );
});

describe("Naver null cursor ownership", () => {
  it("rejects a late bootstrap from an existing all-null cursor snapshot", async () => {
    await pollNaverSource(db, 56, async () =>
      response(Array.from({ length: 10 }, () => ({ type: "banner" }))),
    );
    expect((await snapshot()).poll).toMatchObject({
      committed_item_id: null,
      committed_published_at: null,
      scan_head_item_id: null,
      scan_head_published_at: null,
      next_offset: 1,
    });
    let won: Awaited<ReturnType<typeof snapshot>> | undefined;
    const fetcher = vi.fn<typeof fetch>(async () => {
      await expect(
        pollNaverSource(db, 56, async () => response([row("9000", "20260925120049")])),
      ).resolves.toBe(1);
      won = await snapshot();
      return response([row("9004", "20260912120000")]);
    });
    await expect(pollNaverSource(db, 56, fetcher)).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await snapshot()).toEqual(won);
  });
});

describe("Naver recovery cursor generation", () => {
  it.each(["unchanged", "backward"] as const)(
    "rejects a delayed poll after hold recovery restores its cursor under %s wall time",
    async (clock) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const initialTime = Date.parse("2026-10-09T05:10:00Z");
      vi.setSystemTime(initialTime);
      let release = () => {};
      try {
        await seedMarker();
        await acceptedEvidence();
        const initial = await snapshot();
        expect(initial.poll).toMatchObject({ updated_at: new Date(initialTime).toISOString() });
        let arrive = () => {};
        const arrived = new Promise<void>((resolve) => {
          arrive = resolve;
        });
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        const delayedFetcher = vi.fn<typeof fetch>(async () => {
          arrive();
          await barrier;
          return response([row("9004", "20260925120049"), row(marker, "20260903180521")]);
        });
        const delayed = pollNaverSource(db, 56, delayedFetcher);
        await arrived;
        if (clock === "backward") vi.setSystemTime(initialTime + 60_000);
        await expect(
          pollNaverSource(db, 56, async () => response([row("8239880", "20260925120049")])),
        ).rejects.toThrow("naver_scan_boundary_missing");
        const heldTime = initialTime + (clock === "backward" ? 60_000 : 1);
        const held = await snapshot();
        expect(held.poll).toMatchObject({ updated_at: new Date(heldTime).toISOString() });
        expect(held.hold).toMatchObject({ state: "open" });
        vi.setSystemTime(initialTime);
        const recoveryFetcher = vi.fn<typeof fetch>(async () =>
          response([row(marker, "20260903180521")]),
        );
        await expect(
          recoverNaverBoundary(db, "staging", request, recoveryFetcher),
        ).resolves.toEqual({
          recovered: true,
          source,
          queuedItems: 0,
        });
        expect(recoveryFetcher).toHaveBeenCalledTimes(1);
        const recovered = await snapshot();
        expect(recovered.poll).toEqual({
          ...initial.poll,
          updated_at: new Date(heldTime + 1).toISOString(),
        });
        expect(recovered.hold).toMatchObject({ state: "resolved" });
        release();
        await expect(delayed).resolves.toBeNull();
        expect(delayedFetcher).toHaveBeenCalledTimes(1);
        expect(await snapshot()).toEqual(recovered);
      } finally {
        release();
        vi.useRealTimers();
      }
    },
  );
});

describe("bounded proven-boundary recovery", () => {
  beforeEach(seedHold);

  it("rejects stale held publication proof before fetching", async () => {
    await db
      .prepare(
        "UPDATE forecast_ops_alerts SET context_json=json_set(context_json,'$.committedPublishedAt',?) WHERE alert_key=?",
      )
      .bind("2026-09-04T09:05:21.000Z", holdKey)
      .run();
    const before = await snapshot();
    const fetcher = pageFetcher(pages());
    await expect(recoverNaverBoundary(db, "staging", request, fetcher)).rejects.toThrow(
      "naver_boundary_marker_conflict",
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it("bounds the entire recovery including response-body consumption", async () => {
    const before = await snapshot();
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
          queueMicrotask(() => deadline.abort());
        },
      });
      return new Response(stream, { headers: { "content-type": "application/json" } });
    });
    try {
      await expect(recoverNaverBoundary(db, "staging", request, fetcher)).rejects.toThrow(
        "naver_timeout",
      );
      expect(timeout).toHaveBeenCalledWith(40_000);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(await snapshot()).toEqual(before);
    } finally {
      timeout.mockRestore();
    }
  });

  it("recovers page two atomically while preserving accepted facts, queue outcomes and original hold evidence", async () => {
    await acceptedEvidence();
    const before = await snapshot(),
      offsets: number[] = [];
    const fetcher = pageFetcher(pages(), offsets);
    await expect(recoverNaverBoundary(db, "staging", request, fetcher)).resolves.toEqual({
      recovered: true,
      source,
      queuedItems: 21,
    });
    expect(offsets).toEqual([0, 1, 2]);
    const after = await snapshot();
    expect(after.poll).toMatchObject({
      committed_item_id: "9000",
      committed_published_at: "2026-09-25T03:00:49.000Z",
      scan_head_item_id: null,
      scan_head_published_at: null,
      next_offset: 0,
    });
    expect(after.queue).toHaveLength(23);
    for (const item of pages().flat().slice(0, 21))
      expect(
        after.queue.find((entry) => entry["item_id"] === String(item.feed.feedId)),
      ).toBeDefined();
    expect(after.queue.find((entry) => entry["item_id"] === "9004")).toMatchObject({
      status: "processed",
      attempts: 2,
      error_code: "retained",
      first_seen_at: "before",
    });
    expect(after.items).toEqual(before.items);
    expect(after.events).toEqual(before.events);
    expect(after.hold).toMatchObject({
      state: "resolved",
      occurrence_count: before.hold?.["occurrence_count"],
    });
    expect(JSON.parse(String(after.hold?.["context_json"]))).toMatchObject(
      JSON.parse(String(before.hold?.["context_json"])),
    );
  });

  it("accepts equivalent timestamp representations without changing stored evidence", async () => {
    await db
      .prepare("UPDATE source_poll_state SET committed_published_at=? WHERE source=?")
      .bind("2026-09-03T18:05:21+09:00", source)
      .run();
    await expect(
      recoverNaverBoundary(db, "staging", request, pageFetcher(pages())),
    ).resolves.toMatchObject({ recovered: true });
  });

  it("requires an adjacent older page when the marker page ends in a known older pin", async () => {
    await db
      .prepare(`INSERT INTO source_queue(source,item_id,url,title,published_at,official,status,first_seen_at,updated_at)
      VALUES(?,'6007','https://game.naver.com/lounge/nikke/board/detail/6007','known','2026-09-01T03:00:00.000Z',1,'processed','before','before')`)
      .bind(source)
      .run();
    const offsets: number[] = [],
      data = [...pages(), [row("5000", "20260831120000")]];
    await expect(
      recoverNaverBoundary(db, "staging", request, pageFetcher(data, offsets)),
    ).resolves.toMatchObject({ recovered: true });
    expect(offsets).toEqual([0, 1, 2, 3]);
    expect((await snapshot()).queue.find((entry) => entry["item_id"] === "6007")?.["status"]).toBe(
      "processed",
    );
  });

  it("retains the marker's equal-date cohort rather than silently dropping a later row", async () => {
    const data = pages();
    const cohort = data[2]?.[2];
    if (!cohort) throw new Error("Missing fixture");
    cohort.feed.createdDate = "20260903180521";
    await expect(
      recoverNaverBoundary(db, "staging", request, pageFetcher(data)),
    ).resolves.toMatchObject({ queuedItems: 22 });
    expect((await snapshot()).queue.find((entry) => entry["item_id"] === "6000")?.["status"]).toBe(
      "pending",
    );
  });
});

describe("boundary recovery proof failures and atomicity", () => {
  beforeEach(seedHold);

  it.each([
    "date",
    "board",
    "lounge",
    "official",
    "url",
    "schema",
    "future",
    "duplicate",
    "order",
    "cross-page",
    "oversize",
    "network",
  ])("fails %s proof without recovery writes", async (kind) => {
    const before = await snapshot(),
      data = pages();
    const first = data[0]?.[0],
      second = data[1]?.[0],
      boundary = data[2]?.[1];
    if (!first || !second || !boundary || !data[0]) throw new Error("Missing fixture");
    if (kind === "date") boundary.feed.createdDate = "20260904180521";
    if (kind === "board") second.board.boardId = 48;
    if (kind === "lounge") second.feed.loungeId = "other";
    if (kind === "official") second.user.userRoleCode = "member";
    if (kind === "url") second.feedLink.pc = "https://attacker.example";
    if (kind === "schema") second.feed.title = "";
    if (kind === "future") first.feed.createdDate = "20990101120000";
    if (kind === "duplicate") second.feed.feedId = first.feed.feedId;
    if (kind === "order") data[0][1] = row("9999", "20260926120000");
    if (kind === "cross-page") second.feed.createdDate = "20260926120000";
    if (kind === "oversize") data[0].push(row("9999", "20260924120000"));
    const fetcher =
      kind === "network"
        ? vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"))
        : pageFetcher(data);
    let expectedError = "naver_scan_boundary_missing";
    if (["board", "lounge", "schema"].includes(kind)) expectedError = "naver_partial_schema_drift";
    if (kind === "network") expectedError = "naver_network";
    await expect(recoverNaverBoundary(db, "staging", request, fetcher)).rejects.toThrow(
      expectedError,
    );
    expect(await snapshot()).toEqual(before);
  });

  it("does not substitute dates for an absent marker or scan beyond four pages", async () => {
    const data = pages();
    if (!data[2]) throw new Error("Missing fixture");
    data[2][1] = row("7777", "20260903180521");
    data.push(Array.from({ length: 10 }, (_, i) => row(String(5000 + i), "20260831120000")));
    const offsets: number[] = [],
      before = await snapshot();
    await expect(
      recoverNaverBoundary(db, "staging", request, pageFetcher(data, offsets)),
    ).rejects.toThrow("naver_scan_boundary_missing");
    expect(offsets).toEqual([0, 1, 2, 3]);
    expect(await snapshot()).toEqual(before);
  });

  it.each(["state-date", "state-head", "state-offset", "state-time", "hold"])(
    "retains concurrent %s changes and refuses partial recovery",
    async (kind) => {
      const data = pages();
      let raced: Awaited<ReturnType<typeof snapshot>> | undefined;
      const fetcher = vi.fn<typeof fetch>(async (input) => {
        const offset = Number(new URL(String(input)).searchParams.get("offset"));
        if (offset === 1) {
          const updates = {
            "state-date":
              "UPDATE source_poll_state SET committed_published_at='2026-09-04T09:05:21.000Z'",
            "state-head": "UPDATE source_poll_state SET scan_head_item_id='8239881'",
            "state-offset": "UPDATE source_poll_state SET next_offset=1",
            "state-time": "UPDATE source_poll_state SET updated_at='concurrent'",
            hold: "UPDATE forecast_ops_alerts SET context_json=json_set(context_json,'$.concurrent',1)",
          };
          await db.prepare(updates[kind as keyof typeof updates]).run();
          raced = await snapshot();
        }
        return response(data[offset] ?? []);
      });
      await expect(recoverNaverBoundary(db, "staging", request, fetcher)).rejects.toThrow(
        "naver_boundary_recovery_conflict",
      );
      expect(await snapshot()).toEqual(raced);
    },
  );

  it("has one winner when two recoveries prove the same held snapshot", async () => {
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrivals = 0;
    const data = pages();
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const offset = Number(new URL(String(input)).searchParams.get("offset"));
      if (offset === 0) {
        arrivals += 1;
        if (arrivals === 2) release();
        await barrier;
      }
      return response(data[offset] ?? []);
    });
    const results = await Promise.allSettled([
      recoverNaverBoundary(db, "staging", request, fetcher),
      recoverNaverBoundary(db, "staging", request, fetcher),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason.message).toBe(
      "naver_boundary_recovery_conflict",
    );
    expect((await snapshot()).queue).toHaveLength(23);
  });

  it("rolls back hold resolution and every enqueued item if cursor persistence fails", async () => {
    const before = await snapshot();
    await db
      .prepare(`CREATE TRIGGER reject_boundary_commit BEFORE UPDATE ON source_poll_state
      WHEN NEW.committed_item_id='9000' BEGIN SELECT RAISE(ABORT,'boundary_write_failed'); END`)
      .run();
    await expect(
      recoverNaverBoundary(db, "staging", request, pageFetcher(pages())),
    ).rejects.toThrow("boundary_write_failed");
    expect(await snapshot()).toEqual(before);
  });
});
