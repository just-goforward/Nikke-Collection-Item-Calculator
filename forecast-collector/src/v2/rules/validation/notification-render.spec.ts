import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { timestamp } from "../../ingest/client";
import type { Stream } from "../../ingest/schedule";
import { decisionIdentity, hash } from "../decisions";
import { configureRules, processPostVersion, rebuildCalendar } from "../index";
import { localDatabase } from "../sqlite-test-db";
import { renderOutbox } from "./outbox-render";

// F1: decisions the collector produces for the types the captured corpus never
// triggers (grant_quantity, maintenance, maintenance_grant) plus a corpus
// collaboration decision, created by the real processPostVersion and rendered
// through renderForecastV2Notification. The corpus-wide render runs in backtest.spec.ts.
type Feed = { title: string; contents: string; createdDate: string; updatedDate?: string };
const fixtures = new URL("../../../../fixtures/", import.meta.url);
const manifest = JSON.parse(
  readFileSync(new URL("forecast-v2/manifest.json", fixtures), "utf8"),
) as {
  referenced: { feedId: string; path: string }[];
};
const referenced = new Map(manifest.referenced.map((r) => [r.feedId, r.path]));
function feed(id: number): Feed {
  const path = referenced.get(String(id));
  const url = path
    ? new URL(path.replace("forecast-collector/fixtures/", ""), fixtures)
    : new URL(`forecast-v2/details/${id}.json`, fixtures);
  return JSON.parse(readFileSync(url, "utf8")).content.feed;
}
const boards: Record<Stream, number> = {
  A: 11,
  B: 11,
  "C-open": 56,
  "C-reopen": 56,
  D: 56,
  E: 48,
  F: 48,
  G: 48,
};

let context: ReturnType<typeof localDatabase>;
let generation = 0;
beforeEach(() => {
  context = localDatabase();
  configureRules({ environment: "staging" });
});
afterEach(() => context.sqlite.close());

/** Stores one post version as ingest does and runs the real rules step on it. */
async function ingest(
  feedId: number,
  stream: Stream,
  post: { title: string; body: string; created: string; updated?: string },
) {
  const { db, sqlite } = context;
  const created = new Date(post.created).toISOString();
  const updated = new Date(post.updated ?? post.created).toISOString();
  const versionId = `${feedId}:${await hash(post.body)}:${updated}`;
  const run = `run_${++generation}`;
  sqlite
    .prepare(`INSERT INTO forecast_v2_monitor_runs(run_id,stream_id,generation,kind,status,started_at)
      VALUES(?,?,?,'new','completed',?)`)
    .run(run, stream, generation, updated);
  sqlite
    .prepare("INSERT INTO forecast_v2_search_hits VALUES(?,?,?,?,?)")
    .run(run, String(feedId), created, updated, JSON.stringify({ title: post.title }));
  sqlite
    .prepare("INSERT INTO forecast_v2_post_versions VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING")
    .run(
      versionId,
      String(feedId),
      updated,
      await hash(post.body),
      boards[stream],
      created,
      updated,
      post.body,
    );
  await processPostVersion(
    db,
    { monitorId: stream, feedId: String(feedId), versionId },
    Date.parse(updated),
  );
  await rebuildCalendar(db, Date.parse(updated));
  return versionId;
}
async function ingestFixture(feedId: number, stream: Stream) {
  const source = feed(feedId);
  return ingest(feedId, stream, {
    title: source.title,
    body: source.contents,
    created: timestamp(source.createdDate),
    updated: timestamp(source.updatedDate ?? source.createdDate),
  });
}
const pending = (type: string) =>
  context.sqlite
    .prepare(
      "SELECT decision_id FROM forecast_v2_decision_requests WHERE type=? ORDER BY created_at",
    )
    .all(type)
    .map((row) => String(row["decision_id"]));
const head = (sql: string, ...values: string[]) => context.sqlite.prepare(sql).all(...values);

describe("F1 every produced decision renders within the custom_id contract", () => {
  it("maintenance_grant, grant_quantity, maintenance and collaboration requests", async () => {
    const kit = feed(8091116); // all-account II ×24 inline grant (board 48, 무점검)
    // G 7767444: 2026-06-11 11:00 ~ 21:00 (extended); 7783210 (A): II ×20 at '6/11 점검 완료 후'.
    await ingestFixture(7767444, "G");
    const grantVersion = await ingestFixture(7783210, "A");
    expect(
      head(`SELECT grant_game_day,ii_qty,box_qty FROM forecast_v2_grant_heads`).map((r) => [
        r["grant_game_day"],
        r["ii_qty"],
        r["box_qty"],
      ]),
    ).toEqual([["2026-06-11", 20, 0]]);
    // Synthetic F post: the same inline grant moved to 6/12 → occurrence 2026-06-12 II24.
    await ingest(990_001, "F", {
      title: "6/12(금) 무점검 업데이트 안내",
      body: kit.contents.replaceAll("8/22(토)", "6/12(금)"),
      created: "2026-06-12T20:06:08+09:00",
    });
    // Edited G 7767444: maintenance now ends 6/12 06:00, i.e. on game day 2026-06-12,
    // where a different-quantity occurrence exists → maintenance_grant decision (grant_quantity).
    await ingest(7_767_444, "G", {
      title: "[점검&업데이트] 6월 11일(목) 업데이트 소식 사전 안내",
      body: "✔️ 점검 일시\n- 6월 11일(목) 11:00:00 ~ 6월 12일(금) 06:00:00",
      created: "2026-06-08T17:02:51+09:00",
      updated: "2026-06-13T09:00:00+09:00",
    });
    const maintenanceRevision = Number(
      head(
        "SELECT revision FROM forecast_v2_calendar_heads WHERE event_id='maintenance_7767444'",
      )[0]?.["revision"],
    );
    expect(maintenanceRevision).toBe(2);
    const observation = `observation_${await hash(grantVersion)}`;
    const maintenanceGrant = await decisionIdentity(
      "maintenance_grant",
      "maintenance_7767444",
      maintenanceRevision,
      observation,
    );
    expect(pending("grant_quantity")).toContain(maintenanceGrant);
    // Synthetic F post with different quantities on 2026-06-12 → direct grant_quantity.
    await ingest(990_002, "F", {
      title: "6/12(금) 무점검 업데이트 안내",
      body: kit.contents.replaceAll("8/22(토)", "6/12(금)").replaceAll("* 24", "* 30"),
      created: "2026-06-12T21:00:00+09:00",
    });
    expect(pending("grant_quantity").filter((id) => id !== maintenanceGrant)).toHaveLength(1);
    // Synthetic second maintenance notice on the same KST date → maintenance decision.
    await ingest(990_003, "G", {
      title: "[긴급 점검] 6월 11일(목) 긴급 점검 안내",
      body: "✔️ 점검 일시\n- 6월 11일(목) 12:00 ~ 13:00",
      created: "2026-06-11T11:30:00+09:00",
    });
    expect(pending("maintenance")).toHaveLength(1);
    // Corpus: 7660727 archive re-addition (U22) → collaboration decision.
    await ingestFixture(7660727, "D");
    expect(pending("collaboration")).toHaveLength(1);

    const report = await renderOutbox(context.db);
    expect(report.problems).toEqual([]);
    expect(report.maxCustomIdLength).toBeLessThanOrEqual(100);
    expect(report.decisionTypes).toMatchObject({
      grant_quantity: 2,
      maintenance: 1,
      collaboration: 1,
    });
    // One rendered decision_request per decision row (buttons checked by renderOutbox).
    expect(report.kinds["decision_request"]).toBe(report.decisionIds.length);
  });
});
