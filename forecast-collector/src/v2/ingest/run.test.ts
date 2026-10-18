import { describe, expect, it, vi } from "vitest";
import { runV2Invocation, type V2Env } from "./run";
import {
  declaredOversize,
  detailPayload,
  iso,
  malformedJson,
  metadataRow,
  type Post,
  page,
  pagePayload,
  status,
  streamedOversize,
  timeout,
  transportError,
} from "./test-support/naver";
import {
  at,
  cutoff,
  db,
  disposition,
  failurePost,
  failureT,
  guard,
  ingestTwo,
  invoke,
  kstMinus,
  naver,
  newer,
  older,
  oldPost,
  posts,
  processed,
  quietStreams,
  rules,
  seedVersions,
  useRunHarness,
  v2Env,
} from "./test-support/run-harness";
import {
  alerts,
  attempts,
  boundary,
  budget,
  count,
  hits,
  preferEditScan,
  rulesQueue,
  runs,
  seedBoundary,
  seedBudget,
  seedLease,
  state,
  versions,
} from "./test-support/v2-db";

useRunHarness();

describe("T03 scan and boundary", () => {
  const p103: Post = { feedId: 103, created: "2026-10-17T12:00:00" };
  const p102: Post = { feedId: 102, created: "2026-10-16T18:00:00" };
  const p101: Post = { feedId: 101, created: "2026-10-14T12:00:00" }; // before the cutoff

  it("bootstraps from the explicit cutoff, stores eligible hits and bodies oldest first, one unit per invocation", async () => {
    naver
      .page("A", 0, page("A", [p103, p102, p101]))
      .detail(103, detailPayload("A", p103))
      .detail(102, detailPayload("A", p102));
    expect(await invoke(at("03:00"))).toEqual({ outcome: "completed" });
    expect(naver.metadataCalls().map((call) => call.url.searchParams.get("offset"))).toEqual(["0"]);
    expect(await boundary(db, "A")).toEqual({ createdAt: iso(p103.created), feedIds: ["103"] });
    expect(await hits(db)).toEqual(["103", "102"]);
    expect(await runs(db, "A")).toMatchObject([
      { generation: 1, kind: "new", status: "completed", pages_used: 1 },
    ]);

    expect(await invoke(at("03:09"))).toMatchObject({
      outcome: "body_stored",
      versionId: expect.stringMatching(/^102:[0-9a-f]{64}:/),
    });
    expect(await invoke(at("03:15"))).toMatchObject({
      outcome: "body_stored",
      versionId: expect.stringMatching(/^103:/),
    });
    expect(naver.detailCalls()).toEqual(["102", "103"]);
    expect((await versions(db)).map((v) => [v.feed_id, v.updated_date, v.body_text])).toEqual([
      ["102", iso(p102.created), "body 102"],
      ["103", iso(p103.created), "body 103"],
    ]);
    expect(await budget(db, "2026-10-18")).toEqual({ metadata_used: 1, detail_used: 2 });
    expect((await attempts(db)).map((a) => [a.kind, a.outcome])).toEqual([
      ["metadata", "success"],
      ["detail", "success"],
      ["detail", "success"],
    ]);
    expect((await state(db, "A")).lease_owner).toBeNull();
    expect(guard).toHaveBeenCalled();
  });

  it("tracks equal-timestamp ties and never re-fetches a known boundary post", async () => {
    const T = "2026-10-17T12:00:00";
    const tied = [203, 202, 201].map((feedId): Post => ({ feedId, created: T }));
    await seedBoundary(db, "A", iso(T), ["201"]);
    await seedVersions([tied[2]!]);
    naver
      .page("A", 0, page("A", [...tied, { feedId: 200, created: kstMinus(T, 60) }]))
      .detail(202, detailPayload("A", tied[1]!))
      .detail(203, detailPayload("A", tied[0]!));
    expect(await invoke(at("03:00"))).toEqual({ outcome: "completed" });
    expect(await boundary(db, "A")).toEqual({ createdAt: iso(T), feedIds: ["201", "202", "203"] });
    await invoke(at("03:09"));
    await invoke(at("03:15"));
    expect(naver.detailCalls()).toEqual(["202", "203"]);
  });

  it.each([
    ["on", 1],
    ["hold", 0],
  ] as const)(
    "%s: re-seeds a deleted boundary from the newest valid older row (alerts: %i) and resumes (F14)",
    async (mode, alertCount) => {
      const T = "2026-10-17T12:00:00";
      const p303: Post = { feedId: 303, created: kstMinus(T, -60) };
      const p302: Post = { feedId: 302, created: T };
      const p299: Post = { feedId: 299, created: kstMinus(T, 60) };
      await seedBoundary(db, "A", iso(T), ["301"]);
      await seedVersions([p299]); // ingested when it was new
      naver
        .page("A", 0, page("A", [p303, p302, p299]))
        .detail(303, detailPayload("A", p303))
        .detail(302, detailPayload("A", p302));
      expect(await invoke(at("03:00"), mode)).toMatchObject({ outcome: "completed" });
      expect(await boundary(db, "A")).toEqual({ createdAt: iso(p299.created), feedIds: ["299"] });
      expect(await hits(db)).toEqual(["303", "302"]);
      expect((await state(db, "A")).consecutive_holds).toBe(0);
      const raised = await alerts(db);
      expect(raised).toHaveLength(alertCount);
      if (alertCount)
        expect(raised[0]).toMatchObject({
          environment: "staging",
          state: "open",
          context: { stream: "A" },
        });
      await invoke(at("03:09"), mode);
      await invoke(at("03:15"), mode);
      expect(await invoke(at("04:00"), mode)).toEqual({ outcome: "completed" });
      expect(await boundary(db, "A")).toEqual({ createdAt: iso(p303.created), feedIds: ["303"] });
      expect(naver.detailCalls()).toEqual(["302", "303"]);
      expect(await alerts(db)).toHaveLength(alertCount);
    },
  );

  it("holds after four pages, keeps the boundary, and retries from page 0 next slot", async () => {
    const all = posts(120);
    await seedVersions(all);
    for (let p = 0; p < 5; p++)
      naver.page(
        "A",
        p,
        page(
          "A",
          all.slice(p * 30, p * 30 + 30).length ? all.slice(p * 30, p * 30 + 30) : [oldPost],
        ),
      );
    const outcomes = [];
    for (const minute of ["03:00", "03:09", "03:15", "03:21"])
      outcomes.push((await invoke(at(minute))).outcome);
    expect(outcomes).toEqual(["running", "running", "running", "held"]);
    expect(naver.metadataCalls("A").map((call) => call.url.searchParams.get("offset"))).toEqual([
      "0",
      "30",
      "60",
      "90",
    ]);
    expect(await runs(db, "A")).toMatchObject([
      { status: "held", pages_used: 4, error_code: "page_cap" },
    ]);
    expect([null, cutoff]).toContain((await boundary(db, "A")).createdAt);
    expect((await state(db, "A")).consecutive_holds).toBe(1);
    expect(await hits(db)).toHaveLength(120);

    await invoke(at("04:00"));
    expect(naver.metadataCalls("A").at(-1)?.page).toBe(0);
    expect(await runs(db, "A")).toHaveLength(2);
  });

  it("keeps the boundary on a failed later page and resumes at that page", async () => {
    const first = posts(30);
    const rest = posts(5, 4000, "2026-10-17T11:00:00");
    await seedVersions([...first, ...rest]);
    naver.page("A", 0, page("A", first)).page("A", 1, status(503), page("A", [...rest, oldPost]));
    expect((await invoke(at("03:00"))).outcome).toBe("running");
    expect(await invoke(at("03:09"))).toEqual({ outcome: "held", reason: "http_503" });
    expect([null, cutoff]).toContain((await boundary(db, "A")).createdAt);
    expect(await runs(db, "A")).toMatchObject([{ status: "running", pages_used: 1 }]);
    expect(await invoke(at("03:15"))).toEqual({ outcome: "completed" });
    expect(naver.metadataCalls("A").map((call) => call.page)).toEqual([0, 1, 1]);
    expect(await boundary(db, "A")).toEqual({
      createdAt: iso(first[0]!.created),
      feedIds: [String(first[0]!.feedId)],
    });
    expect(await hits(db)).toHaveLength(35);
  });

  it("replays identical responses idempotently", async () => {
    const list = posts(2);
    naver.page("A", 0, page("A", [...list, oldPost]));
    for (const post of list) naver.detail(post.feedId, detailPayload("A", post));
    await invoke(at("03:00"));
    await invoke(at("03:09"));
    await invoke(at("03:15"));
    const before = { boundary: await boundary(db, "A"), versions: await versions(db) };
    expect(await invoke(at("04:00"))).toEqual({ outcome: "completed" });
    expect(await invoke(at("05:00"))).toEqual({ outcome: "completed" });
    expect(naver.detailCalls()).toHaveLength(2);
    expect({ boundary: await boundary(db, "A"), versions: await versions(db) }).toEqual(before);
    expect((await runs(db, "A")).map((run) => run.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
  });
});

describe("T03 failures hold without advancing", () => {
  const T = failureT;
  const fresh = failurePost;
  const foreign = () => Response.json(pagePayload([metadataRow("A", fresh, { boardId: 48 })]));
  const oversizedPage = () => Response.json(page("A", posts(31)));
  it.each<[string, () => () => Response | Promise<Response>, string, boolean]>([
    ["400", () => status(400), "http_400", false],
    ["429", () => status(429), "http_429", true],
    ["500", () => status(500), "http_500", true],
    ["502", () => status(502), "http_502", true],
    ["timeout", timeout, "timeout", true],
    ["transport", transportError, "transport", true],
    ["declared oversize", declaredOversize, "oversize", true],
    ["streamed oversize", streamedOversize, "oversize", true],
    ["wrong board", () => foreign, "identity", false],
    ["31-row page", () => oversizedPage, "page_size", false],
    ["malformed JSON", malformedJson, "invalid_response", false],
  ])("metadata %s → typed hold", async (_name, reply, code, retryable) => {
    await seedBoundary(db, "A", iso(T), ["10"]);
    naver.page("A", 0, reply());
    expect(await invoke(at("03:00"))).toEqual({ outcome: "held", reason: code });
    expect(await boundary(db, "A")).toEqual({ createdAt: iso(T), feedIds: ["10"] });
    expect(await runs(db, "A")).toMatchObject([{ status: "running", pages_used: 0 }]);
    expect(await hits(db)).toEqual([]);
    expect(await attempts(db)).toEqual([
      {
        kind: "metadata",
        feed_id: null,
        game_day: "2026-10-18",
        outcome: "failure",
        error_code: code,
        next_attempt_at: retryable ? "2026-10-18T03:03:00.000Z" : null,
      },
    ]);
    expect(await budget(db, "2026-10-18")).toEqual({ metadata_used: 1, detail_used: 0 });
    expect((await state(db, "A")).consecutive_holds).toBe(1);
  });

  it.each<[string, () => () => Response | Promise<Response>, string]>([
    ["429", () => status(429), "http_429"],
    ["500", () => status(500), "http_500"],
    ["timeout", timeout, "timeout"],
    ["oversize", streamedOversize, "oversize"],
  ])("detail %s → typed hold, body retried later", async (_name, reply, code) => {
    naver
      .page("A", 0, page("A", [fresh, oldPost]))
      .detail(fresh.feedId, reply(), detailPayload("A", fresh));
    expect(await invoke(at("03:00"))).toEqual({ outcome: "completed" });
    const advanced = await boundary(db, "A");
    expect(await invoke(at("03:09"))).toEqual({ outcome: "held", reason: code });
    expect(await versions(db)).toEqual([]);
    expect(await boundary(db, "A")).toEqual(advanced);
    expect((await invoke(at("03:15"))).outcome).toBe("body_stored");
    expect(await versions(db)).toHaveLength(1);
    expect(await budget(db, "2026-10-18")).toEqual({ metadata_used: 1, detail_used: 2 });
  });

  it("bounds attempts for one failing body at 3 (plan §1.1)", async () => {
    naver.page("A", 0, page("A", [fresh, oldPost])).detail(fresh.feedId, status(500));
    await invoke(at("03:00"));
    for (const minute of ["03:09", "03:15", "03:21", "03:27", "03:30", "03:42"])
      await invoke(at(minute));
    expect(naver.detailCalls()).toEqual(["11", "11", "11"]);
  });

  it("malformed detail JSON → invalid_response, counted toward the 3-attempt cap, then the stream continues", async () => {
    const next: Post = { feedId: 12, created: kstMinus(T, -120) };
    naver
      .page("A", 0, page("A", [next, fresh, oldPost]))
      .detail(fresh.feedId, malformedJson())
      .detail(next.feedId, detailPayload("A", next));
    expect((await invoke(at("03:00"))).outcome).toBe("completed");
    expect(await invoke(at("03:09"))).toEqual({ outcome: "held", reason: "invalid_response" });
    expect(await invoke(at("03:15"))).toEqual({ outcome: "held", reason: "invalid_response" });
    expect(await invoke(at("03:21"))).toEqual({ outcome: "held", reason: "attempts_exhausted" });
    expect(await disposition(fresh.feedId)).toEqual(["failed"]);
    expect(
      (await attempts(db))
        .filter((a) => a.kind === "detail")
        .map((a) => [a.feed_id, a.outcome, a.error_code]),
    ).toEqual([
      ["11", "failure", "invalid_response"],
      ["11", "failure", "invalid_response"],
      ["11", "failure", "invalid_response"],
    ]);
    expect((await invoke(at("03:27"))).outcome).toBe("body_stored");
    expect(naver.detailCalls()).toEqual(["11", "11", "11", "12"]);
    expect((await versions(db)).map((v) => v.feed_id)).toEqual(["12"]);
    expect(await budget(db, "2026-10-18")).toEqual({ metadata_used: 1, detail_used: 4 });
    expect(await invoke(at("04:00"))).toEqual({ outcome: "completed" });
    expect(naver.detailCalls()).toHaveLength(4);
  });
});

describe("T03 body lifecycle after a failed or stale fetch", () => {
  const T = failureT;
  const fresh = failurePost;
  it.each<[string, (() => () => Response | Promise<Response>)[], string[], string]>([
    ["deleted (404)", [() => status(404)], ["03:09"], "deleted"],
    [
      "failed (3× malformed JSON)",
      [malformedJson, malformedJson, malformedJson],
      ["03:09", "03:15", "03:21"],
      "failed",
    ],
  ])(
    "a %s post is fetched again once an edit scan shows a newer updatedDate",
    async (_name, failures, failMinutes, terminal) => {
      const next: Post = { feedId: 12, created: kstMinus(T, -120) };
      const edited: Post = { ...fresh, updated: "2026-10-18T11:30:00", body: "복구된 본문" };
      naver
        .page("A", 0, page("A", [next, fresh, oldPost]), page("A", [next, edited, oldPost]))
        .detail(fresh.feedId, ...failures.map((reply) => reply()), detailPayload("A", edited))
        .detail(next.feedId, detailPayload("A", next));
      await invoke(at("03:00"));
      for (const minute of failMinutes) expect((await invoke(at(minute))).outcome).toBe("held");
      expect(await disposition(fresh.feedId)).toEqual([terminal]);
      expect((await invoke(at("03:27"))).outcome).toBe("body_stored");
      const committed = await boundary(db, "A");
      await preferEditScan(db, "A", at("03:40"));
      // Ingestion-only minutes: :39/:42/:48 are rules slots, :51/:54 candidate/decision units.
      expect(await invoke(at("03:30"))).toEqual({ outcome: "completed" });
      expect((await runs(db, "A")).at(-1)).toMatchObject({ kind: "edit", status: "completed" });
      expect(await invoke(at("04:09"))).toMatchObject({
        outcome: "body_stored",
        versionId: expect.stringMatching(/^11:/),
      });
      expect(naver.detailCalls()).toEqual([...failMinutes.map(() => "11"), "12", "11"]);
      expect((await versions(db)).map((v) => [v.feed_id, v.updated_date, v.body_text])).toEqual([
        ["12", iso(next.created), "body 12"],
        ["11", iso(edited.updated!), "복구된 본문"],
      ]);
      expect(await boundary(db, "A")).toEqual(committed);
      await invoke(at("04:15"));
      expect(naver.detailCalls()).toHaveLength(failMinutes.length + 2);
    },
  );

  it("detail 404 → hit marked deleted without retry, and the stream continues", async () => {
    const next: Post = { feedId: 12, created: kstMinus(T, -120) };
    naver
      .page("A", 0, page("A", [next, fresh, oldPost]))
      .detail(fresh.feedId, status(404))
      .detail(next.feedId, detailPayload("A", next));
    expect((await invoke(at("03:00"))).outcome).toBe("completed");
    const committed = await boundary(db, "A");
    expect(committed).toEqual({ createdAt: iso(next.created), feedIds: ["12"] });
    expect(await invoke(at("03:09"))).toEqual({ outcome: "held", reason: "http_404" });
    expect(await disposition(fresh.feedId)).toEqual(["deleted"]);
    expect((await attempts(db)).filter((a) => a.kind === "detail")).toMatchObject([
      { feed_id: "11", outcome: "failure", error_code: "http_404", next_attempt_at: null },
    ]);
    expect((await invoke(at("03:15"))).outcome).toBe("body_stored");
    expect(await invoke(at("04:00"))).toEqual({ outcome: "completed" });
    expect(naver.detailCalls()).toEqual(["11", "12"]);
    expect((await versions(db)).map((v) => v.feed_id)).toEqual(["12"]);
    expect(await boundary(db, "A")).toEqual(committed);
    expect((await state(db, "A")).consecutive_holds).toBe(0);
  });

  it("an edit between scan and body fetch does not wedge the stream", async () => {
    const edited: Post = { ...fresh, updated: kstMinus(T, -120) };
    naver
      .page("A", 0, page("A", [fresh, oldPost]), page("A", [edited, oldPost]))
      .detail(fresh.feedId, detailPayload("A", edited));
    await invoke(at("03:00"));
    expect(await invoke(at("03:09"))).toEqual({ outcome: "held", reason: "detail_drift" });
    await invoke(at("04:00"));
    await invoke(at("04:09"));
    await invoke(at("04:15"));
    expect(naver.metadataCalls("A")).toHaveLength(2);
    expect((await versions(db)).map((v) => v.updated_date)).toEqual([iso(edited.updated!)]);
    const settled = naver.detailCalls().length;
    await invoke(at("04:21"));
    await invoke(at("04:27"));
    expect(naver.detailCalls()).toHaveLength(settled);
  });

  it("reports a body write fenced by a lost lease as a hold, not as stored", async () => {
    naver.page("A", 0, page("A", [fresh, oldPost])).detail(fresh.feedId, async () => {
      await db
        .prepare(
          "UPDATE forecast_v2_monitor_state SET lease_owner='thief',lease_expires_at=? WHERE stream_id='A'",
        )
        .bind(at("23:00"))
        .run();
      return Response.json(detailPayload("A", fresh));
    });
    await invoke(at("03:00"));
    const result = await invoke(at("03:09"));
    expect(await versions(db)).toEqual([]);
    expect(result).toEqual({ outcome: "held", reason: "lease_lost" });
  });
});

describe("T03 request budget per KST game day", () => {
  const fresh: Post = { feedId: 11, created: "2026-10-17T12:00:00" };

  it("holds metadata at 240 without requesting or advancing", async () => {
    await seedBoundary(db, "A", cutoff, []);
    await seedBudget(db, "2026-10-18", { metadata: 240 });
    naver.page("A", 0, page("A", [fresh, oldPost]));
    expect(await invoke(at("03:00"))).toEqual({ outcome: "held", reason: "budget_exhausted" });
    expect(naver.calls).toEqual([]);
    expect(await attempts(db)).toEqual([]);
    expect(await boundary(db, "A")).toEqual({ createdAt: cutoff, feedIds: [] });
    expect(await budget(db, "2026-10-18")).toEqual({ metadata_used: 240, detail_used: 0 });
  });

  it("admits the 240th metadata request and holds the 241st", async () => {
    await seedBudget(db, "2026-10-18", { metadata: 239 });
    naver.page("A", 0, page("A", posts(30))).page("A", 1, page("A", [oldPost]));
    await seedVersions(posts(30));
    expect((await invoke(at("03:00"))).outcome).toBe("running");
    expect(await invoke(at("03:09"))).toEqual({ outcome: "held", reason: "budget_exhausted" });
    expect(naver.metadataCalls()).toHaveLength(1);
  });

  it("holds bodies at 48 detail requests", async () => {
    naver.page("A", 0, page("A", [fresh, oldPost])).detail(fresh.feedId, detailPayload("A", fresh));
    await invoke(at("03:00"));
    await db
      .prepare("UPDATE forecast_v2_request_budgets SET detail_used=48 WHERE game_day='2026-10-18'")
      .run();
    expect(await invoke(at("03:09"))).toEqual({ outcome: "held", reason: "budget_exhausted" });
    expect(naver.detailCalls()).toEqual([]);
    expect(await versions(db)).toEqual([]);
  });

  it("counts retries against the budget", async () => {
    naver.page("A", 0, status(500), page("A", [fresh, oldPost]));
    expect((await invoke(at("03:00"))).outcome).toBe("held");
    expect((await invoke(at("03:09"))).outcome).toBe("completed");
    expect(await budget(db, "2026-10-18")).toEqual({ metadata_used: 2, detail_used: 0 });
    expect((await attempts(db)).map((a) => a.outcome)).toEqual(["failure", "success"]);
  });

  it("rolls over at 05:00 KST", async () => {
    await seedBudget(db, "2026-10-18", { metadata: 240, detail: 48 });
    naver.page("A", 0, page("A", [fresh, oldPost]));
    expect(await invoke("2026-10-18T19:00:00.000Z")).toEqual({
      outcome: "held",
      reason: "budget_exhausted",
    }); // 04:00 KST
    expect(naver.calls).toEqual([]);
    expect(await invoke("2026-10-18T20:00:00.000Z")).toEqual({ outcome: "completed" }); // 05:00 KST
    expect(await budget(db, "2026-10-19")).toEqual({ metadata_used: 1, detail_used: 0 });
    expect((await attempts(db)).map((a) => a.game_day)).toEqual(["2026-10-19"]);
  });
});

describe("T03 leases", () => {
  const fresh: Post = { feedId: 11, created: "2026-10-17T12:00:00" };

  it("one of two concurrent invocations for the same slot wins", async () => {
    naver.page("A", 0, page("A", [fresh, oldPost]));
    const results = await Promise.all([invoke(at("03:00")), invoke(at("03:00"))]);
    expect(results).toEqual(
      expect.arrayContaining([{ outcome: "completed" }, { outcome: "held", reason: "lease" }]),
    );
    expect(naver.metadataCalls()).toHaveLength(1);
    expect((await state(db, "A")).consecutive_holds).toBe(0);
    expect(await runs(db, "A")).toHaveLength(1);
  });

  it("respects an unexpired foreign lease and takes over an expired one", async () => {
    naver.page("A", 0, page("A", [fresh, oldPost]));
    await seedLease(db, "A", "ghost", "2026-10-18T03:00:01.000Z");
    expect(await invoke(at("03:00"))).toEqual({ outcome: "held", reason: "lease" });
    expect(naver.calls).toEqual([]);
    expect((await state(db, "A")).lease_owner).toBe("ghost");
    await seedLease(db, "A", "ghost", "2026-10-18T03:00:00.000Z");
    expect(await invoke(at("03:00"))).toEqual({ outcome: "completed" });
    expect((await state(db, "A")).lease_owner).toBeNull();
  });
});

describe("T03 rules port and modes", () => {
  const ruleWrites = [
    "forecast_v2_legacy_links",
    "forecast_v2_notification_outbox",
    "forecast_v2_decision_requests",
    "forecast_v2_calendar_revisions",
    "forecast_v2_calendar_heads",
    "forecast_v2_calendar_snapshots",
    "forecast_v2_calendar_active",
    "forecast_v2_admin_commands",
    "forecast_v2_grant_observations",
    "forecast_v2_grant_revisions",
  ];

  it("calls processPostVersion once per new version, oldest first", async () => {
    const stored = await ingestTwo();
    expect(await invoke(at("03:39"))).toEqual({ outcome: "rules_processed" });
    expect(await invoke(at("04:39"))).toEqual({ outcome: "rules_processed" });
    await invoke(at("05:39"));
    await invoke(at("06:39"));
    expect(rules.processPostVersion.mock.calls.map(([, input, now]) => [input, now])).toEqual([
      [{ monitorId: "A", feedId: "21", versionId: stored[0]!.version_id }, Date.parse(at("03:39"))],
      [{ monitorId: "A", feedId: "22", versionId: stored[1]!.version_id }, Date.parse(at("04:39"))],
    ]);
    expect(rules.processPostVersion.mock.calls[0]?.[0]).toBe(db);
  });

  it("rules slots :39/:42/:48 take fresh versions before retries; a retried failure applies exactly once (F4)", async () => {
    const stored = await ingestTwo();
    const queued = (status: [string, string], attempts: number) => [
      { version_id: stored[0]!.version_id, stream_id: "A", status: status[0], attempts },
      { version_id: stored[1]!.version_id, stream_id: "A", status: status[1], attempts: 0 },
    ];
    quietStreams();
    rules.processPostVersion.mockRejectedValueOnce(new Error("rules boom"));
    await invoke(at("03:30")); // not a rules slot
    expect(rules.processPostVersion).not.toHaveBeenCalled();
    expect(await rulesQueue(db)).toEqual(queued(["pending", "pending"], 0));
    expect(await invoke(at("03:39"))).toEqual({ outcome: "held", reason: "rules_failed" });
    expect(await rulesQueue(db)).toEqual(queued(["pending", "pending"], 1));
    expect(await invoke(at("03:42"))).toEqual({ outcome: "rules_processed" });
    await invoke(at("03:48")); // retry not due before 03:54 (+15 min backoff)
    expect(processed()).toEqual(["21", "22"]);
    expect(await invoke(at("04:39"))).toEqual({ outcome: "rules_processed" });
    expect(processed()).toEqual(["21", "22", "21"]);
    for (const minute of ["04:42", "04:48", "05:42", "05:48"]) await invoke(at(minute));
    expect(processed()).toEqual(["21", "22", "21"]);
    expect(await rulesQueue(db)).toEqual(queued(["done", "done"], 1));
    expect(await count(db, "forecast_v2_legacy_links")).toBe(0);
    expect(await alerts(db)).toEqual([]);
  });

  it("does not repeat rules for a replayed version and runs them for a changed body found by the edit scan", async () => {
    await ingestTwo();
    await invoke(at("03:39"));
    await invoke(at("04:39"));
    await preferEditScan(db, "A", at("04:40"));
    const edited: Post = { ...older, updated: "2026-10-18T10:00:00" };
    naver
      .page("A", 0, page("A", [newer, older, oldPost]), page("A", [newer, edited, oldPost]))
      .detail(21, detailPayload("A", { ...edited, body: "수정된 본문" }));
    const committed = await boundary(db, "A");
    expect(await invoke(at("05:09"))).toEqual({ outcome: "completed" }); // unchanged edit scan
    expect((await runs(db, "A")).at(-1)).toMatchObject({ kind: "edit", status: "completed" });
    expect(naver.detailCalls()).toEqual(["21", "22"]);
    await preferEditScan(db, "A", at("05:10"));
    expect(await invoke(at("05:15"))).toEqual({ outcome: "completed" }); // edit scan sees the newer updatedDate
    expect((await invoke(at("05:21"))).outcome).toBe("body_stored");
    expect(naver.detailCalls()).toEqual(["21", "22", "21"]);
    expect((await versions(db)).map((v) => [v.feed_id, v.body_text])).toEqual([
      ["21", "body 21"],
      ["22", "body 22"],
      ["21", "수정된 본문"],
    ]);
    expect(await boundary(db, "A")).toEqual(committed);
    expect(await invoke(at("05:39"))).toEqual({ outcome: "rules_processed" });
    await invoke(at("06:39"));
    expect(rules.processPostVersion.mock.calls.map(([, input]) => input.feedId)).toEqual([
      "21",
      "22",
      "21",
    ]);
  });

  it("hold mode ingests but never calls rules or writes rules/notification tables", async () => {
    await ingestTwo("hold");
    for (const minute of ["03:39", "03:45", "03:57", "04:39"]) await invoke(at(minute), "hold");
    expect(await invoke(at("04:57"), "hold")).toEqual({ outcome: "held", reason: "calendar_hold" });
    expect(rules.processPostVersion).not.toHaveBeenCalled();
    expect(rules.rebuildCalendar).not.toHaveBeenCalled();
    expect(rules.dueEFollowUps).not.toHaveBeenCalled();
    for (const table of ruleWrites) expect(await count(db, table), table).toBe(0);
    expect(await versions(db)).toHaveLength(2);
  });

  it.each([undefined, "off", "OFF", "enabled"])(
    "mode %s is disabled and touches nothing",
    async (mode) => {
      const untouchable = new Proxy(
        {},
        {
          get: () => {
            throw new Error("db_touched");
          },
        },
      ) as D1Database;
      const fetcher = vi.fn(naver.fetcher);
      const environment = {
        ...v2Env(mode),
        FORECAST_DB: untouchable,
        USAGE_GUARD_DB: untouchable,
      } as V2Env;
      expect(
        await runV2Invocation(environment, Date.parse(at("03:00")), { fetcher, rules, guard }),
      ).toEqual({ outcome: "disabled" });
      expect(fetcher).not.toHaveBeenCalled();
      expect(guard).not.toHaveBeenCalled();
      expect(rules.processPostVersion).not.toHaveBeenCalled();
    },
  );

  it("on mode without an installed rules port holds before any work", async () => {
    naver.page("A", 0, page("A", [newer, oldPost]));
    expect(await invoke(at("03:00"), "on", false)).toEqual({
      outcome: "held",
      reason: "rules_unavailable",
    });
    expect(naver.calls).toEqual([]);
    expect(await count(db, "forecast_v2_monitor_runs")).toBe(0);
  });

  it("rebuilds the calendar at :57 and runs E at :45 only when follow-ups are due", async () => {
    expect(await invoke(at("03:57"))).toEqual({
      outcome: "calendar",
      snapshotId: "calendar_test",
      changed: true,
    });
    expect(rules.rebuildCalendar).toHaveBeenCalledOnce();
    rules.dueEFollowUps.mockResolvedValue(1);
    naver.page("E", 0, page("E", [{ feedId: 31, created: "2026-10-17T12:00:00" }, oldPost]));
    expect(await invoke(at("03:45"))).toEqual({ outcome: "completed" });
    expect(naver.metadataCalls().map((call) => call.stream)).toEqual(["E"]);
    expect(naver.calls[0]?.url.searchParams.get("boardId")).toBe("48");
  });
});
