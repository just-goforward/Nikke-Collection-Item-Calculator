import { expect, it, vi } from "vitest";
import * as candidate from "./candidate";
import { sourceItemAndEventStatements } from "./db";
import { decideManualReview, ensureManualReviewStatement } from "./manual-review";
import { parseNoticeDetail } from "./notice";
import { ignoredReviewSources } from "./review-supersession";
import { runRuntimeCandidate, runRuntimeIngestion } from "./runtime-ingestion";
import { coldCandidate } from "./test-cold-candidate";
import { enqueue, env, fixture, now, rows, sqlite } from "./test-ingestion-fixture";

async function seedLegacy() {
  await enqueue();
  await runRuntimeIngestion(env, {
    fetcher: async () => Response.json(fixture),
    candidateNowMs: now,
  });
  const payload = structuredClone(fixture);
  payload.content.feed.feedId = 9001;
  payload.content.feedLink.pc = "https://game.naver.com/lounge/nikke/board/detail/9001";
  const item = await parseNoticeDetail(payload, 56, "9001");
  if (!item) throw new Error("missing item");
  await env.FORECAST_DB.batch(
    sourceItemAndEventStatements(
      env.FORECAST_DB,
      [item],
      [
        {
          eventId: "legacy:9001",
          eventType: "schedule_change",
          sourceItem: item,
          startsAt: null,
          endsAt: null,
          scheduleStatus: "confirmed",
          manualReview: true,
          reason: "legacy_schedule_uncertain",
        },
      ],
      new Date().toISOString(),
    ),
  );
  return { item, payload };
}

it("profiles an 81-event ledger with 19 blocking manual-review events without constructing", async () => {
  const { item } = await seedLegacy();
  for (let index = 0; index < 79; index++) {
    const sourceItem = {
      ...item,
      itemId: String(9100 + index),
      url: `https://game.naver.com/lounge/nikke/board/detail/${9100 + index}`,
    };
    await env.FORECAST_DB.batch(
      sourceItemAndEventStatements(
        env.FORECAST_DB,
        [sourceItem],
        [
          {
            eventId: `history-${index}`,
            eventType: "cooperation",
            sourceItem,
            startsAt: null,
            endsAt: null,
            scheduleStatus: "confirmed",
            manualReview: index < 18,
            reason: index < 18 ? "legacy_schedule_uncertain" : null,
          },
        ],
        new Date().toISOString(),
      ),
    );
  }
  expect(rows("SELECT * FROM schedule_events")).toHaveLength(81);
  expect(rows("SELECT * FROM schedule_events WHERE manual_review=1")).toHaveLength(19);
  for (const row of rows(
    "SELECT event_id,source,source_item_id FROM schedule_events WHERE source_item_id<>'8060044'",
  )) {
    const itemId = String(row["source_item_id"]);
    sqlite.prepare(`INSERT INTO source_notice_revisions VALUES(?,?,1,?,?,?,?,'[]',?)`).run(
      String(row["source"]),
      itemId,
      item.contentHash,
      "b".repeat(64),
      "c".repeat(64),
      JSON.stringify({
        ...item,
        itemId,
        url: `https://game.naver.com/lounge/nikke/board/detail/${itemId}`,
        normalizedText: "점검 ".repeat(5400),
      }),
      new Date().toISOString(),
    );
    sqlite
      .prepare("INSERT INTO schedule_event_source_revisions VALUES(?,?,?,1)")
      .run(String(row["event_id"]), String(row["source"]), itemId);
  }
  await seedIgnoredLegacySources();
  expect(rows("SELECT * FROM source_manual_reviews WHERE decision='ignore'")).toHaveLength(11);
  const build = vi.spyOn(candidate, "buildForecastCandidate");
  try {
    await coldCandidate(sqlite, env, now, "staging-realistic", "a");
    await coldCandidate(sqlite, env, now, "staging-realistic", "b");
    await runRuntimeCandidate(env, now);
    await coldCandidate(sqlite, env, now, "staging-realistic", "c");
    expect(build).not.toHaveBeenCalled();
    expect(rows("SELECT * FROM source_manual_reviews")).toHaveLength(19);
    for (const [index, review] of rows(
      "SELECT review_id FROM source_manual_reviews WHERE state='pending'",
    ).entries())
      await decideManualReview(
        env.FORECAST_DB,
        "staging",
        String(review["review_id"]),
        {
          requestId: `mrq-${String(100 + index).padStart(32, "0")}`,
          decision: "ignore",
          reason: "operator decision",
          runId: 1,
          event: null,
        },
        { runtimeIngestion: true },
      );
    const publishing = await coldCandidate(sqlite, env, now, "staging-realistic", "d");
    expect(publishing.cold?.result.candidateCreated).toBe(true);
    expect((await runRuntimeCandidate(env, now)).candidateCreated).toBe(true);
    const replay = await coldCandidate(sqlite, env, now, "staging-realistic", "e");
    expect(replay.cold?.result.candidateCreated).toBe(false);
  } finally {
    build.mockRestore();
  }
}, 30_000);

