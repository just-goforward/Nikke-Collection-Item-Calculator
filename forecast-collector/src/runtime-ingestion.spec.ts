import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SupplyForecastCandidate } from "../../shared/supplyForecastCandidate";
import { assertUsageAllowed } from "../../shared/usageGuard";
import { buildForecastCandidate, resolveSoloSchedule } from "./candidate";
import { isConstructedNoticeCandidate } from "./constructed-candidate";
import { sha256Hex, stableJson } from "./crypto";
import {
  markCandidateProposed,
  sourceItemAndEventStatements,
  supersedeIncompatibleCandidates,
} from "./db";
import { automationOperation, requireGuardDb } from "./http-shared";
import { decideManualReview } from "./manual-review";
import { parseScheduleEvents } from "./naver";
import { fetchNotice, NOTICE_MAX_BYTES, NOTICE_TIMEOUT_MS, parseNoticeDetail } from "./notice";
import { buildNoticeCandidate } from "./notice-processing";
import { loadRuntimeEvents } from "./runtime-events";
import { runRuntimeCandidate, runRuntimeIngestion } from "./runtime-ingestion";
import {
  INGESTION_BATCH_LIMIT,
  ingestionQueue,
  ingestionSettlement,
  reserveNotice,
  startIngestion,
} from "./runtime-ingestion-db";
import { readScheduleLedger } from "./schedule-ledger";
import { processSourceQueue } from "./source-queue";
import {
  allowRecheck,
  enqueue,
  env,
  fixture,
  initializeDatabase,
  now,
  root,
  rows,
  runIngestionThenCandidate as run,
  sqlite,
} from "./test-ingestion-fixture";

it("binds the newest review generation to context A after unchanged-body A → B → A", async () => {
  const payload = JSON.parse(
    readFileSync(new URL("fixtures/naver-detail-7877359.json", root), "utf8"),
  );
  await enqueue(payload);
  await run(async () => Response.json(payload));
  const bindings = () =>
    rows(`SELECT b.* FROM source_manual_review_bindings b
    JOIN source_manual_reviews r ON r.review_id=b.review_id
    WHERE r.item_id='7877359' ORDER BY b.generation`);
  const original = bindings()[0];
  if (!original) throw new Error("missing initial binding");
  const contextA = JSON.parse(String(original["metadata_json"])).contextHash;
  expect(contextA).toMatch(/^[a-f0-9]{64}$/);
  const reprocess = async (request: string) => {
    const latest = bindings().at(-1);
    await decideManualReview(
      env.FORECAST_DB,
      "staging",
      String(latest?.["review_id"]),
      {
        requestId: `mrq-${request.repeat(32)}`,
        decision: "requeue",
        reason: "점검 및 일정 근거 재확인",
        runId: 1,
        event: null,
      },
      { runtimeIngestion: true },
    );
    allowRecheck();
    await run(async () => Response.json(payload));
  };
  const item = await parseNoticeDetail(payload, 56, "7877359");
  if (!item) throw new Error("missing reopen fixture");
  const knownItem = {
    ...item,
    itemId: "9001",
    url: "https://game.naver.com/lounge/nikke/board/detail/9001",
  };
  await env.FORECAST_DB.batch(
    sourceItemAndEventStatements(
      env.FORECAST_DB,
      [knownItem],
      [
        {
          eventId: "context-known",
          eventType: "solo",
          sourceItem: knownItem,
          startsAt: "2026-07-03T03:00:00.000Z",
          endsAt: "2026-07-07T19:59:00.000Z",
          scheduleStatus: "confirmed",
          manualReview: false,
          reason: null,
        },
      ],
      new Date().toISOString(),
    ),
  );
  await reprocess("b");
  const contextualEvent = (await readScheduleLedger(env.FORECAST_DB, now)).events.find(
    (event) => event.eventId === "context-known",
  );
  expect(contextualEvent?.manualReview).toBe(false);
  const contextB = JSON.parse(String(bindings().at(-1)?.["metadata_json"])).contextHash;
  expect(contextB).not.toBe(contextA);
  // Withdraw the external confirmation; keep all source/review evidence immutable.
  sqlite.exec("UPDATE schedule_events SET manual_review=1 WHERE event_id='context-known'");
  await reprocess("c");
  const all = bindings();
  expect(all).toHaveLength(3);
  expect(all[0]).toEqual(original);
  expect(all.every((binding) => binding["body_hash"] === original["body_hash"])).toBe(true);
  expect(JSON.parse(String(all[2]?.["metadata_json"])).contextHash).toBe(contextA);
  expect(
    rows("SELECT DISTINCT context_hash FROM source_judgment_evidence WHERE item_id='7877359'"),
  ).toHaveLength(2);
  const selected = sqlite
    .prepare(`SELECT e.context_hash FROM source_manual_review_bindings b
    JOIN source_manual_reviews r ON r.review_id=b.review_id
    JOIN source_judgment_evidence e ON e.source=r.source AND e.item_id=r.item_id
      AND e.content_hash=b.body_hash AND e.context_hash=json_extract(b.metadata_json,'$.contextHash')
    WHERE b.review_id=?`)
    .all(String(all[2]?.["review_id"]));
  expect(selected).toEqual([{ context_hash: contextA }]);
});

