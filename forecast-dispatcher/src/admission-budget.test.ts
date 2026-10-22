import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as coverage from "../../shared/certifiedEvidenceCoverage.ts";
import { TEST_PUBLICATION_COVERAGE } from "../../shared/forecast-publication/test-coverage.ts";
import {
  migratePublicationDb,
  seedCandidate,
  TEST_NOW,
} from "../../shared/forecast-publication/test-fixtures.ts";
import { runDispatcher as runWithCoverage } from "./dispatcher.ts";
import type { DispatcherEnv } from "./types.ts";

const testEnv = env as DispatcherEnv;
const runDispatcher = (env: DispatcherEnv) => runWithCoverage(env, {}, TEST_PUBLICATION_COVERAGE);
let outbound: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  await reset();
  vi.setSystemTime(TEST_NOW);
  await migratePublicationDb(testEnv.FORECAST_DB, applyD1Migrations);
  outbound = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe("https://discord.com/api/v10/channels/123456789012345678/messages");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.enforce_nonce).toBe(true);
    return Response.json({ id: "123456789012345678" });
  });
  vi.stubGlobal("fetch", outbound);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("D1 admission evidence-wait budget", () => {
  it("admits with the real registered v11 coverage at the deployed dispatcher entry", async () => {
    const db = testEnv.FORECAST_DB;
    await seedCandidate(db);
    await runWithCoverage(testEnv);
    expect(
      await db.prepare("SELECT state,attempts,error_code FROM forecast_runtime_admissions").first(),
    ).toEqual({ state: "ready", attempts: 1, error_code: null });
    expect(await db.prepare("SELECT COUNT(*) n FROM forecast_runtime_versions").first()).toEqual({
      n: 1,
    });
    expect(outbound).toHaveBeenCalledOnce();
  });
  it("keeps repeated evidence waits at attempt 1, then admits with coverage", async () => {
    const db = testEnv.FORECAST_DB;
    const { candidate } = await seedCandidate(db);
    const gate = vi.spyOn(coverage, "hasCertifiedEvidenceCoverage").mockReturnValue(false);
    const evidenceRetryMs = 6 * 60 * 60_000;
    try {
      for (let wait = 0; wait < 3; wait += 1) {
        const now = TEST_NOW + wait * evidenceRetryMs;
        vi.setSystemTime(now);
        await runDispatcher(testEnv);
        expect(
          await db
            .prepare(`SELECT state,attempts,error_code,next_attempt_at,lease_token,lease_until
              FROM forecast_runtime_admissions WHERE candidate_id=?`)
            .bind(candidate.candidateId)
            .first(),
        ).toEqual({
          state: "pending",
          attempts: 1,
          error_code: "awaiting_evidence_panel",
          next_attempt_at: now + evidenceRetryMs,
          lease_token: null,
          lease_until: null,
        });
      }
      expect(await db.prepare("SELECT COUNT(*) n FROM forecast_runtime_versions").first()).toEqual({
        n: 0,
      });
      gate.mockReturnValue(true);
      vi.setSystemTime(TEST_NOW + 3 * evidenceRetryMs);
      await runDispatcher(testEnv);
      expect(
        await db.prepare("SELECT state,attempts FROM forecast_runtime_admissions").first(),
      ).toEqual({ state: "ready", attempts: 1 });
      expect(
        await db
          .prepare("SELECT candidate_id FROM forecast_runtime_reviews WHERE action='approve'")
          .first(),
      ).toEqual({ candidate_id: candidate.candidateId });
    } finally {
      gate.mockRestore();
    }
  });

  it.each([0, 3])(
    "allows exactly five real failures after %i initial evidence waits, even with later waits",
    async (initialWaits) => {
      const db = testEnv.FORECAST_DB;
      await seedCandidate(db);
      await db
        .prepare(`CREATE TRIGGER fail_admission BEFORE INSERT ON forecast_runtime_versions
          BEGIN SELECT RAISE(ABORT,'publication_admission_unavailable'); END`)
        .run();
      const gate = vi.spyOn(coverage, "hasCertifiedEvidenceCoverage").mockReturnValue(false);
      const evidenceRetryMs = 6 * 60 * 60_000;
      const retryMs = 5 * 60_000;
      let now = TEST_NOW;
      try {
        for (let wait = 0; wait < initialWaits; wait += 1) {
          vi.setSystemTime(now);
          await runDispatcher(testEnv);
          expect(
            await db.prepare("SELECT state,attempts FROM forecast_runtime_admissions").first(),
          ).toEqual({ state: "pending", attempts: 1 });
          now += evidenceRetryMs;
        }
        for (let attempt = 1; attempt <= 5; attempt += 1) {
          // Waiting after real failures must neither replenish nor consume the budget.
          // Attempt 5 also exercises selection/claim at the CHECK's upper boundary.
          if (attempt === 2 || attempt === 5) {
            gate.mockReturnValue(false);
            for (let wait = 0; wait < 2; wait += 1) {
              vi.setSystemTime(now);
              await runDispatcher(testEnv);
              expect(
                await db
                  .prepare(`SELECT state,attempts,error_code,next_attempt_at,lease_token,lease_until
                    FROM forecast_runtime_admissions`)
                  .first(),
              ).toEqual({
                state: "pending",
                attempts: attempt,
                error_code: "awaiting_evidence_panel",
                next_attempt_at: now + evidenceRetryMs,
                lease_token: null,
                lease_until: null,
              });
              now += evidenceRetryMs;
            }
          }
          gate.mockReturnValue(true);
          vi.setSystemTime(now);
          await runDispatcher(testEnv);
          expect(
            await db
              .prepare(`SELECT state,attempts,error_code,next_attempt_at,lease_token,lease_until
                FROM forecast_runtime_admissions`)
              .first(),
          ).toEqual({
            state: attempt === 5 ? "dead" : "pending",
            attempts: attempt,
            error_code: "D1_ERROR",
            next_attempt_at: now + retryMs,
            lease_token: null,
            lease_until: null,
          });
          now += retryMs;
        }
        await db.prepare("DROP TRIGGER fail_admission").run();
        gate.mockClear();
        vi.setSystemTime(now);
        await runDispatcher(testEnv);
        expect(gate).not.toHaveBeenCalled();
        expect(
          await db.prepare("SELECT state,attempts FROM forecast_runtime_admissions").first(),
        ).toEqual({ state: "dead", attempts: 5 });
        expect(
          await db.prepare("SELECT COUNT(*) n FROM forecast_runtime_versions").first(),
        ).toEqual({ n: 0 });
      } finally {
        gate.mockRestore();
      }
    },
  );
});