async function seedIgnoredLegacySources() {
  const ids = ["9001", ...Array.from({ length: 10 }, (_, index) => String(9100 + index))];
  const time = new Date().toISOString();
  for (const [index, id] of ids.entries()) {
    sqlite
      .prepare(`INSERT INTO source_queue
      (source,item_id,url,title,published_at,official,status,attempts,error_code,first_seen_at,updated_at)
      SELECT source,item_id,url,title,published_at,official,'manual_review',0,
        'legacy_schedule_uncertain',?,? FROM source_items WHERE item_id=?`)
      .run(time, time, id);
    await env.FORECAST_DB.batch([
      await ensureManualReviewStatement(env.FORECAST_DB, "naver-board-56", id, time),
    ]);
    const review = sqlite
      .prepare("SELECT review_id FROM source_manual_reviews WHERE item_id=?")
      .get(id);
    await decideManualReview(
      env.FORECAST_DB,
      "staging",
      String(review?.["review_id"]),
      {
        requestId: `mrq-${String(index + 1).padStart(32, "0")}`,
        decision: "ignore",
        reason: "operator decision",
        runId: 1,
        event: null,
      },
      { runtimeIngestion: true },
    );
  }
}

it.each(["ignore", "requeue", "manual_event"] as const)(
  "imports one legacy review/card and preserves decision semantics: %s",
  async (decision) => {
    const { item, payload } = await seedLegacy();
    // Keep the dispatcher's generated ambient Cloudflare Env out of this
    // collector TypeScript project, while exercising its real card pipeline.
    const dispatcherRoot = new URL("../../forecast-dispatcher/src/", import.meta.url);
    const discord = await import(new URL("discord.ts", dispatcherRoot).href);
    const { flushOperations } = await import(new URL("operations.ts", dispatcherRoot).href);
    const builder = vi.spyOn(candidate, "buildForecastCandidate");
    const resolver = vi.spyOn(candidate, "resolveSoloSchedule");
    const send = vi
      .spyOn(discord, "sendDiscordMessage")
      .mockResolvedValue({ messageId: "123456789012345678", channelId: "123456789012345679" });
    try {
      expect((await runRuntimeCandidate(env, now)).candidateCreated).toBe(false);
      expect((await runRuntimeCandidate(env, now)).candidateCreated).toBe(false);
      expect(builder).not.toHaveBeenCalled();
      expect(resolver).not.toHaveBeenCalled();
      expect(rows("SELECT * FROM source_manual_reviews")).toHaveLength(1);
      const dispatcher = { ...env, ENVIRONMENT: "staging" };
      expect(await flushOperations(dispatcher)).toBe(1);
      expect(await flushOperations(dispatcher)).toBe(0);
      expect(send).toHaveBeenCalledOnce();
      const card = JSON.stringify(send.mock.calls[0]);
      expect(card).toContain(item.title);
      expect(card).toContain(item.url);
      expect(card).toContain("legacy_schedule_uncertain");
      const review = rows("SELECT review_id FROM source_manual_reviews")[0];
      await decideManualReview(
        env.FORECAST_DB,
        "staging",
        String(review?.["review_id"]),
        {
          requestId: `mrq-${"a".repeat(32)}`,
          decision,
          reason: "operator decision",
          runId: 1,
          event:
            decision === "manual_event"
              ? {
                  eventType: "cooperation",
                  startsAtKst: "2026-08-21T12:00",
                  endsAtKst: "2026-08-28T12:00",
                  scheduleStatus: "confirmed",
                }
              : null,
        },
        { runtimeIngestion: true, nowMs: Date.now() },
      );
      expect((await ignoredReviewSources(env.FORECAST_DB)).has("naver-board-56:9001")).toBe(
        decision !== "requeue",
      );
      if (decision === "requeue") {
        expect(rows("SELECT status FROM source_queue WHERE item_id='9001'")[0]?.["status"]).toBe(
          "pending",
        );
        await runRuntimeIngestion(env, {
          fetcher: async () => Response.json(payload),
          candidateNowMs: now,
        });
        // The fetched fixture repeats the already-known Solo schedule, so the
        // normal parser settles it as ignored/no-change rather than processed.
        expect(rows("SELECT status FROM source_queue WHERE item_id='9001'")[0]?.["status"]).toBe(
          "ignored",
        );
        expect(rows("SELECT * FROM runtime_notice_requests WHERE item_id='9001'")).toHaveLength(1);
      }
      expect((await runRuntimeCandidate(env, now)).candidateCreated).toBe(true);
      expect(
        sqlite
          .prepare("SELECT manual_review FROM schedule_events WHERE event_id='legacy:9001'")
          .get()?.["manual_review"],
      ).toBe(1);
    } finally {
      builder.mockRestore();
      resolver.mockRestore();
      send.mockRestore();
    }
  },
);

