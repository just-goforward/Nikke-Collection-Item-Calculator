import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type ForecastV2NotificationKind,
  renderForecastV2Notification,
} from "../../../../../shared/forecastV2Notifications";
import { runtimeTestDb } from "../../../test-runtime-db";
import { seedNormalUsageGuard } from "../../../test-usage-guard";
import type { CollectorEnv } from "../../../types";
import { runV2Invocation, type V2Env } from "../../ingest/run";
import { type Stream, streams } from "../../ingest/schedule";
import { detailPath, fixture, hasFixture } from "../../ingest/test-support/fixtures";
import { FakeNaver, metadataRow, pagePayload } from "../../ingest/test-support/naver";
import { configureRules, rulesPort } from "../index";
import { renderOutbox } from "./outbox-render";

// F12 bounded end-to-end replay: fake Naver serving captured fixtures → real
// runV2Invocation units (scan, body, rules, decisions, calendar) → outbox rows
// rendered as the dispatcher does → simulated interaction admission (a scripted
// result written with a predicate mirroring the interactions Worker, Decision
// contract §3B; full handler integration is covered in forecast-interactions/test) → applied by
// the minute-54 unit → calendar snapshot. Representative posts:
//   B 6579018 (S28 suspension: B report + grant_date decision),
//   D 6701330 (Biohazard, '9/24 점검 완료 후' before G exists) + G 6701562 (9/24 maintenance).
// Expected values come from expected/grants.json, expected/collaborations.json and
// the rules (U4, U21), not from this pipeline.
type Captured = {
  payload: unknown;
  feed: { title: string; createdDate: string; updatedDate: string };
};
const schema = readFileSync(
  new URL("../../../../fixtures/schema-v27-test.sql", import.meta.url),
  "utf8",
);
const referenced = new URL("../../../../fixtures/official-solo-history/", import.meta.url);
let sqlite: DatabaseSync;
let db: D1Database;
let naver: FakeNaver;
const outcomes: { at: string; outcome: string; reason?: string; result?: unknown }[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(schema);
  db = runtimeTestDb(sqlite);
  naver = new FakeNaver();
  for (const stream of Object.keys(streams) as Stream[]) naver.page(stream, 0, pagePayload([]));
  configureRules({ environment: "staging" });
  outcomes.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  sqlite.close();
});

/** Detail payload served to fake Naver plus its metadata, checked at runtime. */
function captured(payload: { content: { feed?: Record<string, unknown> } }): Captured {
  const feed = payload.content.feed;
  const title = feed?.["title"];
  const createdDate = feed?.["createdDate"];
  const updatedDate = feed?.["updatedDate"];
  if (typeof title !== "string" || typeof createdDate !== "string")
    throw new Error("detail_feed_shape");
  if (typeof updatedDate !== "string") throw new Error("detail_feed_shape");
  return { payload, feed: { title, createdDate, updatedDate } };
}
async function detail(feedId: number): Promise<Captured> {
  if (hasFixture(detailPath(feedId))) return captured(await fixture(detailPath(feedId)));
  // Referenced capture: sanitization dropped `lounge.loungeId` (present in live
  // responses, F7); restore it from the detail endpoint path, as fixtures.ts does.
  const payload = JSON.parse(readFileSync(new URL(`${feedId}.json`, referenced), "utf8"));
  if (payload.content.lounge) payload.content.lounge.loungeId = "nikke";
  return captured(payload);
}
const kst = (compact: string) =>
  `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T${compact.slice(8, 10)}:${compact.slice(10, 12)}:${compact.slice(12, 14)}`;
