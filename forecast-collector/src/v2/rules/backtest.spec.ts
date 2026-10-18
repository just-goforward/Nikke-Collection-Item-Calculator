import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildSnapshot } from "../../../../shared/certifiedSupplyBuild";
import { timestamp } from "../ingest/client";
import type { Stream } from "../ingest/schedule";
import { hash } from "./decisions";
import { collaborationEnd, gameDay } from "./game-day";
import {
  applyPendingDecisions,
  configureRules,
  processPostVersion,
  rebuildCalendar,
} from "./index";
import { judgeSolo } from "./schedules";
import { localDatabase } from "./sqlite-test-db";
import { renderOutbox } from "./validation/outbox-render";

type Feed = {
  feedId: number;
  title: string;
  contents: string;
  createdDate: string;
  updatedDate: string;
};
type ReplayError = { feed: string; stage: string; error: string };

/**
 * Lead-approved differences between the pinned 2y HTML (older parameters) and the
 * rules (oracle-2y.json `differences`; U7 widened). `expected` = HTML, `actual` = rules.
 * Any other per-item difference fails the replay.
 */
const APPROVED_DIFFERENCES = [
  {
    kind: "solo",
    id: "S26",
    expected: [
      ["2025-06-19T03:00:00.000Z", "2025-06-24T03:00:00.000Z"],
      ["2025-06-24T03:00:00.000Z", "2025-06-25T15:00:00.000Z"],
      ["2025-07-03T03:00:00.000Z", "2025-07-09T19:59:59.000Z"],
    ],
    actual: [
      ["2025-06-19T03:00:00.000Z", "2025-06-24T07:00:00.000Z"],
      ["2025-06-24T07:00:00.000Z", "2025-06-25T15:00:00.000Z"],
      ["2025-07-03T07:00:00.000Z", "2025-07-09T19:59:59.000Z"],
    ],
    reason: "6/24 boundary = G 6241570 end 16:00 KST; 7/3 start = G 6276795 end 16:00 KST",
  },
  {
    kind: "solo",
    id: "S37",
    expected: [["2026-05-28T03:00:00.000Z", "2026-06-03T19:59:59.000Z"]],
    actual: [["2026-05-28T06:00:00.000Z", "2026-06-03T19:59:59.000Z"]],
    reason: "'5/28 점검 완료 후' = G 7709605 end 15:00 KST",
  },
  {
    kind: "solo",
    id: "S38",
    expected: [
      ["2026-06-18T11:30:00.000Z", "2026-06-22T19:59:59.000Z"],
      ["2026-07-03T03:00:00.000Z", "2026-07-07T19:59:59.000Z"],
    ],
    actual: [
      ["2026-06-18T11:30:28.000Z", "2026-06-22T19:59:59.000Z"],
      ["2026-07-03T03:00:00.000Z", "2026-07-07T19:59:59.000Z"],
    ],
    reason: "HTML has minute precision; the source instant carries seconds (20:30:28 KST)",
  },
  ...(
    [
      ["에반게리온 제2탄 (+제1탄 복각)", "2025-02-20", "2025-02-20T00:00:00.000Z", "2025-03-19"],
      ["스텔라 블레이드", "2025-06-12", "2025-06-11T22:00:00.000Z", "2025-07-09"],
      ["니어: 오토마타 (복각)", "2025-07-03", "2025-07-03T07:00:00.000Z", "2025-07-30"],
      ["바이오하자드", "2025-09-24", "2025-09-23T22:00:00.000Z", "2025-10-21"],
      ["리코리스 리코일", "2026-02-12", "2026-02-11T22:00:00.000Z", "2026-03-11"],
      ["페르소나 (P3R·P4G·P5R)", "2026-08-13", "2026-08-12T22:00:00.000Z", "2026-09-09"],
    ] as const
  ).map(([id, day, start, endDay]) => ({
    kind: "collaboration",
    id,
    expected: [`${day}T03:00:00.000Z`, `${endDay}T19:59:59.000Z`],
    actual: [[start, `${endDay}T19:59:59.000Z`]],
    reason: "HTML 12:00 placeholder; rules start = resolved G maintenance end, end unchanged",
  })),
];
type ReplayContext = ReturnType<typeof localDatabase> & {
  base: URL;
  root: URL;
  manifest: { searches: { monitor: Stream; boardId: number; feedIds: number[] }[] };
  feeds: Map<string, Feed>;
  gIds: Set<string>;
  items: [string, Feed][];
  trace: Record<string, unknown>[];
  errors: ReplayError[];
};