it("persists both section judgments and their revision links while holding the post", async () => {
  const payload = JSON.parse(
    readFileSync(new URL("fixtures/naver-detail-7860406.json", root), "utf8"),
  );
  await enqueue(payload);
  const result = await run(
    vi.fn<typeof fetch>().mockImplementation(async () => Response.json(payload)),
  );
  expect(result.candidateCreated).toBe(false);
  expect(rows("SELECT verdict FROM source_judgment_evidence ORDER BY block_index")).toEqual([
    { verdict: "manual_review" },
    { verdict: "solo" },
  ]);
  expect(rows("SELECT * FROM schedule_event_source_revisions")).toHaveLength(2);
  expect(rows("SELECT DISTINCT context_hash FROM source_judgment_evidence")).toHaveLength(1);
  expect(rows("SELECT starts_at FROM schedule_events WHERE manual_review=0")).toEqual([
    { starts_at: "2026-07-16T03:00:00.000Z" },
  ]);
  expect(rows("SELECT status FROM source_queue")[0]?.["status"]).toBe("manual_review");
});

it("builds from the second resolved solo section and persists both events", async () => {
  const payload = structuredClone(fixture);
  payload.content.feed.contents = `<!-- SE_DOC_HEADER_START --><div class="se-viewer">
    <p>1. 솔로 레이드 오픈</p><p>진행 기간 - 8/20 12:00 ~ 8/27 4:59</p>
    <p>2. 솔로 레이드 오픈</p><p>진행 기간 - 9/17 12:00 ~ 9/24 4:59</p></div>`;
  await enqueue(payload);
  const result = await runRuntimeIngestion(env, {
    fetcher: async () => Response.json(payload),
    candidateNowMs: Date.parse("2026-09-17T12:00:00Z"),
  });
  expect(result.candidateCreated).toBe(false);
  expect(
    (await runRuntimeCandidate(env, Date.parse("2026-09-17T12:00:00Z"))).candidateCreated,
  ).toBe(true);
  expect(rows("SELECT * FROM schedule_events")).toHaveLength(2);
  expect(rows("SELECT schedule_event_id FROM forecast_candidates")[0]?.["schedule_event_id"]).toBe(
    "naver-board-56:8060044:solo:1",
  );
});

it("persists no_change evidence without candidate churn and deduplicates rechecks", async () => {
  const payload = JSON.parse(
    readFileSync(new URL("fixtures/naver-detail-8189601.json", root), "utf8"),
  );
  await enqueue(payload);
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(payload));
  await run(fetcher);
  const priorCandidates = rows("SELECT * FROM forecast_candidates");
  allowRecheck();
  expect((await run(fetcher)).candidateCreated).toBe(false);
  expect(rows("SELECT * FROM forecast_candidates")).toEqual(priorCandidates);
  // Re-evaluation with a newly known event creates a separate context identity.
  const confirmation = structuredClone(payload);
  confirmation.content.feed.feedId = 8189602;
  confirmation.content.feedLink.pc = "https://game.naver.com/lounge/nikke/board/detail/8189602";
  await enqueue(confirmation);
  await run(vi.fn<typeof fetch>().mockImplementation(async () => Response.json(confirmation)));
  expect(rows("SELECT verdict FROM source_judgment_evidence WHERE item_id='8189602'")).toEqual([
    { verdict: "no_change" },
  ]);
  expect(rows("SELECT * FROM source_judgment_evidence")).toHaveLength(2);
  for (const sql of [
    "UPDATE source_judgment_evidence SET reason='tampered'",
    "DELETE FROM source_judgment_evidence",
    "INSERT OR REPLACE INTO source_judgment_evidence SELECT * FROM source_judgment_evidence LIMIT 1",
  ])
    expect(() => sqlite.exec(sql)).toThrow("source_evidence_immutable");
  allowRecheck();
  await run(
    vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        Response.json(String(url).endsWith("8189602") ? confirmation : payload),
      ),
  );
  expect(rows("SELECT * FROM source_judgment_evidence")).toHaveLength(2);
});

