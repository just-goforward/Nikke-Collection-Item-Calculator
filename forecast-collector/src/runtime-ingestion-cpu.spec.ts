import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import * as supplyBuild from "../../shared/supplyForecastBuild";
import * as candidateBuild from "../../shared/supplyForecastCandidate";
import { sourceItemAndEventStatements } from "./db";
import { parseNoticeDetail } from "./notice";
import { runRuntimeCandidate, runRuntimeIngestion } from "./runtime-ingestion";
import { assertCandidateFingerprint } from "./test-candidate-fingerprint";
import { coldCandidateLifecycle } from "./test-cold-lifecycle";
import { enqueue, env, now, root, sqlite } from "./test-ingestion-fixture";

it("measures full ingestion CPU for captured update 8189601", async () => {
  const payload = JSON.parse(
    readFileSync(new URL("fixtures/naver-detail-8189601.json", root), "utf8"),
  );
  await enqueue(payload);
  const sourceItem = await parseNoticeDetail(payload, 48, "8189601");
  if (!sourceItem) throw new Error("missing CPU fixture");
  await env.FORECAST_DB.batch(
    sourceItemAndEventStatements(env.FORECAST_DB, [sourceItem], [], new Date().toISOString()),
  );
  const insert = sqlite.prepare(`INSERT INTO schedule_events
    (event_id,event_type,source,source_item_id,starts_at,ends_at,schedule_status,manual_review,reason,observed_at)
    VALUES(?,'solo','naver-board-48','8189601',?,?,'confirmed',0,NULL,?)`);
  for (let index = 0; index < 240; index++) {
    const start = new Date(Date.UTC(2000, 0, 1 + index * 28)).toISOString();
    insert.run(
      `cpu-history-${index}`,
      start,
      new Date(Date.parse(start) + 7 * 86400000).toISOString(),
      start,
    );
  }
  const revision = sqlite.prepare(`INSERT INTO source_notice_revisions
    (source,item_id,source_revision,body_hash,revision_hash,semantic_hash,item_json,events_json,observed_at)
    VALUES('naver-board-48',?,1,?,?,?,?,'[]',?)`);
  for (let index = 0; index < 60; index++) {
    revision.run(
      `cpu-revision-${index}`,
      "a".repeat(64),
      "b".repeat(64),
      "c".repeat(64),
      JSON.stringify({ ...sourceItem, normalizedText: "점검 ".repeat(5500) }),
      sourceItem.publishedAt,
    );
  }
  // Vitest shares a process with its coordinator and other workers; process-wide
  // CPU includes their startup/GC. Measure the ingestion worker's CPU instead.
  let snapshotCpuMs = 0,
    publicationCpuMs = 0;
  const originalSnapshot = supplyBuild.buildScheduleForecastSnapshot;
  const originalCandidate = candidateBuild.buildSupplyForecastCandidate;
  const snapshotSpy = vi
    .spyOn(supplyBuild, "buildScheduleForecastSnapshot")
    .mockImplementation((...args) => {
      const start = process.threadCpuUsage();
      try {
        return originalSnapshot(...args);
      } finally {
        const used = process.threadCpuUsage(start);
        snapshotCpuMs += (used.user + used.system) / 1000;
      }
    });
  const publicationSpy = vi
    .spyOn(candidateBuild, "buildSupplyForecastCandidate")
    .mockImplementation((...args) => {
      const start = process.threadCpuUsage();
      try {
        return originalCandidate(...args);
      } finally {
        const used = process.threadCpuUsage(start);
        publicationCpuMs += (used.user + used.system) / 1000;
      }
    });
  const started = process.threadCpuUsage();
  await runRuntimeIngestion(env, {
    fetcher: vi.fn<typeof fetch>().mockImplementation(async () => Response.json(payload)),
    candidateNowMs: now,
  });
  const used = process.threadCpuUsage(started);
  const cpuMs = (used.user + used.system) / 1000;
  const ingestionSnapshotCpuMs = snapshotCpuMs,
    ingestionPublicationCpuMs = publicationCpuMs;
  await coldCandidateLifecycle(sqlite, env, now, "8189601");
  snapshotCpuMs = 0;
  publicationCpuMs = 0;
  snapshotSpy.mockClear();
  publicationSpy.mockClear();
  const candidateStart = process.threadCpuUsage();
  const publication = await runRuntimeCandidate(env, now);
  const candidateCpu = process.threadCpuUsage(candidateStart);
  const candidateCpuMs = (candidateCpu.user + candidateCpu.system) / 1000;
  expect(snapshotSpy).toHaveBeenCalledOnce();
  expect(publicationSpy).toHaveBeenCalledOnce();
  snapshotSpy.mockRestore();
  publicationSpy.mockRestore();
  expect(publication).toMatchObject({ outcome: "completed", candidateCreated: true });
  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM forecast_candidates").get()?.["count"]).toBe(
    1,
  );
  console.log(
    JSON.stringify({
      fixture: "8189601",
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuMs,
      candidateCpuMs,
      ingestionSnapshotCpuMs,
      ingestionPublicationCpuMs,
      snapshotCpuMs,
      publicationCpuMs,
      method:
        "process.threadCpuUsage user+system; 240 schedule events + 60 board-48 revisions (~16k characters), local SQLite, mocked GET",
    }),
  );
  expect(cpuMs).toBeLessThanOrEqual(50);
  expect(candidateCpuMs).toBeLessThanOrEqual(50);
  await assertCandidateFingerprint(env, "8189601");
});
