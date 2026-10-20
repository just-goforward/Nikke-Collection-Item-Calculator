import { expect, it, vi } from "vitest";
import * as admission from "../../candidate-persistence";
import * as construction from "../../constructed-candidate";
import type { CollectorEnv } from "../../types";
import { localDatabase } from "../rules/sqlite-test-db";
import { now, seed } from "./fixture";
import { runV2CandidateUnit } from "./index";

it("caches duplicate-ID outcomes after a deployment without skipping new-input admission", async () => {
  const { db, sqlite } = localDatabase();
  const construct = vi.spyOn(construction, "buildConstructedForecastCandidate");
  const admit = vi.spyOn(admission, "processSourceQueue");
  try {
    await seed(db);
    const configuration = {
      FORECAST_DB: db,
      FORECAST_V2_MODE: "on",
      ENVIRONMENT: "staging",
      DEPLOY_SHA: "before",
    } as CollectorEnv;
    expect(await runV2CandidateUnit(configuration, now)).toEqual({ outcome: "built" });
    const original = await db.prepare("SELECT * FROM forecast_candidates").first<{
      candidate_id: string;
      payload_hash: string;
    }>();
    const sourcesBefore = sqlite.prepare("SELECT * FROM source_items ORDER BY item_id").all();
    construct.mockClear();
    admit.mockClear();

    const deployed = { ...configuration, DEPLOY_SHA: "after" };
    expect(await runV2CandidateUnit(deployed, now)).toEqual({ outcome: "unchanged" });
    expect(construct).toHaveBeenCalledTimes(1);
    expect(admit).not.toHaveBeenCalled();
    const rebuilt = await construct.mock.results[0]!.value;
    expect(rebuilt.envelope.candidate.candidateId).toBe(original!.candidate_id);
    // nextForecastRevision changes forecast/profile IDs, but the rebuild is discarded.
    expect(rebuilt.envelope.payloadHash).not.toBe(original!.payload_hash);
    expect(await db.prepare("SELECT * FROM forecast_candidates").first()).toEqual(original);
    expect(sqlite.prepare("SELECT * FROM source_items ORDER BY item_id").all()).toEqual(
      sourcesBefore,
    );
    const cache = await db.prepare("SELECT * FROM runtime_candidate_cache").first();
    expect(cache).toMatchObject({
      candidate_id: original!.candidate_id,
      payload_hash: original!.payload_hash,
    });
    const runs = sqlite.prepare("SELECT * FROM runtime_ingestion_runs ORDER BY token").all();
    expect(runs).toHaveLength(2);

    expect(await runV2CandidateUnit(deployed, now)).toEqual({ outcome: "unchanged" });
    expect(construct).toHaveBeenCalledTimes(1);
    expect(admit).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT * FROM forecast_candidates").first()).toEqual(original);
    expect(await db.prepare("SELECT * FROM runtime_candidate_cache").first()).toEqual(cache);
    expect(sqlite.prepare("SELECT * FROM runtime_ingestion_runs ORDER BY token").all()).toEqual(
      runs,
    );

    await db
      .prepare("INSERT INTO forecast_v2_grant_revisions VALUES('test',2,'2026-10-18',11,5,NULL,?)")
      .bind(new Date(now).toISOString())
      .run();
    await db
      .prepare("UPDATE forecast_v2_grant_heads SET revision=2,ii_qty=11 WHERE occurrence_id='test'")
      .run();
    expect(await runV2CandidateUnit(deployed, now)).toEqual({ outcome: "built" });
    expect(construct).toHaveBeenCalledTimes(2);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM forecast_candidates").first("n")).toBe(2);
  } finally {
    sqlite.close();
    vi.restoreAllMocks();
  }
});
