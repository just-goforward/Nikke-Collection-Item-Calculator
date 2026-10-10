import { applyD1Migrations, createExecutionContext, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeTestSql } from "../../shared/testD1Sql";
import schemaSql from "../schema.sql?raw";
import { readHealth } from "./db";
import { handleHttpRequest } from "./http";
import { readOperationsHealth } from "./ops";
import { seedNormalUsageGuard } from "./test-usage-guard";
import type { CollectorEnv } from "./types";

const testEnv: CollectorEnv = {
  FORECAST_DB: env.FORECAST_DB,
  USAGE_GUARD_DB: env.USAGE_GUARD_DB,
  ADMIN_TOKEN: env.ADMIN_TOKEN,
  ENVIRONMENT: "test",
  DEPLOY_SHA: env.DEPLOY_SHA,
  POLL_MODE: "both",
};
const origin = "https://nikkecollection.com";
const timestamp = "2026-10-01T00:00:00.000Z";

beforeEach(async () => {
  await reset();
  await executeTestSql(testEnv.FORECAST_DB, schemaSql, applyD1Migrations);
  await seedNormalUsageGuard(testEnv.USAGE_GUARD_DB);
});

async function activeProcessor() {
  await testEnv.FORECAST_DB.prepare(
    "INSERT INTO source_processor_state(singleton_id,state,updated_at) VALUES(1,'active',?)",
  )
    .bind(timestamp)
    .run();
}

async function queue(
  itemId: string,
  options: { official?: number; status?: string; errorCode?: string | null } = {},
) {
  await testEnv.FORECAST_DB.prepare(
    `INSERT INTO source_queue(source,item_id,url,title,published_at,official,status,
      review_generation,error_code,first_seen_at,updated_at)
     VALUES('naver-board-48',?,'https://game.naver.com/notice','private body',?, ?,?,3,?,?,?)`,
  )
    .bind(
      itemId,
      timestamp,
      options.official ?? 1,
      options.status ?? "manual_review",
      options.errorCode ?? null,
      timestamp,
      timestamp,
    )
    .run();
}

async function health(
  requestOrigin: string | null = origin,
  environment: CollectorEnv["ENVIRONMENT"] = "staging",
) {
  const headers = new Headers();
  if (requestOrigin !== null) headers.set("origin", requestOrigin);
  return handleHttpRequest(
    new Request("https://collector.example/health", {
      headers,
    }),
    { ...testEnv, ENVIRONMENT: environment },
    createExecutionContext(),
  );
}

type PublicReview = {
  state: "current" | "review_pending";
  processingBlocked: boolean;
  changedSources: {
    source: string;
    itemId: string;
    generation: number;
    errorCode: string | null;
  }[];
};

function notice(itemId: string, errorCode: string | null = null) {
  return { source: "naver-board-48", itemId, generation: 3, errorCode };
}

async function expectReview(payload: unknown, sourceReview: PublicReview) {
  expect(payload).toEqual({
    ...(await readHealth(testEnv.FORECAST_DB)),
    operations: await readOperationsHealth(testEnv.FORECAST_DB, "staging"),
    sourceReview,
  });
}

describe("staging public advisory health", () => {
  it("runs against the canonical staging schema21", async () => {
    expect(
      await testEnv.FORECAST_DB.prepare(
        "SELECT MAX(version) AS version FROM schema_migrations",
      ).first(),
    ).toEqual({ version: 21 });
    expect((await health()).status).toBe(200);
  });

  it("preserves health fields and serves current metadata to only the approved origin", async () => {
    await activeProcessor();
    await queue("irrelevant", { official: 0 });
    const existing = {
      ...(await readHealth(testEnv.FORECAST_DB)),
      operations: await readOperationsHealth(testEnv.FORECAST_DB, "staging"),
    };
    const response = await health();
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(response.headers.get("vary")).toBe("Origin");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(payload).toEqual({
      ...existing,
      sourceReview: { state: "current", processingBlocked: false, changedSources: [] },
    });
  });

  it.each([
    [1, null],
    [0, "source_queue_authority_unknown"],
    [0, "source_body_revision_requires_review"],
  ])("retains relevant holds without a live review card: %s %s", async (official, errorCode) => {
    await activeProcessor();
    await queue("99991", { official, errorCode });
    const payload = await (await health()).json();
    await expectReview(payload, {
      state: "review_pending",
      processingBlocked: false,
      changedSources: [notice("99991", errorCode)],
    });
    expect(JSON.stringify(payload)).not.toContain("private body");
  });
});

describe("staging processor uncertainty", () => {
  it.each(["retry", "held", "verifying", "verified", "absent", "expired-lease"])(
    "reports %s processor state as blocked without concealing notices",
    async (state) => {
      await queue("changed");
      if (state !== "absent") {
        await activeProcessor();
        if (state === "expired-lease") {
          await testEnv.FORECAST_DB.prepare(
            "UPDATE source_processor_state SET active_token=?,lease_until=? WHERE singleton_id=1",
          )
            .bind("a".repeat(36), timestamp)
            .run();
        } else {
          await testEnv.FORECAST_DB.prepare(
            "UPDATE source_processor_state SET state=? WHERE singleton_id=1",
          )
            .bind(state)
            .run();
        }
      }
      const payload = await (await health()).json();
      await expectReview(payload, {
        state: "review_pending",
        processingBlocked: true,
        changedSources: [notice("changed")],
      });
    },
  );
});