/** Serves the posts as page 0 of `stream` (newest first) and their captured details. */
async function publish(stream: Stream, feedIds: number[]) {
  const rows = [];
  for (const feedId of feedIds) {
    const { payload, feed } = await detail(feedId);
    rows.push({
      created: kst(feed.createdDate),
      row: metadataRow(stream, {
        feedId,
        title: feed.title,
        created: kst(feed.createdDate),
        updated: kst(feed.updatedDate),
      }),
    });
    naver.detail(feedId, payload);
  }
  rows.sort((a, b) => b.created.localeCompare(a.created));
  naver.page(stream, 0, pagePayload(rows.map((entry) => entry.row)));
}
/** One cron hour: every 3-minute slot from `startUtc`. */
async function hour(startUtc: string) {
  const env = {
    FORECAST_DB: db,
    USAGE_GUARD_DB: db,
    ADMIN_TOKEN: "local",
    ENVIRONMENT: "staging",
    DEPLOY_SHA: "local",
    POLL_MODE: "both",
    FORECAST_V2_MODE: "on",
    FORECAST_V2_BOOTSTRAP_CUTOFF: "2025-08-20T00:00:00.000Z",
  } satisfies CollectorEnv as V2Env;
  for (let minute = 0; minute < 60; minute += 3) {
    const now = Date.parse(startUtc) + minute * 60_000;
    vi.setSystemTime(now);
    // The stats observer keeps usage evidence fresh (the guard degrades after 45 min).
    await seedNormalUsageGuard(db, now);
    const result = (await runV2Invocation(env, now, {
      fetcher: naver.fetcher,
      rules: rulesPort,
    })) as { outcome: string; reason?: string; result?: unknown };
    outcomes.push({ at: new Date(now).toISOString(), ...result });
  }
}
const rows = (sql: string, ...values: (string | number)[]) =>
  sqlite.prepare(sql).all(...values) as Record<string, unknown>[];

/** Dispatcher delivery: render every pending row (as v2-outbox.ts) and mark it sent. */
function deliver() {
  const pending =
    rows(`SELECT o.outbox_id,o.idempotency_key,o.kind,o.payload_json,d.expected_calendar_revision
    FROM forecast_v2_notification_outbox o LEFT JOIN forecast_v2_decision_requests d
    ON d.decision_id=o.decision_id WHERE o.state='pending'`);
  const messages = new Map<string, ReturnType<typeof renderForecastV2Notification>>();
  for (const row of pending) {
    messages.set(
      String(row["outbox_id"]),
      renderForecastV2Notification(
        row["kind"] as ForecastV2NotificationKind,
        JSON.parse(String(row["payload_json"])),
        {
          environment: "staging",
          expectedRevision: Number(row["expected_calendar_revision"] ?? 0),
          idempotencyKey: String(row["idempotency_key"]),
        },
      ),
    );
    sqlite
      .prepare(`UPDATE forecast_v2_notification_outbox SET state='sent',message_id=?,channel_id=?
        WHERE outbox_id=?`)
      .run(
        `message_${row["outbox_id"]}`,
        row["kind"] === "calendar_changed" ? "activity" : "approval",
        String(row["outbox_id"]),
      );
  }
  return messages;
}
/**
 * Simulated admission mirroring the interactions Worker; full handler integration is
 * covered in forecast-interactions/test. Clicks a delivered button: parses its
 * custom_id and writes the result with the mirrored predicate (pending, unexpired at the replay clock, revision,
 * payload hash, env, sent approval message). Returns whether the result was admitted.
 */
async function click(
  outboxId: string,
  message: ReturnType<typeof renderForecastV2Notification>,
  pick: (customId: string) => boolean,
  now: string,
  edit?: { startAt: string; endAt: string },
) {
  const customId = message.components
    .flatMap((row) => row.components)
    .map((button) => button.custom_id)
    .find(pick);
  if (!customId) throw new Error(`button_missing:${outboxId}`);
  const [, env, action, decisionId, revision, option] = customId.split(":");
  expect(env).toBe("s");
  const result =
    action === "bedit"
      ? { action: "edit", ...edit! }
      : action === "opt"
        ? { action: "opt", optionId: option }
        : { action };
  const resultJson = JSON.stringify({
    ...result,
    actorId: "approver",
    decidedAt: now,
    expectedRevision: Number(revision),
  });
  const request = rows(
    "SELECT payload_hash FROM forecast_v2_decision_requests WHERE decision_id=?",
    decisionId!,
  )[0];
  const predicate = `decision_id=? AND status='pending' AND julianday(expires_at)>julianday(?)
    AND expected_calendar_revision=? AND payload_hash=? AND json_extract(payload_json,'$.env')='staging'
    AND event_id IS json_extract(payload_json,'$.eventId')
    AND COALESCE((SELECT revision FROM forecast_v2_calendar_heads h WHERE h.event_id=forecast_v2_decision_requests.event_id),0)=?
    AND EXISTS(SELECT 1 FROM forecast_v2_notification_outbox o WHERE o.decision_id=forecast_v2_decision_requests.decision_id
      AND o.state='sent' AND o.message_id=? AND o.channel_role='approval')`;
  const args = [
    decisionId!,
    now,
    Number(revision),
    String(request?.["payload_hash"]),
    Number(revision),
    `message_${outboxId}`,
  ];
  const interaction = `interaction_${decisionId}`;
  const committed = await db.batch([
    db
      .prepare(`INSERT INTO forecast_v2_consumed_interactions(interaction_id,decision_id,consumed_at)
        SELECT ?,decision_id,? FROM forecast_v2_decision_requests WHERE ${predicate}`)
      .bind(interaction, now, ...args),
    db
      .prepare(`INSERT INTO forecast_v2_decision_results(decision_id,interaction_id,result_json,created_at)
        SELECT decision_id,?,?,? FROM forecast_v2_decision_requests WHERE ${predicate}`)
      .bind(interaction, resultJson, now, ...args),
    db
      .prepare(`UPDATE forecast_v2_decision_requests SET status='resolved' WHERE decision_id=?
        AND EXISTS(SELECT 1 FROM forecast_v2_decision_results WHERE decision_id=? AND interaction_id=?)`)
      .bind(decisionId!, decisionId!, interaction),
  ]);
  return committed[0]?.meta.changes === 1;
}
const outboxFor = (kind: string, type?: string) =>
  rows(
    `SELECT o.outbox_id,o.payload_json FROM forecast_v2_notification_outbox o
    JOIN forecast_v2_decision_requests d ON d.decision_id=o.decision_id
    WHERE o.kind=? AND d.status='pending' ${type ? "AND d.type=?" : ""} ORDER BY o.created_at`,
    ...(type ? [kind, type] : [kind]),
  );
