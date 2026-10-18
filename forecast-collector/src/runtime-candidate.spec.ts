import { expect, it, vi } from "vitest";
import * as noticeProcessing from "./notice-processing";
import { buildNoticeCandidate } from "./notice-processing";
import { persistedReviewEvidence } from "./publication-exclusions";
import { runRuntimeCandidate, runRuntimeIngestion } from "./runtime-ingestion";
import { startIngestion } from "./runtime-ingestion-db";
import * as ledgerModule from "./schedule-ledger";
import { readScheduleLedger } from "./schedule-ledger";
import { judgments } from "./solo-judgment";
import { enqueue, env, fixture, now, rows, sqlite } from "./test-ingestion-fixture";

it("does no ledger work for an empty candidate invocation", async () => {
  const spy = vi.spyOn(ledgerModule, "readScheduleLedger");
  try {
    expect((await runRuntimeCandidate(env, now)).candidateCreated).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

it.each([
  "unchanged",
  "empty-commit",
  "day",
  "review",
  "renewal",
  "grant",
  "event",
  "commit",
  "deployment",
])("invalidates cached constructor inputs for %s", async (change) => {
  await enqueue();
  await runRuntimeIngestion(env, {
    fetcher: async () => Response.json(fixture),
    candidateNowMs: now,
  });
  if (change === "review" || change === "renewal")
    sqlite.exec(`INSERT INTO source_manual_reviews
        (review_id,source,item_id,generation,state,created_at,expires_at)
        VALUES('mr-${"b".repeat(32)}','naver-board-56','8060044',0,'pending',
        '2026-08-20T00:00:00Z','2026-08-21T00:00:00Z')`);
  expect((await runRuntimeCandidate(env, now)).candidateCreated).toBe(true);
  if (change === "event")
    sqlite.exec(`INSERT INTO schedule_events
        (event_id,event_type,source,source_item_id,starts_at,ends_at,schedule_status,manual_review,reason,observed_at)
        VALUES('new-event','cooperation','naver-board-56','8060044','2026-08-21T03:00:00Z',
        '2026-08-28T03:00:00Z','confirmed',0,NULL,'2026-08-20T13:00:00Z')`);
  if (change === "commit") {
    sqlite.exec("UPDATE runtime_ingestion_items SET next_check_at='2000-01-01'");
    await runRuntimeIngestion(env, {
      candidateNowMs: now,
      fetcher: async () => Response.json(fixture),
    });
  }
  if (change === "empty-commit") await runRuntimeIngestion(env, { candidateNowMs: now });
  if (change === "deployment") env.DEPLOY_SHA = "new-deployment";
  if (change === "review")
    sqlite.exec(`UPDATE source_manual_reviews SET state='resolved',decision='ignore',
        actor='fixture',reason='resolved',request_id='mrq-${"c".repeat(32)}',
        request_payload_hash='${"d".repeat(64)}',resolved_at='2026-08-20T13:00:00Z'`);
  if (change === "renewal")
    sqlite.exec("UPDATE source_manual_reviews SET generation=1,expires_at='2026-08-22T00:00:00Z'");
  if (change === "grant") {
    sqlite.exec(`INSERT INTO forecast_grants VALUES('grant:naver-board-56:8060044:2026-08-21:1','naver-board-56','8060044','2026-08-21',1,'2026-08-20');
        INSERT INTO forecast_grant_revisions VALUES('grant:naver-board-56:8060044:2026-08-21:1','${"f".repeat(64)}','[{"law":"box-ii-v1","count":1}]',NULL,1,'2026-08-20')`);
  }
  const spy = vi.spyOn(noticeProcessing, "buildNoticeCandidate");
  try {
    await runRuntimeCandidate(env, change === "day" ? now + 86400000 : now + 24 * 60000);
    if (change === "unchanged" || change === "empty-commit") expect(spy).not.toHaveBeenCalled();
    else expect(spy).toHaveBeenCalledOnce();
    spy.mockClear();
    await runRuntimeCandidate(env, change === "day" ? now + 86400000 : now + 24 * 60000);
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

it.each([27, 28])("requires recorded schema 29 even with objects present: %s", async (version) => {
  sqlite.prepare("DELETE FROM schema_migrations WHERE version>?").run(version);
  for (let index = 0; index < 4; index++)
    expect((await runRuntimeCandidate(env, now)).outcome).toBe("disabled");
  expect(rows("SELECT * FROM runtime_ingestion_runs")).toHaveLength(0);
});

it("rejects tampered stored identity on the unchanged-state path", async () => {
  await enqueue();
  await runRuntimeIngestion(env, {
    fetcher: async () => Response.json(fixture),
    candidateNowMs: now,
  });
  await runRuntimeCandidate(env, now);
  sqlite.prepare("UPDATE forecast_candidates SET payload_hash=?").run("0".repeat(64));
  await expect(runRuntimeCandidate(env, now)).rejects.toThrow(
    "runtime_candidate_identity_conflict",
  );
});

it("establishes a museum exclusion after ingestion with old-path candidate parity", async () => {
  await enqueue();
  await runRuntimeIngestion(env, {
    fetcher: async () => Response.json(fixture),
    candidateNowMs: now,
  });
  const payload = structuredClone(fixture);
  payload.content.feed.feedId = 8060045;
  payload.content.feedLink.pc = "https://game.naver.com/lounge/nikke/board/detail/8060045";
  payload.content.feed.contents =
    '<!-- SE_DOC_HEADER_START --><div class="se-viewer"><p>1. 솔로 레이드 박물관</p><p>과거 기록을 전시합니다.</p></div>';
  const item = await enqueue(payload);
  await runRuntimeIngestion(env, {
    fetcher: async () => Response.json(payload),
    candidateNowMs: now,
  });
  expect(rows("SELECT * FROM forecast_candidates")).toHaveLength(0);
  const review = await persistedReviewEvidence(env.FORECAST_DB, item.source, item.itemId);
  expect(review?.judgments.length).toBeGreaterThan(0);
  if (!review) throw new Error("missing_review");
  judgments.set(review.item, review.judgments);
  const ledger = await readScheduleLedger(env.FORECAST_DB, now);
  const old = await buildNoticeCandidate(
    ledger.events,
    [
      {
        source: "naver-board-56",
        itemId: item.itemId,
        item: review.item,
        outcome: "manual_review",
        events: [],
      },
    ],
    now,
    ledger.nextRevision,
  );
  expect(old).toBeDefined();
  expect((await runRuntimeCandidate(env, now)).candidateCreated).toBe(true);
  expect(
    JSON.parse(String(rows("SELECT payload_json FROM forecast_candidates")[0]?.["payload_json"])),
  ).toEqual(old?.envelope.candidate);
  expect(rows("SELECT * FROM publication_review_exclusions").length).toBeGreaterThan(0);
  expect(() => sqlite.exec("UPDATE publication_review_exclusions SET exclusion_json='{}'")).toThrow(
    "source_evidence_immutable",
  );
});

it("publishes persisted inputs with exhausted quota, no fetch, and idempotent replay", async () => {
  await enqueue();
  expect(
    (
      await runRuntimeIngestion(env, {
        fetcher: async () => Response.json(fixture),
        candidateNowMs: now,
      })
    ).candidateCreated,
  ).toBe(false);
  env.RUNTIME_NOTICE_DAILY_LIMIT = "0";
  const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected_fetch"));
  try {
    expect((await runRuntimeCandidate(env, now)).candidateCreated).toBe(true);
    const candidates = rows("SELECT * FROM forecast_candidates");
    expect((await runRuntimeCandidate(env, now)).candidateCreated).toBe(false);
    expect(rows("SELECT * FROM forecast_candidates")).toEqual(candidates);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    fetcher.mockRestore();
  }
});

it.each(["pending", "manual_review"])("holds unresolved %s inputs", async (status) => {
  await enqueue();
  sqlite.prepare("UPDATE source_queue SET status=?").run(status);
  expect((await runRuntimeCandidate(env, now)).candidateCreated).toBe(false);
});

it("shares ingestion lease exclusion", async () => {
  expect(await startIngestion(env.FORECAST_DB)).toBeTruthy();
  expect((await runRuntimeCandidate(env, now)).outcome).toBe("held");
});

it.each([true, false])("isolates the failure streak for candidate=%s", async (candidate) => {
  const prefix = candidate ? "candidate:" : "";
  const time = new Date().toISOString();
  for (let index = 0; index < 3; index++)
    sqlite
      .prepare(`INSERT INTO runtime_ingestion_runs
      (token,status,started_at,lease_until) VALUES(?,'failed',?,?)`)
      .run(`${prefix}${crypto.randomUUID()}`, time, time);
  expect(await startIngestion(env.FORECAST_DB, false, false, candidate)).toBeNull();
  expect(await startIngestion(env.FORECAST_DB, false, false, !candidate)).toBeTruthy();
});

it("fails closed without a usage guard", async () => {
  const unguarded = { ...env };
  delete unguarded.USAGE_GUARD_DB;
  await expect(runRuntimeCandidate(unguarded, now)).rejects.toThrow();
  expect(rows("SELECT * FROM runtime_ingestion_runs")).toHaveLength(0);
});

it("does not consume collection admission", async () => {
  const time = new Date(Date.now() - 60_000).toISOString();
  for (const board of [48, 56, 11])
    sqlite
      .prepare(`INSERT INTO collector_invocations
      (invocation_id,deployment_sha,scheduled_at,started_at,finished_at,status,poll_mode)
      VALUES(?,'test',?,?,?,'completed','both')`)
      .run(`rotation-board-${board}:test`, time, time, time);
  await runRuntimeCandidate(env, now);
  expect(await startIngestion(env.FORECAST_DB, false, true)).toBeTruthy();
});

it("holds when the source processor is held", async () => {
  sqlite
    .prepare("INSERT INTO source_processor_state(singleton_id,state,updated_at) VALUES(1,'held',?)")
    .run(new Date().toISOString());
  expect((await runRuntimeCandidate(env, now)).outcome).toBe("held");
});