it("T09 captured corpus replay with a stepped clock and explicit decision script", async () => {
  const base = new URL("../../../fixtures/forecast-v2/", import.meta.url);
  const root = new URL("../../../../", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", base), "utf8")) as {
    records: { path: string; feedId?: string }[];
    referenced: { feedId: string; path: string }[];
    searches: { monitor: Stream; boardId: number; feedIds: number[] }[];
  };
  const feeds = new Map<string, Feed>();
  for (const record of manifest.records.filter((record) => record.path.startsWith("details/")))
    feeds.set(
      record.feedId!,
      JSON.parse(readFileSync(new URL(record.path, base), "utf8")).content.feed,
    );
  for (const record of manifest.referenced)
    feeds.set(
      record.feedId,
      JSON.parse(readFileSync(new URL(record.path, root), "utf8")).content.feed,
    );
  const gIds = new Set<string>();
  for (const record of manifest.records.filter((record) => /^board48-limit10-/.test(record.path))) {
    const page = JSON.parse(readFileSync(new URL(record.path, base), "utf8"));
    for (const row of page.content.feeds) gIds.add(String(row.feedId));
  }
  const items = [...feeds.entries()].sort(
    (a, b) => Date.parse(timestamp(a[1].createdDate)) - Date.parse(timestamp(b[1].createdDate)),
  );
  const { db, sqlite } = localDatabase();
  configureRules({ environment: "staging" });
  const trace: Record<string, unknown>[] = [];
  const errors: { feed: string; stage: string; error: string }[] = [];
  const context: ReplayContext = {
    db,
    sqlite,
    base,
    root,
    manifest,
    feeds,
    gIds,
    items,
    trace,
    errors,
  };
  try {
    await replayCorpus(context);
    await verifyReplay(context);
  } finally {
    sqlite.close();
  }
}, 120000);