it("does not materialize legacy reviews when the usage guard is unavailable", async () => {
  await seedLegacy();
  delete env.USAGE_GUARD_DB;
  await expect(runRuntimeCandidate(env, now)).rejects.toThrow();
  expect(rows("SELECT * FROM source_manual_reviews")).toHaveLength(0);
});

it("issues a new generation/card when requeue re-judges to manual review", async () => {
  const { payload } = await seedLegacy();
  await runRuntimeCandidate(env, now);
  const root = new URL("../../forecast-dispatcher/src/", import.meta.url);
  const discord = await import(new URL("discord.ts", root).href);
  const { flushOperations } = await import(new URL("operations.ts", root).href);
  const send = vi
    .spyOn(discord, "sendDiscordMessage")
    .mockResolvedValue({ messageId: "123456789012345678", channelId: "123456789012345679" });
  try {
    expect(await flushOperations(env)).toBe(1);
    const review = rows("SELECT review_id FROM source_manual_reviews")[0];
    await decideManualReview(
      env.FORECAST_DB,
      "staging",
      String(review?.["review_id"]),
      {
        requestId: `mrq-${"f".repeat(32)}`,
        decision: "requeue",
        reason: "recheck",
        runId: 1,
        event: null,
      },
      { runtimeIngestion: true },
    );
    payload.content.feed.contents =
      '<!-- SE_DOC_HEADER_START --><div class="se-viewer"><p>1. 솔로 레이드 박물관</p><p>과거 기록을 전시합니다.</p></div>';
    await runRuntimeIngestion(env, {
      fetcher: async () => Response.json(payload),
      candidateNowMs: now,
    });
    const generations = rows(
      "SELECT generation,state FROM source_manual_reviews ORDER BY generation",
    );
    expect(generations).toHaveLength(2);
    expect(generations[0]).toEqual({ generation: 0, state: "resolved" });
    expect(generations[1]?.["state"]).toBe("pending");
    expect(Number(generations[1]?.["generation"])).toBeGreaterThan(0);
    expect(generations[1]?.["generation"]).toBe(
      rows("SELECT review_generation FROM source_queue WHERE item_id='9001'")[0]?.[
        "review_generation"
      ],
    );
    expect((await ignoredReviewSources(env.FORECAST_DB)).has("naver-board-56:9001")).toBe(false);
    expect(await flushOperations(env)).toBe(1);
    expect(await flushOperations(env)).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
  } finally {
    send.mockRestore();
  }
});