describe("staging relevant-source review authority", () => {
  it.each([
    ["solo", 0, null, "review_pending"],
    ["collaboration", 0, null, "review_pending"],
    ["schedule_change", 1, "changed", "review_pending"],
    ["schedule_change", 1, "manual_review_ignored", "current"],
    ["schedule_change", 1, "manual_review_resolved", "current"],
  ])(
    "retains accepted/reviewable schedule relevance: %s %s %s",
    async (eventType, manualReview, reason, expected) => {
      await activeProcessor();
      await queue("schedule", { official: 0 });
      await testEnv.FORECAST_DB.prepare(
        `INSERT INTO source_items(source,item_id,url,title,excerpt,published_at,content_hash,structured,official,first_seen_at,last_seen_at)
       SELECT source,item_id,url,title,'private excerpt',published_at,?,1,official,first_seen_at,updated_at
       FROM source_queue WHERE item_id='schedule'`,
      )
        .bind("a".repeat(64))
        .run();
      await testEnv.FORECAST_DB.prepare(
        `INSERT INTO schedule_events(event_id,event_type,source,source_item_id,schedule_status,manual_review,reason,observed_at)
       VALUES('event',?,'naver-board-48','schedule','confirmed',?,?,?)`,
      )
        .bind(eventType, manualReview, reason, timestamp)
        .run();
      await expectReview(await (await health()).json(), {
        state: expected === "current" ? "current" : "review_pending",
        processingBlocked: false,
        changedSources: expected === "current" ? [] : [notice("schedule")],
      });
    },
  );

  it("retains unresolved processor exceptions even outside manual_review until positive resolution", async () => {
    await activeProcessor();
    await queue("exception", { official: 0, status: "ignored" });
    const token = "a".repeat(36);
    const proof = "b".repeat(36);
    const exception = "c".repeat(36);
    await testEnv.FORECAST_DB.prepare(
      `INSERT INTO source_processor_runs(token,epoch,kind,status,started_at,lease_until)
       VALUES(?,1,'recovery','failure',?,?)`,
    )
      .bind(token, timestamp, timestamp)
      .run();
    await testEnv.FORECAST_DB.prepare(
      `INSERT INTO source_processor_incidents(origin_run_token,epoch,scope,outcome,error_code,created_at)
       VALUES(?,1,'detail','failure','source_body_unavailable',?)`,
    )
      .bind(token, timestamp)
      .run();
    await testEnv.FORECAST_DB.prepare(
      `INSERT INTO source_processor_recovery_probes(proof_id,recovery_run_token,request_id,payload_hash,origin_run_token,
        source,item_id,source_generation,item_claim_token,metadata_json,failed_error_code,response_hash,request_profile_hash,comparable,created_at)
       VALUES(?,?,'request','hash',?,'naver-board-48','exception',0,?,'{}','source_body_unavailable',?,?,1,?)`,
    )
      .bind(proof, token, token, token, "a".repeat(64), "b".repeat(64), timestamp)
      .run();
    await testEnv.FORECAST_DB.prepare(
      `INSERT INTO source_processor_item_exceptions(exception_id,proof_id,recovery_run_token,request_id,payload_hash,
        source,item_id,source_generation,review_generation,review_id,metadata_json,item_claim_token,mode,reason,force_confirmed,created_at)
       VALUES(?,?,?,'request','hash','naver-board-48','exception',0,3,'review','{}',?,'comparable-control','recognized exception',0,?)`,
    )
      .bind(exception, proof, token, token, timestamp)
      .run();
    const payload = await (await health()).json();
    await expectReview(payload, {
      state: "review_pending",
      processingBlocked: false,
      changedSources: [notice("exception")],
    });
    await testEnv.FORECAST_DB.prepare(
      `INSERT INTO source_processor_exception_resolutions(exception_id,run_token,result_token,source_generation,body_hash,revision_hash,resolved_at)
       VALUES(?,?,?,0,'body','revision',?)`,
    )
      .bind(exception, token, token, timestamp)
      .run();
    await expectReview(await (await health()).json(), {
      state: "current",
      processingBlocked: false,
      changedSources: [],
    });
  });
});