function activeDays() {
  return new Map(
    rows(`SELECT d.game_day,d.payload_json,(SELECT json_group_array(l.event_id) FROM forecast_v2_calendar_event_links l
      WHERE l.snapshot_id=d.snapshot_id AND l.game_day=d.game_day) events
      FROM forecast_v2_calendar_active a JOIN forecast_v2_calendar_days d ON d.snapshot_id=a.snapshot_id`).map(
      (row) => [
        String(row["game_day"]),
        {
          payload: JSON.parse(String(row["payload_json"])) as {
            coop: number;
            grants: { ii: number; box: number }[];
          },
          events: JSON.parse(String(row["events"])) as string[],
        },
      ],
    ),
  );
}
const unexpectedHolds = () =>
  outcomes.filter(
    (entry) =>
      (entry.outcome === "held" && entry.reason !== "candidate_unavailable") ||
      (entry.outcome === "decisions" &&
        (entry.result as { failure?: string } | undefined)?.failure),
  );

it("B report and grant-date decision: ingest → rules → render → simulated interaction admission → apply → snapshot", async () => {
  await publish("B", [6579018]);
  // 2025-08-26 02:00–04:57 KST.
  await hour("2025-08-25T17:00:00.000Z");
  const grantRequest = outboxFor("decision_request", "grant_date");
  const report = outboxFor("b_report");
  expect([grantRequest.length, report.length], JSON.stringify(outcomes)).toEqual([1, 1]);
  const messages = deliver();
  const now = "2025-08-26T03:00:00.000Z";
  vi.setSystemTime(Date.parse(now));
  const options = JSON.parse(String(grantRequest[0]!["payload_json"])).options as {
    id: string;
    label: string;
  }[];
  // Scripted admin answer (expected/grants.json scriptedDecisions): 2025-08-26 21:00.
  const chosen = options.find((option) => option.label.includes("T21:00"));
  expect(chosen, JSON.stringify(options)).toBeDefined();
  const grantOutbox = String(grantRequest[0]!["outbox_id"]);
  expect(
    await click(
      grantOutbox,
      messages.get(grantOutbox)!,
      (id) => id.endsWith(`:${chosen!.id}`),
      now,
    ),
  ).toBe(true);
  // B report: admin edits S28 segment 1 to 8/21 12:00 ~ 8/26 17:00 (suspension).
  const reportOutbox = String(report[0]!["outbox_id"]);
  expect(
    await click(reportOutbox, messages.get(reportOutbox)!, (id) => id.includes(":bedit:"), now, {
      startAt: "2025-08-21T12:00:00+09:00",
      endAt: "2025-08-26T17:00:00+09:00",
    }),
  ).toBe(true);
  // A replayed click is rejected (request no longer pending).
  expect(
    await click(
      grantOutbox,
      messages.get(grantOutbox)!,
      (id) => id.endsWith(`:${chosen!.id}`),
      now,
    ),
  ).toBe(false);
  // 03:00–04:57 KST and 04:00–... : one result per minute-54 unit, then minute-57 calendar.
  await hour("2025-08-25T18:00:00.000Z");
  await hour("2025-08-25T19:00:00.000Z");
  expect(unexpectedHolds()).toEqual([]);
  expect(
    rows(`SELECT COUNT(*) n FROM forecast_v2_admin_commands c JOIN forecast_v2_decision_results r
      ON r.decision_id=c.decision_id`)[0]?.["n"],
  ).toBe(2);
  expect(
    rows("SELECT grant_game_day,ii_qty,box_qty FROM forecast_v2_grant_heads").map((row) => [
      row["grant_game_day"],
      row["ii_qty"],
      row["box_qty"],
    ]),
  ).toEqual([["2025-08-26", 48, 0]]);
  const solo = rows(`SELECT r.event_id,r.starts_at,r.ends_at FROM forecast_v2_calendar_heads h
    JOIN forecast_v2_calendar_revisions r ON r.event_id=h.event_id AND r.revision=h.revision
    WHERE r.kind='solo' AND r.status='confirmed'`);
  expect(solo.map((row) => [row["starts_at"], row["ends_at"]])).toEqual([
    ["2025-08-21T03:00:00.000Z", "2025-08-26T08:00:00.000Z"],
  ]);
  const days = activeDays();
  expect(days.get("2025-08-26")?.payload.grants.map((g) => [g.ii, g.box])).toEqual([[48, 0]]);
  expect(days.get("2025-08-26")?.events).toContain(String(solo[0]!["event_id"]));
  expect((await renderOutbox(db)).problems).toEqual([]);
});