describe("rotation admission", () => {
  it("rejects more than eight submitted section events before writes", async () => {
    const item = await parseNoticeDetail(fixture, 56, "8060044");
    if (!item) throw new Error("missing fixture");
    const [event] = await parseScheduleEvents([item]);
    if (!event) throw new Error("missing event");
    await expect(
      processSourceQueue(env.FORECAST_DB, {
        mode: "bootstrap",
        results: [
          {
            source: item.source,
            itemId: item.itemId,
            outcome: "processed",
            item,
            event,
            events: Array(9).fill(event),
          },
        ],
      }),
    ).rejects.toThrow();
    expect(rows("SELECT * FROM schedule_events")).toHaveLength(0);
  });
  it("keeps the original season when 8289927 gains another solo section", async () => {
    const payload = JSON.parse(
      readFileSync(new URL("fixtures/naver-detail-8289927.json", root), "utf8"),
    );
    await enqueue(payload);
    await run(async () => Response.json(payload));
    const original = rows("SELECT event_id,starts_at,ends_at FROM schedule_events")[0];
    payload.content.feed.contents +=
      "<p>99. 솔로 레이드 오픈</p><p>진행 기간 - 2026년 11월 12일 12:00 ~ 2026년 11월 19일 4:59</p>";
    allowRecheck();
    await run(async () => Response.json(payload));
    expect(
      rows("SELECT event_id,starts_at,ends_at FROM schedule_events WHERE manual_review=0"),
    ).toContainEqual(original);
    expect(rows("SELECT * FROM schedule_events WHERE manual_review=0")).toHaveLength(2);
    expect(
      rows(
        "SELECT count(*) AS blocks FROM source_judgment_evidence GROUP BY context_hash ORDER BY blocks",
      ),
    ).toEqual([{ blocks: 1 }, { blocks: 2 }]);
    expect(rows("SELECT status FROM source_queue")[0]?.["status"]).toBe("processed");
  });

  it("finds 7709605 maintenance for 7699562 before limiting unrelated revision dates", async () => {
    const maintenance = JSON.parse(
      readFileSync(new URL("fixtures/naver-detail-7709605.json", root), "utf8"),
    );
    const solo = JSON.parse(
      readFileSync(new URL("fixtures/naver-detail-7699562.json", root), "utf8"),
    );
    await enqueue(maintenance);
    await run(async () => Response.json(maintenance));
    const insert = sqlite.prepare(`INSERT INTO source_notice_revisions
      (source,item_id,source_revision,body_hash,revision_hash,semantic_hash,item_json,events_json,observed_at)
      VALUES('naver-board-48',?,1,?,?,?,?,'[]',?)`);
    for (let index = 0; index < 61; index++)
      insert.run(
        `irrelevant-${index}`,
        "a".repeat(64),
        "b".repeat(64),
        "c".repeat(64),
        JSON.stringify({
          normalizedText: "점검 일시 - 5월 27일(수) 11:00:00 ~ 15:00:00",
          publishedAt: "2026-05-28T00:00:00Z",
        }),
        "2026-05-28T00:00:00Z",
      );
    await enqueue(solo);
    await run(async () => Response.json(solo));
    expect(rows("SELECT verdict FROM source_judgment_evidence WHERE item_id='7699562'")).toEqual([
      { verdict: "no_change" },
    ]);
  });

  async function seed(board: number, status = "completed", age = 60_000) {
    const time = new Date(Date.now() - age).toISOString();
    await env.FORECAST_DB.prepare(`INSERT INTO collector_invocations
      (invocation_id,deployment_sha,scheduled_at,started_at,finished_at,status,poll_mode)
      VALUES(?,?,?,?,?,?, 'both')`)
      .bind(`rotation-board-${board}:${Date.now() - age}`, "old-sha", time, time, time, status)
      .run();
  }
  it("admits all three completed boards and rejects consumption", async () => {
    await seed(48);
    await seed(56);
    await seed(11);
    expect(await startIngestion(env.FORECAST_DB, false, true)).not.toBeNull();
    expect(await startIngestion(env.FORECAST_DB, false, true)).toBeNull();
    sqlite.exec("UPDATE runtime_ingestion_runs SET status='completed'");
    expect(await startIngestion(env.FORECAST_DB, false, true)).toBeNull();
  });
  it.each(["failure", "running", "circuit_open"])("rejects newer %s", async (status) => {
    await seed(48);
    await seed(56);
    await seed(11);
    await seed(48, status, 30_000);
    expect(await startIngestion(env.FORECAST_DB, false, true)).toBeNull();
  });
  it("rejects missing or stale boards", async () => {
    await seed(48);
    expect(await startIngestion(env.FORECAST_DB, false, true)).toBeNull();
    await seed(56, "completed", 781_000);
    await seed(11);
    expect(await startIngestion(env.FORECAST_DB, false, true)).toBeNull();
  });
});

// Empty-results collection still exercises queue selection and quota reservation.
async function oldEmptyRun() {
  const db = env.FORECAST_DB;
  await assertUsageAllowed(requireGuardDb(env), automationOperation(env));
  const limit = Number(env.RUNTIME_NOTICE_DAILY_LIMIT ?? "20");
  if (!Number.isInteger(limit) || limit < 0 || limit > 20)
    throw new Error("runtime_notice_daily_limit");
  const token = await startIngestion(db);
  if (!token) throw new Error("expected_empty_run_lease");
  for (const row of await ingestionQueue(db)) {
    await assertUsageAllowed(requireGuardDb(env), automationOperation(env));
    const requestId = row.official === 1 ? await reserveNotice(db, token, row, limit) : null;
    if (row.official === 1 && requestId === null) break;
    throw new Error("reference_requires_empty_batch");
  }
  const ledger = await readScheduleLedger(db, now);
  await loadRuntimeEvents(db, ledger.events);
  await db
    .prepare(`SELECT source,item_id FROM source_queue q
      WHERE status IN ('pending','manual_review') AND NOT EXISTS (
        SELECT 1 FROM json_each(?) r
        WHERE json_extract(r.value,'$.source')=q.source
          AND json_extract(r.value,'$.itemId')=q.item_id
          AND json_extract(r.value,'$.outcome') IN ('processed','ignored')
      ) LIMIT 1`)
    .bind(JSON.stringify([]))
    .first();
  await assertUsageAllowed(requireGuardDb(env), automationOperation(env));
  const transaction = await ingestionSettlement(db, token, [], null);
  const result = await processSourceQueue(
    db,
    { mode: "bootstrap", results: [], candidate: undefined },
    transaction,
  );
  return { outcome: "completed" as const, ...result };
}

