import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { configureRules, processPostVersion, rebuildCalendar } from "./index";
import { localDatabase } from "./sqlite-test-db";

it("processes the largest captured detail and rebuilds its populated DB within 50ms thread CPU each", async () => {
  const base = new URL("../../../fixtures/forecast-v2/", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", base), "utf8")) as {
    records: { path: string; feedId?: string }[];
  };
  const details = manifest.records
    .filter((record) => record.path.startsWith("details/"))
    .map((record) => {
      const feed = JSON.parse(readFileSync(new URL(record.path, base), "utf8")).content.feed as {
        feedId: number;
        title: string;
        contents: string;
        createdDate: string;
      };
      return feed;
    })
    .sort((a, b) => Buffer.byteLength(b.contents) - Buffer.byteLength(a.contents));
  const largest = details[0]!;
  // The captured largest detail is a G maintenance notice; assert the routing premise.
  expect(largest.title).toContain("점검");
  const { db, sqlite } = localDatabase();
  try {
    configureRules({ environment: "staging" });
    const created = largest.createdDate.replace(
      /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/,
      "$1-$2-$3T$4:$5:$6+09:00",
    );
    const id = String(largest.feedId);
    sqlite
      .prepare(`INSERT INTO forecast_v2_monitor_runs(run_id,stream_id,generation,kind,status,started_at)
      VALUES('cpu','G',1,'new','completed',?)`)
      .run(created);
    sqlite
      .prepare("INSERT INTO forecast_v2_search_hits VALUES('cpu',?,?,?,?)")
      .run(id, created, created, JSON.stringify({ title: largest.title }));
    sqlite
      .prepare("INSERT INTO forecast_v2_post_versions VALUES('cpu',?,?,?,48,?,?,?)")
      .run(id, created, "a".repeat(64), created, created, largest.contents);
    const now = Date.parse("2026-10-18T08:00:00.000Z");
    const before = process.threadCpuUsage();
    await processPostVersion(db, { monitorId: "G", feedId: id, versionId: "cpu" }, now);
    const processCpu = process.threadCpuUsage(before);
    const calendarBefore = process.threadCpuUsage();
    await rebuildCalendar(db, now);
    const calendarCpu = process.threadCpuUsage(calendarBefore);
    const postMs = (processCpu.user + processCpu.system) / 1000;
    const calendarMs = (calendarCpu.user + calendarCpu.system) / 1000;
    console.log(
      JSON.stringify({
        feedId: id,
        bodyBytes: Buffer.byteLength(largest.contents),
        postMs,
        calendarMs,
      }),
    );
    expect(postMs).toBeLessThanOrEqual(50);
    expect(calendarMs).toBeLessThanOrEqual(50);
  } finally {
    sqlite.close();
  }
});
