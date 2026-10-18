import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import { loadScheduleEvents, sourceItemAndEventStatements } from "./db";
import { decideManualReview } from "./manual-review";
import { runRuntimeCandidate } from "./runtime-ingestion";
import { coldCandidate } from "./test-cold-candidate";
import { runtimeTestDb } from "./test-runtime-db";
import type { CollectorEnv } from "./types";

export async function coldCandidateLifecycle(
  source: DatabaseSync,
  env: CollectorEnv,
  now: number,
  fixture: string,
) {
  const directory = await mkdtemp(join(tmpdir(), "forecast-lifecycle-"));
  try {
    const file = join(directory, "state.sqlite");
    await backup(source, file);
    const sqlite = new DatabaseSync(file);
    try {
      const db = runtimeTestDb(sqlite);
      const local = { ...env, FORECAST_DB: db, USAGE_GUARD_DB: db };
      expect(
        (await coldCandidate(sqlite, local, now, fixture, "a")).cold?.result.candidateCreated,
      ).toBe(true);
      const first = (await loadScheduleEvents(db))[0];
      if (!first) throw new Error("cold_fixture_empty");
      const item = {
        ...first.sourceItem,
        source: "naver-board-56" as const,
        itemId: "99000001",
        url: "https://game.naver.com/lounge/nikke/board/detail/99000001",
      };
      await db.batch(
        sourceItemAndEventStatements(
          db,
          [item],
          [
            {
              eventId: "cold-orphan",
              eventType: "schedule_change",
              sourceItem: item,
              startsAt: null,
              endsAt: null,
              scheduleStatus: "confirmed",
              manualReview: true,
              reason: "cold_orphan_review",
            },
          ],
          new Date().toISOString(),
        ),
      );
      expect(
        (await coldCandidate(sqlite, local, now, fixture, "b")).cold?.result.candidateCreated,
      ).toBe(false);
      await runRuntimeCandidate(local, now);
      expect(
        (await coldCandidate(sqlite, local, now, fixture, "c")).cold?.result.candidateCreated,
      ).toBe(false);
      const review = sqlite
        .prepare("SELECT review_id FROM source_manual_reviews WHERE item_id='99000001'")
        .get();
      await decideManualReview(
        db,
        "staging",
        String(review?.["review_id"]),
        {
          requestId: `mrq-${"e".repeat(32)}`,
          decision: "ignore",
          reason: "cold fixture decision",
          runId: 1,
          event: null,
        },
        { runtimeIngestion: true },
      );
      expect(
        (await coldCandidate(sqlite, local, now, fixture, "d")).cold?.result.candidateCreated,
      ).toBe(true);
      await runRuntimeCandidate(local, now);
      expect(
        (await coldCandidate(sqlite, local, now, fixture, "e")).cold?.result.candidateCreated,
      ).toBe(false);
    } finally {
      sqlite.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