function durableState() {
  return rows("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").map((table) => {
    const name = String(table["name"]);
    return {
      name,
      rows: rows(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
        .map((row) => JSON.stringify(row))
        .sort(),
    };
  });
}

it.each(["empty queue", "zero quota", "settled evidence"])(
  "empty batch preserves every durable table and skips ledger/revision reads: %s",
  async (scenario) => {
    const wallNow = Date.now();
    vi.useFakeTimers();
    // SQLite's lease trigger uses its real clock, independently of JS timers.
    vi.setSystemTime(wallNow);
    let sequence = 0;
    const uuid = vi
      .spyOn(crypto, "randomUUID")
      .mockImplementation(() => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`);
    const prepareSpies: ReturnType<typeof vi.spyOn>[] = [];
    try {
      const setup = async () => {
        sqlite.close();
        sequence = 0;
        await initializeDatabase();
        // Equal initial migration metadata across the two fresh databases.
        sqlite
          .prepare("UPDATE schema_migrations SET applied_at=?")
          .run(new Date(wallNow).toISOString());
        if (scenario !== "empty queue") await enqueue();
        if (scenario === "settled evidence") await run();
        if (scenario === "zero quota") env.RUNTIME_NOTICE_DAILY_LIMIT = "0";
      };
      await setup();
      const referenceReads: string[] = [];
      const originalPrepare = env.FORECAST_DB.prepare.bind(env.FORECAST_DB);
      const referenceSpy = vi.spyOn(env.FORECAST_DB, "prepare").mockImplementation((sql) => {
        referenceReads.push(sql);
        return originalPrepare(sql);
      });
      prepareSpies.push(referenceSpy);
      const expected = await oldEmptyRun();
      const expectedState = durableState();
      referenceSpy.mockRestore();
      const ledgerReads = referenceReads.filter(
        (sql) =>
          /^\s*(SELECT|WITH)\b/i.test(sql) &&
          /forecast_candidates|schedule_events|source_notice_revisions|json_each/.test(sql),
      );
      expect(ledgerReads.length).toBeGreaterThanOrEqual(4);
      await setup();
      const actualPrepare = env.FORECAST_DB.prepare.bind(env.FORECAST_DB);
      const actualReads: string[] = [];
      prepareSpies.push(
        vi.spyOn(env.FORECAST_DB, "prepare").mockImplementation((sql) => {
          actualReads.push(sql);
          // Also proves the documented failure difference: these reads would fail,
          // but the empty run must not issue them.
          if (ledgerReads.includes(sql)) throw new Error("ledger_read_unavailable");
          return actualPrepare(sql);
        }),
      );
      const fetcher = vi.fn<typeof fetch>();
      expect(await runRuntimeIngestion(env, { fetcher, candidateNowMs: now })).toEqual(expected);
      expect(expected).toEqual({ outcome: "completed", processed: 0, candidateCreated: false });
      expect(fetcher).not.toHaveBeenCalled();
      expect(actualReads.filter((sql) => ledgerReads.includes(sql))).toEqual([]);
      expect(durableState()).toEqual(expectedState);
    } finally {
      for (const spy of prepareSpies) spy.mockRestore();
      uuid.mockRestore();
    }
  },
);

describe("fixture ingestion end to end and CPU measurement", () => {
  it("persists an identical v3 candidate to the Actions pipeline and measures one Node run", async () => {
    const item = await enqueue();
    const ledgerSpy = vi.spyOn(env.FORECAST_DB, "prepare");
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(fixture));
    const cpu = process.cpuUsage();
    const start = performance.now();
    const result = await run(fetcher);
    expect(
      ledgerSpy.mock.calls.filter(([sql]) => sql.includes("FROM schedule_event_source_revisions")),
    ).toHaveLength(2);
    ledgerSpy.mockRestore();
    const elapsed = performance.now() - start;
    const used = process.cpuUsage(cpu);
    console.log(
      JSON.stringify({
        fixtureRun: "one-notice-local-sqlite",
        node: process.version,
        cpuMs: (used.user + used.system) / 1000,
        wallMs: elapsed,
        bodyRequests: fetcher.mock.calls.length,
      }),
    );
    expect(result).toEqual({ outcome: "completed", processed: 1, candidateCreated: true });
    const events = await parseScheduleEvents([item]);
    const resolved = resolveSoloSchedule(events, now);
    if (!resolved) throw new Error("missing_fixture_schedule");
    const expected = await buildForecastCandidate(
      resolved,
      events,
      { status: "x_unavailable", sourceItem: null, reason: "github_actions_advisory_pending" },
      now,
      1,
    );
    const stored = rows("SELECT payload_json,payload_hash FROM forecast_candidates")[0];
    expect(JSON.parse(String(stored?.["payload_json"]))).toEqual(expected.candidate);
    expect(stored?.["payload_json"]).toBe(JSON.stringify(expected.candidate));
    expect(stored?.["payload_hash"]).toBe(expected.payloadHash);
    expect(expected.candidate.rulesVersion).toBe("schedule-kit-v4");
    expect(expected.candidate.certifiedSnapshot).toBeDefined();
    expect(rows("SELECT * FROM source_notice_revisions")).toHaveLength(1);
    expect(rows("SELECT status FROM source_queue")[0]?.["status"]).toBe("processed");
    expect(rows("SELECT * FROM runtime_ingestion_commits")).toHaveLength(2);
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("manual");
    expect(() => sqlite.exec("DELETE FROM runtime_notice_requests")).toThrow(
      "runtime_notice_budget_immutable",
    );
    expect(() => sqlite.exec("UPDATE runtime_notice_requests SET utc_day='2000-01-01'")).toThrow(
      "runtime_notice_budget_immutable",
    );
    expect(() =>
      sqlite.exec(
        "INSERT OR REPLACE INTO runtime_notice_requests SELECT * FROM runtime_notice_requests",
      ),
    ).toThrow("runtime_notice_budget_immutable");
    expect(() =>
      sqlite.exec("UPDATE runtime_ingestion_commits SET committed_at='2000-01-01'"),
    ).toThrow("runtime_ingestion_evidence_immutable");
    expect(() =>
      sqlite.exec(
        "INSERT OR REPLACE INTO runtime_ingestion_commits SELECT * FROM runtime_ingestion_commits",
      ),
    ).toThrow("runtime_ingestion_evidence_immutable");
  });

  it("deduplicates repeated metadata and same-content rechecks without revision consumption", async () => {
    await enqueue();
    await run();
    const original = rows("SELECT payload_json,payload_hash FROM forecast_candidates");
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(fixture));
    await enqueue();
    expect((await run(fetcher)).processed).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    allowRecheck();
    expect((await run(fetcher)).candidateCreated).toBe(false);
    expect(rows("SELECT payload_json,payload_hash FROM forecast_candidates")).toEqual(original);
    expect(rows("SELECT status FROM source_queue")[0]?.["status"]).toBe("processed");
    expect(rows("SELECT * FROM source_notice_revisions")).toHaveLength(1);
  });

  it("replaces a notice's own earlier schedule without treating it as independent confirmation", async () => {
    await enqueue();
    await run();
    allowRecheck();
    const corrected = structuredClone(fixture);
    corrected.content.feed.contents = corrected.content.feed.contents.replace(
      "8/27(목)",
      "8/28(금)",
    );
    expect(corrected.content.feed.contents).not.toBe(fixture.content.feed.contents);
    await run(vi.fn<typeof fetch>().mockImplementation(async () => Response.json(corrected)));
    expect(rows("SELECT * FROM forecast_candidates")).toHaveLength(2);
    expect(rows("SELECT status FROM source_queue")[0]?.["status"]).toBe("processed");
    expect(rows("SELECT * FROM source_notice_revisions")).toHaveLength(2);
  });
});

function sealLatestCandidate() {
  const candidate = rows("SELECT * FROM forecast_candidates ORDER BY revision DESC LIMIT 1")[0];
  if (!candidate) throw new Error("missing_fixture_candidate");
  const id = String(candidate["candidate_id"]);
  sqlite
    .prepare(`INSERT INTO forecast_runtime_versions
      (candidate_id,payload_hash,rules_version,payload_version,snapshot_version,payload_bytes,sealed_at)
      SELECT candidate_id,payload_hash,json_extract(payload_json,'$.rulesVersion'),
        json_extract(payload_json,'$.payloadVersion'),json_extract(payload_json,'$.certifiedSnapshot.version'),
        length(CAST(payload_json AS BLOB)),? FROM forecast_candidates WHERE candidate_id=?`)
    .run(now, id);
  return id;
}

function approveCandidate(candidateId: string) {
  const reviewId = "a".repeat(32);
  sqlite.exec(
    "INSERT INTO forecast_runtime_active(singleton,environment,sequence) VALUES(1,'staging',0)",
  );
  sqlite
    .prepare(`INSERT INTO forecast_runtime_reviews
      (review_id,review_key,environment,action,candidate_id,payload_hash,expected_sequence,expires_at,created_at)
      SELECT ?,?,'staging','approve',candidate_id,payload_hash,0,?,?
      FROM forecast_runtime_versions WHERE candidate_id=?`)
    .run(reviewId, `approve:${candidateId}`, now + 60_000, now, candidateId);
  sqlite
    .prepare(`INSERT INTO forecast_runtime_commands
      (interaction_id,review_id,request_hash,actor_id,state,created_at,updated_at)
      VALUES('fixture-approval',?,?,'fixture-actor','pending',?,?)`)
    .run(reviewId, "b".repeat(64), now, now);
  sqlite
    .prepare(`INSERT INTO forecast_runtime_approvals
      (candidate_id,interaction_id,environment,payload_hash,key_id,artifact_signature,actor_id,approved_at)
      SELECT candidate_id,'fixture-approval','staging',payload_hash,'fixture-key',?,'fixture-actor',?
      FROM forecast_runtime_versions WHERE candidate_id=?`)
    .run("s".repeat(88), now, candidateId);
}

function approvedSnapshot() {
  return [
    ...rows("SELECT * FROM forecast_runtime_approvals"),
    ...rows(`SELECT c.* FROM forecast_candidates c JOIN forecast_runtime_approvals a
      ON a.candidate_id=c.candidate_id`),
    ...rows(`SELECT s.* FROM candidate_sources s JOIN forecast_runtime_approvals a
      ON a.candidate_id=s.candidate_id ORDER BY s.source,s.source_item_id`),
    ...rows(`SELECT v.* FROM forecast_runtime_versions v JOIN forecast_runtime_approvals a
      ON a.candidate_id=v.candidate_id`),
  ];
}

async function runCorrectedNotice(day: "28" | "29") {
  const corrected = structuredClone(fixture);
  corrected.content.feed.contents = corrected.content.feed.contents.replace(
    "8/27(목)",
    `8/${day}(목)`,
  );
  allowRecheck();
  // Publication-only fixture: retire the old schedule directly. This deliberately
  // does not claim to exercise the generation/token-bound human review workflow.
  sqlite.exec("UPDATE schedule_events SET manual_review=1 WHERE event_type='solo'");
  return run(vi.fn<typeof fetch>().mockImplementation(async () => Response.json(corrected)));
}

describe("runtime publication migration interoperability", () => {
  it("replays sealed/approved candidates and supersedes only the older unapproved revision", async () => {
    await enqueue();
    expect((await run()).candidateCreated).toBe(true);
    const approvedId = sealLatestCandidate();
    approveCandidate(approvedId);
    const approved = approvedSnapshot();
    allowRecheck();
    expect((await run()).candidateCreated).toBe(false);
    expect(approvedSnapshot()).toEqual(approved);

    expect((await runCorrectedNotice("28")).candidateCreated).toBe(true);
    const sealedId = sealLatestCandidate();
    const sealed = rows("SELECT * FROM forecast_runtime_versions ORDER BY candidate_id");
    const beforeReplay = rows("SELECT * FROM forecast_candidates ORDER BY revision");
    expect((await runCorrectedNotice("28")).candidateCreated).toBe(false);
    expect(rows("SELECT * FROM forecast_candidates ORDER BY revision")).toEqual(beforeReplay);

    expect((await runCorrectedNotice("29")).candidateCreated).toBe(true);
    const candidates = rows("SELECT * FROM forecast_candidates ORDER BY revision");
    expect(candidates).toHaveLength(3);
    expect(candidates[0]).toMatchObject({ candidate_id: approvedId, state: "x_unavailable" });
    expect(candidates[1]).toEqual({
      ...beforeReplay[1],
      state: "superseded",
      updated_at: expect.any(String),
    });
    expect(candidates[1]?.["candidate_id"]).toBe(sealedId);
    expect(candidates[2]).toMatchObject({
      revision: 3,
      state: "x_unavailable",
      schedule_event_id: candidates[0]?.["schedule_event_id"],
      game_day: candidates[0]?.["game_day"],
    });
    expect(approvedSnapshot()).toEqual(approved);
    expect(rows("SELECT * FROM forecast_runtime_versions ORDER BY candidate_id")).toEqual(sealed);
    expect(rows("SELECT * FROM source_notice_revisions")).toHaveLength(3);
    expect(rows("SELECT * FROM runtime_ingestion_runs WHERE status!='completed'")).toEqual([]);
    expect(rows("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("skips approved rows in legacy proposal and future-rules cleanup writes", async () => {
    await enqueue();
    await run();
    const approvedId = sealLatestCandidate();
    approveCandidate(approvedId);
    const approved = approvedSnapshot();
    await runCorrectedNotice("28");
    const unapprovedId = sealLatestCandidate();
    await expect(markCandidateProposed(env.FORECAST_DB, approvedId)).resolves.toBe(false);
    await expect(markCandidateProposed(env.FORECAST_DB, unapprovedId)).resolves.toBe(true);
    await expect(supersedeIncompatibleCandidates(env.FORECAST_DB)).resolves.toBe(0);

    vi.resetModules();
    vi.doMock("../../shared/supplyForecastProjection", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../shared/supplyForecastProjection")>()),
      SUPPLY_RULES_VERSION: "schedule-kit-v5",
    }));
    try {
      const future = await import("./db");
      await expect(future.supersedeIncompatibleCandidates(env.FORECAST_DB)).resolves.toBe(1);
      expect(rows("SELECT state FROM forecast_candidates ORDER BY revision")).toEqual([
        { state: "x_unavailable" },
        { state: "superseded" },
      ]);
      expect(approvedSnapshot()).toEqual(approved);
      expect(rows("PRAGMA foreign_key_check")).toEqual([]);
    } finally {
      vi.doUnmock("../../shared/supplyForecastProjection");
      vi.resetModules();
    }
  });
});

describe("bounds, ownership and recovery", () => {
  it("does not accept a serialized or mutable substitute for local construction proof", async () => {
    const item = await enqueue();
    const event = (await parseScheduleEvents([item]))[0];
    if (!event) throw new Error("missing_fixture_event");
    const built = await buildNoticeCandidate(
      [],
      [{ source: "naver-board-56", itemId: item.itemId, outcome: "processed", item, event }],
      now,
      1,
    );
    if (!built) throw new Error("missing_fixture_candidate");
    expect(isConstructedNoticeCandidate(built)).toBe(true);
    const gain = built.envelope.candidate.profiles[0]?.expectedGain;
    if (!gain) throw new Error("missing_fixture_profile");
    expect(() => {
      gain.blue += 1;
    }).toThrow(TypeError);
    const forged = JSON.parse(JSON.stringify(built));
    expect(isConstructedNoticeCandidate(forged)).toBe(false);
    forged.envelope.candidate.profiles[0].expectedGain.blue += 1;
    forged.envelope.payloadHash = await sha256Hex(stableJson(forged.envelope.candidate));
    await expect(
      processSourceQueue(env.FORECAST_DB, { mode: "bootstrap", results: [], candidate: forged }),
    ).rejects.toThrow();
    expect(rows("SELECT * FROM forecast_candidates")).toHaveLength(0);
  });
  it("does no D1/fetch work when disabled or in production, even with the flag set", async () => {
    for (const config of [
      { ...env, ENVIRONMENT: "production" as const },
      { ...env, RUNTIME_INGESTION_ENABLED: "false" as const },
    ]) {
      const fetcher = vi.fn<typeof fetch>();
      expect(
        (await runRuntimeIngestion({ ...config, FORECAST_DB: {} as D1Database }, { fetcher }))
          .outcome,
      ).toBe("disabled");
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it("fails closed on the existing Usage Guard before body work", async () => {
    await enqueue();
    sqlite.exec("UPDATE usage_guard_state SET action='hard_stop'");
    const fetcher = vi.fn<typeof fetch>();
    await expect(run(fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(rows("SELECT * FROM runtime_ingestion_runs")).toHaveLength(0);
  });

  it("rejects raising staging's ceiling and enforces configurable zero", async () => {
    await enqueue();
    env.RUNTIME_NOTICE_DAILY_LIMIT = "21";
    await expect(run()).rejects.toThrow("runtime_notice_daily_limit");
    env.RUNTIME_NOTICE_DAILY_LIMIT = "0";
    const fetcher = vi.fn<typeof fetch>();
    expect((await run(fetcher)).processed).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("enforces two requests per run and twenty per UTC day including failures", async () => {
    for (let id = 1; id <= 25; id++) {
      const payload = structuredClone(fixture);
      payload.content.feed.feedId = id;
      payload.content.feedLink.pc = `https://game.naver.com/lounge/nikke/board/detail/${id}`;
      await enqueue(payload);
    }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("", { status: 503 }));
    for (let iteration = 0; iteration < 12; iteration++) {
      const previous = fetcher.mock.calls.length;
      await run(fetcher);
      expect(fetcher.mock.calls.length - previous).toBeLessThanOrEqual(INGESTION_BATCH_LIMIT);
    }
    expect(fetcher).toHaveBeenCalledTimes(20);
    expect(rows("SELECT * FROM runtime_notice_requests")).toHaveLength(20);
    expect(rows("SELECT * FROM forecast_candidates")).toHaveLength(0);
  });

  it("settles successful items during partial failure, backs off and caps retries at three", async () => {
    await enqueue();
    const second = structuredClone(fixture);
    second.content.feed.feedId = 123;
    second.content.feedLink.pc = "https://game.naver.com/lounge/nikke/board/detail/123";
    await enqueue(second);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) =>
        String(input).endsWith("/123") ? new Response("", { status: 503 }) : Response.json(fixture),
      );
    expect((await run(fetcher)).candidateCreated).toBe(false);
    expect(rows("SELECT * FROM source_notice_revisions")).toHaveLength(1);
    expect((await run(fetcher)).processed).toBe(0);
    for (let retry = 0; retry < 2; retry++) {
      sqlite.exec(
        "UPDATE runtime_ingestion_items SET next_check_at='2000-01-01T00:00:00.000Z' WHERE item_id='123'",
      );
      await run(fetcher);
    }
    expect(rows("SELECT status FROM source_queue WHERE item_id='123'")[0]?.["status"]).toBe(
      "manual_review",
    );
    expect(rows("SELECT * FROM source_manual_reviews")).toHaveLength(1);
  });

  it("recovers a transient fetch failure and uses the previously settled evidence", async () => {
    await enqueue();
    const fail = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("", { status: 503 }));
    expect((await run(fail)).candidateCreated).toBe(false);
    expect((await run(fail)).processed).toBe(0);
    allowRecheck();
    expect((await run()).candidateCreated).toBe(true);
    expect(rows("SELECT failures FROM runtime_ingestion_items")[0]?.["failures"]).toBe(0);
    expect(
      rows("SELECT outcome FROM runtime_notice_requests ORDER BY reserved_at").map(
        (row) => row["outcome"],
      ),
    ).toEqual(["retry", "processed"]);
  });

  it("holds concurrent runs and rejects a stale writer, retaining recovery evidence", async () => {
    await enqueue();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      expect((await run()).outcome).toBe("held");
      sqlite.exec(
        "UPDATE runtime_ingestion_runs SET lease_until='2000-01-01T00:00:00.000Z' WHERE status='running'",
      );
      expect(await startIngestion(env.FORECAST_DB)).not.toBeNull();
      return Response.json(fixture);
    });
    await expect(run(fetcher)).rejects.toThrow("runtime_ingestion_lease_expired");
    expect(rows("SELECT * FROM forecast_candidates")).toHaveLength(0);
    expect(rows("SELECT * FROM runtime_ingestion_commits")).toHaveLength(0);
    expect(rows("SELECT status FROM runtime_ingestion_runs WHERE status='expired'")).toHaveLength(
      1,
    );
    expect(rows("SELECT outcome FROM runtime_notice_requests")[0]?.["outcome"]).toBe("reserved");
  });

  it("fences a notice whose queue metadata changes during fetch without partial writes", async () => {
    await enqueue();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      sqlite.exec("UPDATE source_queue SET title='corrected metadata'");
      return Response.json(fixture);
    });
    await expect(run(fetcher)).rejects.toThrow("runtime_ingestion_source_conflict");
    expect(rows("SELECT * FROM source_items")).toHaveLength(0);
    expect(rows("SELECT * FROM forecast_candidates")).toHaveLength(0);
    expect(rows("SELECT error_code FROM runtime_ingestion_runs")[0]?.["error_code"]).toContain(
      "source_conflict",
    );
  });

  it("refuses conflicting official schedules", async () => {
    await enqueue();
    await run();
    const conflict = structuredClone(fixture);
    conflict.content.feed.feedId = 124;
    conflict.content.feedLink.pc = "https://game.naver.com/lounge/nikke/board/detail/124";
    conflict.content.feed.contents = conflict.content.feed.contents.replace("8/27(목)", "8/28(금)");
    await enqueue(conflict);
    expect(
      (await run(vi.fn<typeof fetch>().mockImplementation(async () => Response.json(conflict))))
        .candidateCreated,
    ).toBe(false);
    expect(rows("SELECT error_code FROM source_queue WHERE item_id='124'")[0]?.["error_code"]).toBe(
      "schedule_conflict",
    );
    expect(rows("SELECT * FROM forecast_candidates")).toHaveLength(1);
  });
});