it("admits another orphan while an existing metadata-only review is pending", async () => {
  const { item } = await seedLegacy();
  await runRuntimeCandidate(env, now);
  const second = {
    ...item,
    itemId: "9002",
    url: "https://game.naver.com/lounge/nikke/board/detail/9002",
  };
  await env.FORECAST_DB.batch(
    sourceItemAndEventStatements(
      env.FORECAST_DB,
      [second],
      [
        {
          eventId: "legacy:9002",
          eventType: "schedule_change",
          sourceItem: second,
          startsAt: null,
          endsAt: null,
          scheduleStatus: "confirmed",
          manualReview: true,
          reason: "legacy_uncertain",
        },
      ],
      new Date().toISOString(),
    ),
  );
  await runRuntimeCandidate(env, now);
  await runRuntimeCandidate(env, now);
  expect(rows("SELECT * FROM source_manual_reviews")).toHaveLength(2);
  const reviews = rows("SELECT review_id,item_id FROM source_manual_reviews ORDER BY item_id");
  await decideManualReview(
    env.FORECAST_DB,
    "staging",
    String(reviews[0]?.["review_id"]),
    {
      requestId: `mrq-${"c".repeat(32)}`,
      decision: "ignore",
      reason: "unrelated",
      runId: 1,
      event: null,
    },
    { runtimeIngestion: true },
  );
  const decision = await decideManualReview(
    env.FORECAST_DB,
    "staging",
    String(reviews[1]?.["review_id"]),
    {
      requestId: `mrq-${"d".repeat(32)}`,
      decision: "manual_event",
      reason: "confirmed",
      runId: 1,
      event: {
        eventType: "cooperation",
        startsAtKst: "2026-08-21T12:00",
        endsAtKst: "2026-08-28T12:00",
        scheduleStatus: "confirmed",
      },
    },
    { runtimeIngestion: true },
  );
  expect(decision.candidateCreated).toBe(true);
});

it.each(["non-official", "external-url", "invalid-url"])(
  "alerts rather than silently skipping %s",
  async (kind) => {
    await seedLegacy();
    if (kind === "non-official")
      sqlite.exec("UPDATE source_items SET official=0 WHERE item_id='9001'");
    else
      sqlite
        .prepare("UPDATE source_items SET url=? WHERE item_id='9001'")
        .run(kind === "external-url" ? "https://example.com/notice" : "invalid");
    expect((await runRuntimeCandidate(env, now)).candidateCreated).toBe(false);
    expect(rows("SELECT * FROM source_manual_reviews")).toHaveLength(0);
    expect(rows("SELECT error_code FROM forecast_ops_alerts")).toEqual([
      { error_code: "legacy_review_source_unsupported" },
    ]);
  },
);

it("does not reuse an older ignore after a newer review generation", async () => {
  await seedLegacy();
  await runRuntimeCandidate(env, now);
  const review = rows("SELECT review_id FROM source_manual_reviews")[0];
  await decideManualReview(
    env.FORECAST_DB,
    "staging",
    String(review?.["review_id"]),
    {
      requestId: `mrq-${"b".repeat(32)}`,
      decision: "ignore",
      reason: "operator decision",
      runId: 1,
      event: null,
    },
    { runtimeIngestion: true },
  );
  expect((await ignoredReviewSources(env.FORECAST_DB)).has("naver-board-56:9001")).toBe(true);
  sqlite.exec(
    "UPDATE source_queue SET status='manual_review',review_generation=1 WHERE item_id='9001'",
  );
  await env.FORECAST_DB.batch([
    await ensureManualReviewStatement(
      env.FORECAST_DB,
      "naver-board-56",
      "9001",
      new Date().toISOString(),
    ),
  ]);
  expect((await ignoredReviewSources(env.FORECAST_DB)).has("naver-board-56:9001")).toBe(false);
  expect((await runRuntimeCandidate(env, now)).candidateCreated).toBe(false);
});