describe("staging public metadata bounds and read-only access", () => {
  it("does not infer healthy authority from an empty queue or candidate counts", async () => {
    const payload = await (await health()).json();
    await expectReview(payload, {
      state: "current",
      processingBlocked: true,
      changedSources: [],
    });
  });

  it("bounds changed notices to twenty and bounds oversized public strings without clearing the hold", async () => {
    await activeProcessor();
    for (let i = 0; i < 21; i++) await queue(String(i).padStart(3, "0"));
    const changedSources = Array.from({ length: 20 }, (_, i) => notice(String(i).padStart(3, "0")));
    await expectReview(await (await health()).json(), {
      state: "review_pending",
      processingBlocked: false,
      changedSources,
    });
    await testEnv.FORECAST_DB.prepare("UPDATE source_queue SET error_code=? WHERE item_id='000'")
      .bind("x".repeat(513))
      .run();
    const oversized = await (await health()).json();
    await expectReview(oversized, {
      state: "review_pending",
      processingBlocked: true,
      changedSources: changedSources.map((row, i) => {
        if (i === 0) return notice(row.itemId, "x".repeat(512));
        return row;
      }),
    });
  });

  it.each([
    null,
    "null",
    "https://evil.example",
    `${origin}.evil.example`,
    `${origin}/`,
    "http://nikkecollection.com",
  ])("does not grant CORS to %s", async (requestOrigin) => {
    const response = await health(requestOrigin);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it.each([false, true])(
    "performs only SELECTs without renewing cards or settling a lease (%s)",
    async (withLease) => {
      await queue("expired");
      await testEnv.FORECAST_DB.prepare(
        `INSERT INTO source_manual_reviews(review_id,source,item_id,generation,state,created_at,expires_at,resolved_at)
       VALUES(?,'naver-board-48','expired',3,'expired',?,?,?)`,
      )
        .bind(`mr-${"a".repeat(32)}`, timestamp, timestamp, timestamp)
        .run();
      if (withLease) {
        await activeProcessor();
        await testEnv.FORECAST_DB.prepare(
          "UPDATE source_processor_state SET active_token=?,lease_until=? WHERE singleton_id=1",
        )
          .bind("a".repeat(36), timestamp)
          .run();
      }
      const prepare = vi.spyOn(testEnv.FORECAST_DB, "prepare");
      try {
        expect((await health()).status).toBe(200);
        expect(prepare.mock.calls.length).toBeGreaterThan(0);
        for (const [sql] of prepare.mock.calls) expect(sql.trim()).toMatch(/^SELECT\b/i);
      } finally {
        prepare.mockRestore();
      }
      const processor = await testEnv.FORECAST_DB.prepare(
        "SELECT state,active_token,lease_until FROM source_processor_state WHERE singleton_id=1",
      ).first();
      if (withLease) {
        expect(processor).toEqual({
          state: "active",
          active_token: "a".repeat(36),
          lease_until: timestamp,
        });
      } else {
        expect(processor).toBeNull();
      }
      expect(
        await testEnv.FORECAST_DB.prepare(
          "SELECT generation,state FROM source_manual_reviews",
        ).all(),
      ).toMatchObject({ results: [{ generation: 3, state: "expired" }] });
    },
  );

  it("retains the quota stop with no source queries and an approved-origin readable error", async () => {
    await testEnv.USAGE_GUARD_DB?.prepare("UPDATE usage_guard_state SET action='hard_stop'").run();
    const prepare = vi.spyOn(testEnv.FORECAST_DB, "prepare");
    try {
      const response = await health();
      expect(response.status).toBe(503);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
    }
  });
});

describe("unchanged production and protected routes", () => {
  it("leaves production schema10 health usable with no staging metadata or CORS", async () => {
    await reset();
    // The canonical schema appends upgrades 11–21 after the schema10 tables.
    await executeTestSql(
      testEnv.FORECAST_DB,
      schemaSql.slice(0, schemaSql.indexOf("CREATE TABLE IF NOT EXISTS source_processing_claims")),
      applyD1Migrations,
    );
    await seedNormalUsageGuard(testEnv.USAGE_GUARD_DB);
    expect(
      await testEnv.FORECAST_DB.prepare(
        "SELECT MAX(version) AS version FROM schema_migrations",
      ).first(),
    ).toEqual({ version: 10 });
    const response = await health(origin, "production");
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("vary")).toBeNull();
    expect(await response.json()).toEqual({
      ...(await readHealth(testEnv.FORECAST_DB)),
      operations: await readOperationsHealth(testEnv.FORECAST_DB, "production"),
    });
  });

  it.each([
    ["GET", "/admin/candidates", true, 401],
    ["GET", "/admin/candidates", false, 429],
    ["POST", "/discord/interactions", false, 429],
    ["OPTIONS", "/health", true, 404],
    ["POST", "/health", true, 404],
  ])("keeps %s %s protected and without CORS", async (method, path, success, status) => {
    const limit = vi.fn().mockResolvedValue({ success });
    const runtimeEnv: CollectorEnv = {
      ...testEnv,
      ENVIRONMENT: "staging",
      ADMIN_RATE_LIMITER: { limit },
    };
    const response = await handleHttpRequest(
      new Request(`https://collector.example${path}`, {
        method,
        headers: { origin },
      }),
      runtimeEnv,
      createExecutionContext(),
    );
    expect(response.status).toBe(status);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