describe("full notice transport bounds", () => {
  it.each([301, 302, 307, 308])("refuses a %i redirect without following it", async (status) => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(body, { status, headers: { location: "https://example.com/" } }),
      );
    await expect(fetchNotice(56, "8060044", fetcher)).rejects.toThrow("naver_redirect");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("manual");
    expect(cancel).toHaveBeenCalled();
  });
  it.each(["declared", "streamed"])("rejects a %s oversize body", async (kind) => {
    const response = new Response("x".repeat(kind === "streamed" ? NOTICE_MAX_BYTES + 1 : 1), {
      headers: {
        "content-type": "application/json",
        ...(kind === "declared" ? { "content-length": String(NOTICE_MAX_BYTES + 1) } : {}),
      },
    });
    await expect(
      fetchNotice(56, "8060044", vi.fn<typeof fetch>().mockResolvedValue(response)),
    ).rejects.toThrow("naver_response_too_large");
  });
  it("times out slow bodies as well as slow response headers", async () => {
    vi.useFakeTimers();
    const pending = fetchNotice(
      56,
      "8060044",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(new ReadableStream({ start() {} }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const assertion = expect(pending).rejects.toThrow("naver_timeout");
    await vi.advanceTimersByTimeAsync(NOTICE_TIMEOUT_MS);
    await assertion;
  });
  it("rejects the wrong official identity, board and arbitrary HTML", async () => {
    for (const change of ["id", "board", "user", "body"]) {
      const payload = structuredClone(fixture);
      if (change === "id") payload.content.feed.feedId = 1;
      if (change === "board") payload.content.board.boardId = 48;
      if (change === "user") payload.content.user.userRoleCode = "member";
      if (change === "body") payload.content.feed.contents = "<p>솔로 레이드</p>";
      await expect(parseNoticeDetail(payload, 56, "8060044")).rejects.toThrow();
    }
  });
  it("stores canonical content hashes", async () => {
    await enqueue();
    await run();
    const row = rows("SELECT payload_json,payload_hash FROM forecast_candidates")[0];
    const candidate = JSON.parse(String(row?.["payload_json"])) as SupplyForecastCandidate;
    expect(await sha256Hex(stableJson(candidate))).toBe(row?.["payload_hash"]);
  });
});