async function replayCorpus(context: ReplayContext) {
  const { db, sqlite, manifest, feeds, gIds, items, trace, errors } = context;
  let generation = 0;
  for (const [id, feed] of items) {
    const posted = timestamp(feed.createdDate);
    const updated = timestamp(feed.updatedDate ?? feed.createdDate);
    const streams: { monitor: Stream; boardId: number }[] = manifest.searches.filter((search) =>
      search.feedIds.includes(Number(id)),
    );
    if (gIds.has(id)) streams.unshift({ monitor: "G", boardId: 48 });
    const contentHash = await hash(feed.contents);
    const version = `fixture_${id}`;
    for (const stream of streams) {
      const run = `run_${++generation}`;
      sqlite
        .prepare(`INSERT INTO forecast_v2_monitor_runs(run_id,stream_id,generation,kind,status,started_at)
          VALUES(?,?,?,'new','completed',?)`)
        .run(run, stream.monitor, generation, posted);
      sqlite
        .prepare("INSERT INTO forecast_v2_search_hits VALUES(?,?,?,?,?)")
        .run(run, id, posted, updated, JSON.stringify({ title: feed.title }));
      sqlite
        .prepare(
          `INSERT INTO forecast_v2_post_versions VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
        )
        .run(version, id, updated, contentHash, stream.boardId, posted, posted, feed.contents);
      let judgment: unknown;
      try {
        judgment = await processPostVersion(
          db,
          { monitorId: stream.monitor, feedId: id, versionId: version },
          Date.parse(posted),
        );
      } catch (error) {
        errors.push({ feed: id, stage: stream.monitor, error: String(error) });
        judgment = { error: String(error) };
      }
      applyScriptedDecisions(sqlite, feeds, id, posted);
      await drainDecisions(context, id, posted);
      try {
        await rebuildCalendar(db, Date.parse(posted));
      } catch (error) {
        errors.push({ feed: id, stage: "calendar", error: String(error) });
      }
      trace.push({
        feed: id,
        stream: stream.monitor,
        at: posted,
        judgment,
        eventIds: sqlite
          .prepare(`SELECT DISTINCT event_id FROM forecast_v2_calendar_revisions
            WHERE EXISTS(SELECT 1 FROM json_each(source_feed_ids_json) WHERE value=?)`)
          .all(Number(id))
          .map((row) => row["event_id"]),
        grantIds: sqlite
          .prepare(`SELECT DISTINCT l.occurrence_id FROM forecast_v2_grant_links l
            JOIN forecast_v2_grant_observations o ON o.observation_id=l.observation_id WHERE o.feed_id=?`)
          .all(id)
          .map((row) => row["occurrence_id"]),
      });
    }
  }
}

/** Applies every resolved, unapplied result through the bounded decision step (one per call). */
async function drainDecisions(context: ReplayContext, id: string, posted: string) {
  const { db, sqlite, errors } = context;
  const unapplied = () =>
    Number(
      sqlite
        .prepare(`SELECT COUNT(*) AS n FROM forecast_v2_decision_requests q
          JOIN forecast_v2_decision_results r ON r.decision_id=q.decision_id
          WHERE q.status='resolved' AND NOT EXISTS(
            SELECT 1 FROM forecast_v2_admin_commands c WHERE c.decision_id=q.decision_id)`)
        .get()!["n"],
    );
  for (let budget = unapplied(); budget > 0; budget--) {
    try {
      const result = (await applyPendingDecisions(db, Date.parse(posted))) as {
        failure?: string;
      };
      if (result.failure) errors.push({ feed: id, stage: "decision", error: result.failure });
    } catch (error) {
      errors.push({ feed: id, stage: "decision", error: String(error) });
      return;
    }
  }
  if (unapplied()) errors.push({ feed: id, stage: "decision", error: "decision_not_applied" });
}

async function verifyReplay(context: ReplayContext) {
  const { sqlite, base, root } = context;
  const heads = sqlite
    .prepare(`SELECT r.* FROM forecast_v2_calendar_heads h
      JOIN forecast_v2_calendar_revisions r ON r.event_id=h.event_id AND r.revision=h.revision`)
    .all();
  const grants = sqlite.prepare("SELECT * FROM forecast_v2_grant_heads").all();
  const collaborations = heads.filter((row) => row["kind"] === "collaboration");
  const oracleRecord = JSON.parse(readFileSync(new URL("expected/oracle-2y.json", base), "utf8"));
  expect(await hash(readFileSync(new URL(oracleRecord.html.path, root), "utf8"))).toBe(
    oracleRecord.html.sha256,
  );
  const oracle = oracleRecord.htmlSnapshot as {
    solo: { season: number; segments: string[][] }[];
    collab: { name: string; start: string }[];
    kits: { date: string; ii: number; i: number; src: number[] }[];
    b11: number[];
  };
  const differences: { kind: string; id: string; expected: unknown; actual: unknown }[] = [];
  const endInstant = (value: string) =>
    new Date(`${value}:${value.endsWith("04:59") ? "59" : "00"}+09:00`).toISOString();
  const seasonRows = (season: number) =>
    heads.filter(
      (row) =>
        row["kind"] === "solo" &&
        row["prediction_provenance_json"] &&
        JSON.parse(String(row["prediction_provenance_json"])).round === season,
    );
  for (const season of oracle.solo) {
    const expected = season.segments.map((segment) => [
      new Date(`${segment[0]}:00+09:00`).toISOString(),
      endInstant(segment[1]!),
    ]);
    const actual = seasonRows(season.season)
      .map((row) => [row["starts_at"], row["ends_at"]])
      .sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual))
      differences.push({ kind: "solo", id: `S${season.season}`, expected, actual });
  }
  for (const event of oracle.collab) {
    const start = new Date(`${event.start}:00+09:00`).toISOString();
    const expected = [start, collaborationEnd(start)];
    const actual = collaborations
      .filter((row) => row["start_game_day"] === gameDay(start))
      .map((row) => [row["starts_at"], row["ends_at"]]);
    if (JSON.stringify([expected]) !== JSON.stringify(actual))
      differences.push({ kind: "collaboration", id: event.name, expected, actual });
  }
  for (const row of collaborations)
    if (!oracle.collab.some((expected) => expected.start.slice(0, 10) === row["start_game_day"]))
      differences.push({
        kind: "collaboration_extra",
        id: String(row["event_id"]),
        expected: null,
        actual: [row["starts_at"], row["ends_at"]],
      });
  const expectedGrants = oracle.kits.map((grant) => [grant.date, grant.ii, grant.i]).sort();
  const actualGrants = grants
    .map((grant) => [grant["grant_game_day"], grant["ii_qty"], grant["box_qty"]])
    .sort();
  for (const expected of expectedGrants)
    if (!actualGrants.some((actual) => JSON.stringify(expected) === JSON.stringify(actual)))
      differences.push({
        kind: "grant_missing",
        id: String(expected[0]),
        expected,
        actual: null,
      });
  for (const actual of actualGrants)
    if (!expectedGrants.some((expected) => JSON.stringify(expected) === JSON.stringify(actual)))
      differences.push({ kind: "grant_extra", id: String(actual[0]), expected: null, actual });
  await verifySummary(context, grants, collaborations, seasonRows, differences);
}

type SqlRows = ReturnType<ReturnType<ReplayContext["sqlite"]["prepare"]>["all"]>;
async function verifySummary(
  context: ReplayContext,
  grants: SqlRows,
  collaborations: SqlRows,
  seasonRows: (season: number) => SqlRows,
  differences: { kind: string; id: string; expected: unknown; actual: unknown }[],
) {
  const { db, sqlite, trace, errors } = context;
  const coop = [
    ...new Map(
      ["2024-10-18", "2025-10-18"]
        .flatMap(
          (asOf) =>
            buildSnapshot({
              asOf: `${asOf}T05:00:00+09:00`,
              horizonDays: 366,
              revision: "backtest",
              sourceHash: "0".repeat(64),
              soloPeriods: [],
              collaborationPeriods: collaborations.map((row) => ({
                effectiveFrom: String(row["starts_at"]),
                effectiveUntil: String(row["ends_at"]),
              })),
            }).events,
        )
        .filter(
          (event) =>
            event.kind === "shop" &&
            event.gameDate >= "2024-10-18" &&
            event.gameDate < "2026-10-18",
        )
        .map((event) => [event.id, event]),
    ).values(),
  ];
  const summary = {
    items: trace.length,
    errors,
    collaborations: collaborations.length,
    grants: grants.length,
    ii: grants.reduce((sum, row) => sum + Number(row["ii_qty"]), 0),
    box: grants.reduce((sum, row) => sum + Number(row["box_qty"]), 0),
    coopWeeks: coop.length,
    doubledWeeks: coop.filter((event) =>
      event.refs.some((ref) => ref.lawId === "box-ii-v1" && ref.count === 10),
    ).length,
    bReports: Number(
      sqlite
        .prepare("SELECT COUNT(*) AS n FROM forecast_v2_notification_outbox WHERE kind='b_report'")
        .get()!["n"],
    ),
    seasons: Array.from({ length: 24 }, (_, i) => i + 19).filter(
      (season) => seasonRows(season).length,
    ),
    s19Segments: seasonRows(19).length,
    s26Resolved: seasonRows(26).some(
      (row) =>
        row["start_game_day"] === "2025-07-03" && row["ends_at"] === "2025-07-09T19:59:59.000Z",
    ),
    s26MaintenanceBoundary:
      seasonRows(26).some((row) => row["ends_at"] === "2025-06-24T07:00:00.000Z") &&
      seasonRows(26).some(
        (row) =>
          row["starts_at"] === "2025-06-24T07:00:00.000Z" &&
          row["ends_at"] === "2025-06-25T15:00:00.000Z",
      ),
    s38Reopen: seasonRows(38).some((row) =>
      JSON.parse(String(row["source_feed_ids_json"])).includes(7877359),
    ),
    collaborationEndsValid: collaborations.every(
      (row) => row["ends_at"] === collaborationEnd(String(row["starts_at"])),
    ),
  };
  const before = process.threadCpuUsage();
  let calendarCpuMs: number | null = null;
  try {
    await rebuildCalendar(db, Date.parse("2026-10-18T10:00:00.000Z"));
    const cpu = process.threadCpuUsage(before);
    calendarCpuMs = (cpu.user + cpu.system) / 1000;
  } catch (error) {
    errors.push({ feed: "end", stage: "calendar", error: String(error) });
  }
  // Diagnostic trace only; tests never write into fixtures.
  const tracePath = join(mkdtempSync(join(tmpdir(), "forecast-v2-backtest-")), "trace.json");
  writeFileSync(
    tracePath,
    JSON.stringify(
      {
        limitation:
          "One captured final version per feed; historical pre-edit bodies are unavailable. Unscripted decisions remain pending.",
        summary,
        calendarCpuMs,
        differences,
        trace,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ ...summary, errors: errors.length, calendarCpuMs, tracePath }));
  // F12: every per-item difference from the pinned HTML must be explicitly approved.
  expect(differences).toEqual(APPROVED_DIFFERENCES.map(({ reason: _reason, ...item }) => item));
  // F1: every real outbox row of the corpus replay renders with contract custom_ids.
  const rendered = await renderOutbox(db);
  console.log(
    JSON.stringify({
      outbox: rendered.rows,
      kinds: rendered.kinds,
      decisionTypes: rendered.decisionTypes,
      customIds: rendered.customIds.length,
      maxCustomIdLength: rendered.maxCustomIdLength,
    }),
  );
  expect(rendered.problems).toEqual([]);
  expect(rendered.maxCustomIdLength).toBeLessThanOrEqual(100);
  expect(Object.keys(rendered.kinds).sort()).toEqual(
    expect.arrayContaining(["b_report", "calendar_changed", "decision_request"]),
  );
  expect(Object.keys(rendered.decisionTypes)).toEqual(
    expect.arrayContaining(["solo_review", "grant_date", "collaboration"]),
  );
  expect(errors.length, JSON.stringify(errors.slice(0, 3))).toBe(0);
  expect(calendarCpuMs).not.toBeNull();
  expect(calendarCpuMs!).toBeLessThanOrEqual(50);
  expect(summary).toMatchObject({
    collaborations: 6,
    grants: 11,
    ii: 338,
    box: 35,
    coopWeeks: 104,
    doubledWeeks: 23,
    bReports: 15,
    seasons: Array.from({ length: 24 }, (_, i) => i + 19),
    s19Segments: 3,
    s26Resolved: true,
    s26MaintenanceBoundary: true,
    s38Reopen: true,
    collaborationEndsValid: true,
  });
}

type ScriptPayload = {
  feedIds: number[];
  options: { id: string; label: string }[];
  extracted?: { startAt?: string; endAt?: string };
};
function scriptedSolo(sqlite: ReplayContext["sqlite"], original: Feed | undefined) {
  if (!original) return null;
  const maintenance = sqlite
    .prepare(`SELECT h.event_id id,r.starts_at startAt,r.ends_at endAt
                FROM forecast_v2_calendar_heads h JOIN forecast_v2_calendar_revisions r
                ON r.event_id=h.event_id AND r.revision=h.revision WHERE r.kind='maintenance' AND r.status='confirmed'`)
    .all();
  const judgment = judgeSolo(
    {
      title: original.title,
      body: original.contents,
      postedAt: timestamp(original.createdDate),
    },
    maintenance.map((row) => ({
      id: String(row["id"]),
      startAt: String(row["startAt"]),
      endAt: String(row["endAt"]),
    })),
  );
  return judgment.action === "confirmed"
    ? { action: "edit", startAt: judgment.startAt, endAt: judgment.endAt }
    : null;
}
function scriptedAction(
  sqlite: ReplayContext["sqlite"],
  feeds: Map<string, Feed>,
  id: string,
  type: unknown,
  payload: ScriptPayload,
) {
  let action: Record<string, unknown> | null = null;
  if (type === "collaboration" && payload.feedIds.includes(7660727))
    action = { action: "opt", optionId: "ignore" };
  if (
    type === "grant_date" &&
    (payload.feedIds.includes(6579018) || payload.feedIds.includes(5090650))
  ) {
    const selectedTime = payload.feedIds.includes(6579018) ? "T21:00" : "T18:00";
    const option = payload.options.find((option) => option.label.includes(selectedTime));
    if (option) action = { action: "opt", optionId: option.id };
  }
  if (type === "collaboration" && payload.options.some((option) => option.id === "new")) {
    const existing = sqlite
      .prepare(`SELECT 1 FROM forecast_v2_calendar_heads h
              JOIN forecast_v2_calendar_revisions r ON r.event_id=h.event_id AND r.revision=h.revision
              WHERE r.kind='collaboration' AND r.status='confirmed' AND r.start_game_day=?`)
      .get(gameDay(payload.extracted!.startAt!));
    action = { action: "opt", optionId: existing ? "same" : "new" };
  }
  if (type === "solo_review" && payload.extracted?.startAt && payload.extracted?.endAt)
    action = { action: "bok" };
  if (!action && type === "solo_review")
    action = scriptedSolo(sqlite, feeds.get(String(payload.feedIds[0])));
  if (id === "6280133" && type === "solo_review" && payload.feedIds.includes(6252194))
    action = {
      action: "edit",
      startAt: "2025-07-03T12:00:00+09:00",
      endAt: "2025-07-10T04:59:59+09:00",
    };
  return action;
}
function applyScriptedDecisions(
  sqlite: ReplayContext["sqlite"],
  feeds: Map<string, Feed>,
  id: string,
  posted: string,
) {
  const pending = sqlite
    .prepare(`SELECT decision_id,type,payload_json,expected_calendar_revision
          FROM forecast_v2_decision_requests WHERE status='pending'`)
    .all();
  for (const request of pending) {
    const payload = JSON.parse(String(request["payload_json"])) as ScriptPayload;
    const action = scriptedAction(sqlite, feeds, id, request["type"], payload);
    if (!action) continue;
    const decisionId = String(request["decision_id"]);
    sqlite
      .prepare("INSERT INTO forecast_v2_consumed_interactions VALUES(?,?,?)")
      .run(decisionId, decisionId, posted);
    sqlite.prepare("INSERT INTO forecast_v2_decision_results VALUES(?,?,?,?)").run(
      decisionId,
      decisionId,
      JSON.stringify({
        ...action,
        actorId: "backtest",
        decidedAt: posted,
        expectedRevision: request["expected_calendar_revision"],
      }),
      posted,
    );
    sqlite
      .prepare("UPDATE forecast_v2_decision_requests SET status='resolved' WHERE decision_id=?")
      .run(decisionId);
  }
}