it("maintenance-dependent collaboration start: D before G → refreshed request → simulated interaction admission → applied", async () => {
  await publish("D", [6701330]);
  // 2025-09-22 16:00–16:57 KST: G 6701562 (created 17:05) does not exist yet.
  await hour("2025-09-22T07:00:00.000Z");
  const unresolved = outboxFor("decision_request", "collaboration");
  expect(unresolved).toHaveLength(1);
  expect(
    JSON.parse(String(unresolved[0]!["payload_json"])).options.map((o: { id: string }) => o.id),
  ).not.toContain("new");
  deliver();
  await publish("G", [6701562]);
  // 2025-09-24 12:00–12:57 KST: G body stored, rules, then minute-57 refresh.
  await hour("2025-09-24T03:00:00.000Z");
  const refreshed = outboxFor("decision_request", "collaboration");
  expect(refreshed).toHaveLength(1);
  const payload = JSON.parse(String(refreshed[0]!["payload_json"])) as {
    decisionRequestId: string;
  };
  const stored = JSON.parse(
    String(
      rows(
        "SELECT payload_json FROM forecast_v2_decision_requests WHERE decision_id=?",
        payload.decisionRequestId,
      )[0]?.["payload_json"],
    ),
  ) as { extracted?: { startAt?: string; endAt?: string } };
  // expected/collaborations.json biohazard: G 6701562 end 07:00 → 28 game days.
  expect([
    Date.parse(stored.extracted?.startAt ?? ""),
    Date.parse(stored.extracted?.endAt ?? ""),
  ]).toEqual([Date.parse("2025-09-24T07:00:00+09:00"), Date.parse("2025-10-22T04:59:59+09:00")]);
  const messages = deliver();
  const now = "2025-09-24T04:00:00.000Z";
  vi.setSystemTime(Date.parse(now));
  const outboxId = String(refreshed[0]!["outbox_id"]);
  expect(await click(outboxId, messages.get(outboxId)!, (id) => id.endsWith(":new"), now)).toBe(
    true,
  );
  await hour("2025-09-24T04:00:00.000Z");
  expect(unexpectedHolds()).toEqual([]);
  const collaboration =
    rows(`SELECT r.event_id,r.starts_at,r.ends_at FROM forecast_v2_calendar_heads h
    JOIN forecast_v2_calendar_revisions r ON r.event_id=h.event_id AND r.revision=h.revision
    WHERE r.kind='collaboration' AND r.status='confirmed'`);
  expect(collaboration.map((row) => [row["starts_at"], row["ends_at"]])).toEqual([
    ["2025-09-23T22:00:00.000Z", "2025-10-21T19:59:59.000Z"],
  ]);
  const days = activeDays();
  const id = String(collaboration[0]!["event_id"]);
  expect(days.get("2025-09-24")?.events).toContain(id);
  expect(days.get("2025-09-24")?.events).toContain("maintenance_6701562");
  // Tuesday 2025-09-30 05:00 KST lies inside the collaboration → co-op ×10.
  expect(days.get("2025-09-30")?.payload.coop).toBe(10);
  expect((await renderOutbox(db)).problems).toEqual([]);
});
