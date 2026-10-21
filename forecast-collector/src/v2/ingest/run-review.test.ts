import { describe, expect, it, vi } from "vitest";
import { runV2Invocation } from "./run";
import {
  detailPayload,
  iso,
  liveRow,
  malformedJson,
  metadataRow,
  type Post,
  page,
  pagePayload,
  status,
} from "./test-support/naver";
import {
  at,
  cutoff,
  db,
  failurePost,
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
  resetHarness,
  rules,
  seedVersions,
  useRunHarness,
  v2Env,
} from "./test-support/run-harness";
import {
  alerts,
  boundary,
  budget,
  count,
  hits,
  rulesQueue,
  rulesRetryAt,
  runs,
  seedBoundary,
  seedBudget,
  state,
} from "./test-support/v2-db";

// Plan §7C review-round fixes F4, F7, F9, F14 and the :51/:54 units.
useRunHarness();

describe("T03 six-hour edit scan scheduling", () => {
  it("refresh drift makes a recently completed edit scan immediately due and pending bodies keep priority", async () => {
    await seedBoundary(db, "A", cutoff, []);
    await db
      .prepare("UPDATE forecast_v2_monitor_state SET edit_scan_completed_at=?")
      .bind(at("03:00"))
      .run();
    const edited: Post = { ...failurePost, updated: "2026-10-18T11:30:00" };
    naver
      .page("A", 0, page("A", [failurePost, oldPost]), page("A", [edited, oldPost]))
      .detail(failurePost.feedId, detailPayload("A", edited));
    expect(await invoke(at("03:00"))).toEqual({ outcome: "completed" });
    expect((await state(db, "A")).edit_scan_completed_at).toBe(at("03:00"));
    expect(await invoke(at("03:09"))).toEqual({ outcome: "held", reason: "detail_drift" });
    expect((await state(db, "A")).edit_scan_completed_at).toBeNull();
    expect(await invoke(at("03:15"))).toEqual({ outcome: "completed" });
    expect((await runs(db, "A")).at(-1)).toMatchObject({ kind: "edit", status: "completed" });
    expect((await invoke(at("03:21"))).outcome).toBe("body_stored");
    const before = naver.calls.length;
    expect(await invoke(at("03:27"))).toEqual({ outcome: "idle" });
    expect(naver.calls).toHaveLength(before);
    expect(naver.detailCalls()).toEqual([String(failurePost.feedId), String(failurePost.feedId)]);
  });

  it("honors persisted metadata retry time without another reservation or fetch before it is due", async () => {
    await seedBoundary(db, "B", cutoff, []);
    naver.page("B", 0, status(503), pagePayload([]));
    expect(await invoke(at("03:06"))).toEqual({ outcome: "held", reason: "http_503" });
    expect(await invoke(at("03:07"))).toEqual({ outcome: "held", reason: "retry_backoff" });
    expect(naver.metadataCalls("B")).toHaveLength(1);
    expect(await budget(db, "2026-10-18")).toEqual({ metadata_used: 1, detail_used: 0 });
    expect(await invoke(at("03:09"))).toEqual({ outcome: "completed" });
    expect(naver.metadataCalls("B").map((call) => call.page)).toEqual([0, 0]);
    expect(await budget(db, "2026-10-18")).toEqual({ metadata_used: 2, detail_used: 0 });
  });
});

describe("T03 rules poison isolation (F4)", () => {
  it("caps a poison version at 3 failures with a terminal marker and an ops alert; later versions still run", async () => {
    const stored = await ingestTwo();
    quietStreams();
    rules.processPostVersion.mockImplementation(async (_db, input) => {
      if (input.feedId === "21") throw new Error("poison");
      return { calendarDirty: false, decisionRequests: 0, grants: 0 };
    });
    const outcomes = [];
    // Backoff: attempt 1 at 03:39 → due 03:54; attempt 2 at 04:39 → due 05:39.
    for (const minute of ["03:39", "03:42", "04:39", "05:42"])
      outcomes.push(await invoke(at(minute)));
    const failed = { outcome: "held", reason: "rules_failed" };
    expect(outcomes).toEqual([failed, { outcome: "rules_processed" }, failed, failed]);
    expect(processed()).toEqual(["21", "22", "21", "21"]);
    const queueAfterCap = [
      { version_id: stored[0]!.version_id, stream_id: "A", status: "failed", attempts: 3 },
      { version_id: stored[1]!.version_id, stream_id: "A", status: "done", attempts: 0 },
    ];
    expect(await rulesQueue(db)).toEqual(queueAfterCap);
    // Rules attempts no longer use the legacy-link ledger.
    expect(await count(db, "forecast_v2_legacy_links")).toBe(0);
    expect(await alerts(db)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          environment: "staging",
          error_code: "rules_attempts_exhausted",
          state: "open",
          context: { stream: "A" },
        }),
      ]),
    );

    for (const minute of ["05:48", "06:39", "06:42", "06:48"]) await invoke(at(minute));
    expect(processed()).toHaveLength(4);
    expect(await rulesQueue(db)).toEqual(queueAfterCap);

    const later: Post = { feedId: 23, created: "2026-10-18T09:00:00" };
    naver
      .page("A", 0, page("A", [later, newer, older, oldPost]))
      .detail(23, detailPayload("A", later));
    expect(await invoke(at("07:00"))).toEqual({ outcome: "completed" });
    expect((await invoke(at("07:09"))).outcome).toBe("body_stored");
    expect(await invoke(at("07:39"))).toEqual({ outcome: "rules_processed" });
    expect(processed()).toEqual(["21", "22", "21", "21", "23"]);
  });

  it("a rules completion fenced by a lost lease is reported as a hold, not as processed", async () => {
    await ingestTwo();
    rules.processPostVersion.mockImplementationOnce(async () => {
      await db
        .prepare(
          "UPDATE forecast_v2_monitor_state SET lease_owner='thief',lease_expires_at=? WHERE stream_id='A'",
        )
        .bind(at("23:00"))
        .run();
      return { calendarDirty: false, decisionRequests: 0, grants: 0 };
    });
    expect(await invoke(at("03:39"))).toEqual({ outcome: "held", reason: "lease_lost" });
  });
});

describe("T03 rules retry backoff (next_attempt_at)", () => {
  const minutes = (n: number) => n * 60_000;

  it("holds a first failure for 15 minutes while fresh versions are processed, then retries once due", async () => {
    const stored = await ingestTwo();
    quietStreams();
    rules.processPostVersion.mockRejectedValueOnce(new Error("rules boom"));
    expect(await invoke(at("03:39"))).toEqual({ outcome: "held", reason: "rules_failed" });
    expect(await rulesRetryAt(db, stored[0]!.version_id)).toBe(
      Date.parse(at("03:39")) + minutes(15),
    );
    expect(await invoke(at("03:42"))).toEqual({ outcome: "rules_processed" }); // fresh 22
    await invoke(at("03:48")); // 21 is due at 03:54
    expect(processed()).toEqual(["21", "22"]);

    const later: Post = { feedId: 23, created: "2026-10-18T09:00:00" };
    naver
      .page("A", 0, page("A", [later, newer, older, oldPost]))
      .detail(23, detailPayload("A", later));
    expect(await invoke(at("04:00"))).toEqual({ outcome: "completed" });
    expect((await invoke(at("04:09"))).outcome).toBe("body_stored");
    // 21 is due by now, but the fresh version 23 still goes first.
    expect(await invoke(at("04:39"))).toEqual({ outcome: "rules_processed" });
    expect(await invoke(at("04:42"))).toEqual({ outcome: "rules_processed" });
    for (const minute of ["04:48", "05:39"]) await invoke(at(minute));
    expect(processed()).toEqual(["21", "22", "23", "21"]);
    expect(await rulesQueue(db)).toEqual([
      { version_id: stored[0]!.version_id, stream_id: "A", status: "done", attempts: 1 },
      { version_id: stored[1]!.version_id, stream_id: "A", status: "done", attempts: 0 },
      { version_id: expect.any(String), stream_id: "A", status: "done", attempts: 0 },
    ]);
    expect(await alerts(db)).toEqual([]);
  });

  it("holds a second failure for 60 minutes, then retries once due", async () => {
    const stored = await ingestTwo();
    quietStreams();
    let failures = 0;
    rules.processPostVersion.mockImplementation(async (_db, input) => {
      if (input.feedId === "21" && failures < 2) {
        failures += 1;
        throw new Error("rules boom");
      }
      return { calendarDirty: false, decisionRequests: 0, grants: 0 };
    });
    const poison = stored[0]!.version_id;
    expect(await invoke(at("03:39"))).toEqual({ outcome: "held", reason: "rules_failed" });
    expect(await invoke(at("03:42"))).toEqual({ outcome: "rules_processed" });
    expect(await invoke(at("04:39"))).toEqual({ outcome: "held", reason: "rules_failed" });
    expect(await rulesRetryAt(db, poison)).toBe(Date.parse(at("04:39")) + minutes(60));
    for (const minute of ["04:42", "04:48"]) await invoke(at(minute)); // due at 05:39
    expect(processed()).toEqual(["21", "22", "21"]);
    expect((await rulesQueue(db))[0]).toEqual({
      version_id: poison,
      stream_id: "A",
      status: "pending",
      attempts: 2,
    });
    expect(await invoke(at("05:42"))).toEqual({ outcome: "rules_processed" });
    await invoke(at("05:48"));
    expect(processed()).toEqual(["21", "22", "21", "21"]);
    expect((await rulesQueue(db))[0]).toEqual({
      version_id: poison,
      stream_id: "A",
      status: "done",
      attempts: 2,
    });
    expect(await alerts(db)).toEqual([]);
  });
});

describe("T03 candidate (:51) and pending-decision (:54) units", () => {
  it("fail closed without their dependencies: no fetch, no run, no rules", async () => {
    naver.page("A", 0, page("A", [newer, oldPost]));
    expect(await invoke(at("03:51"))).toEqual({ outcome: "held", reason: "candidate_unavailable" });
    // applyPendingDecisions is a required RulesPort member; without the port, :54 holds.
    expect(await invoke(at("03:54"), "on", false)).toEqual({
      outcome: "held",
      reason: "rules_unavailable",
    });
    expect(naver.calls).toEqual([]);
    expect(await count(db, "forecast_v2_monitor_runs")).toBe(0);
    expect(rules.processPostVersion).not.toHaveBeenCalled();
    expect(rules.applyPendingDecisions).not.toHaveBeenCalled();
  });

  it("run their dependency once per slot with the invocation time", async () => {
    const environment = v2Env("on");
    const candidate = vi.fn(async () => ({ sealed: 0 }));
    const deps = { fetcher: naver.fetcher, guard, rules, candidate };
    const t51 = Date.parse(at("03:51"));
    const t54 = Date.parse(at("03:54"));
    vi.setSystemTime(t51);
    expect(await runV2Invocation(environment, t51, deps)).toEqual({
      outcome: "candidate",
      result: { sealed: 0 },
    });
    vi.setSystemTime(t54);
    expect(await runV2Invocation(environment, t54, deps)).toEqual({
      outcome: "decisions",
      result: { applied: 2 },
    });
    expect(candidate).toHaveBeenCalledOnce();
    expect(candidate).toHaveBeenCalledWith(environment, t51);
    expect(rules.applyPendingDecisions).toHaveBeenCalledOnce();
    expect(rules.applyPendingDecisions).toHaveBeenCalledWith(db, t54);
    expect(naver.calls).toEqual([]);
    expect(rules.processPostVersion).not.toHaveBeenCalled();
  });

  it("hold mode never runs the candidate or decision units", async () => {
    quietStreams();
    const candidate = vi.fn(async () => ({ sealed: 0 }));
    for (const minute of ["03:51", "03:54"]) {
      const now = Date.parse(at(minute));
      vi.setSystemTime(now);
      await runV2Invocation(v2Env("hold"), now, {
        fetcher: naver.fetcher,
        guard,
        rules,
        candidate,
      });
    }
    expect(candidate).not.toHaveBeenCalled();
    expect(rules.applyPendingDecisions).not.toHaveBeenCalled();
  });
});

describe("T03 page shapes (F7, F14)", () => {
  const T = "2026-10-17T12:00:00";
  const p11: Post = { feedId: 11, created: kstMinus(T, -60) };
  const p10: Post = { feedId: 10, created: T };

  it("skips non-manager rows of an unsanitized live page: no hold, no body fetch", async () => {
    await seedBoundary(db, "A", iso(T), ["10"]);
    await seedVersions([p10]);
    const memberPost: Post = { feedId: 12, created: kstMinus(T, -120) };
    naver
      .page(
        "A",
        0,
        pagePayload([
          liveRow("A", memberPost, "member"),
          liveRow("A", p11),
          liveRow("A", p10),
          liveRow("A", { feedId: 9, created: kstMinus(T, 60) }, "member"),
        ]),
      )
      .detail(11, detailPayload("A", p11));
    expect(await invoke(at("03:00"))).toEqual({ outcome: "completed" });
    expect(await hits(db)).toEqual(["11", "10"]);
    expect(await boundary(db, "A")).toEqual({ createdAt: iso(p11.created), feedIds: ["11"] });
    expect((await invoke(at("03:09"))).outcome).toBe("body_stored");
    expect(await invoke(at("03:15"))).not.toMatchObject({ outcome: "body_stored" });
    expect(naver.detailCalls()).toEqual(["11"]);
    expect((await state(db, "A")).consecutive_holds).toBe(0);
  });

  it("a full page that contains skipped rows is not mistaken for the last page", async () => {
    const managers = posts(28);
    await seedVersions(managers);
    const member = (feedId: number, created: string) =>
      metadataRow("A", { feedId, created }, { userRoleCode: "member" });
    const rows = [
      ...managers.slice(0, 14).map((post) => metadataRow("A", post)),
      member(7001, managers[13]!.created),
      member(7000, managers[14]!.created),
      ...managers.slice(14).map((post) => metadataRow("A", post)),
    ];
    naver.page("A", 0, pagePayload(rows)).page("A", 1, page("A", [oldPost]));
    expect(await invoke(at("03:00"))).toEqual({ outcome: "running" });
    expect(await invoke(at("03:09"))).toEqual({ outcome: "completed" });
    expect(naver.metadataCalls("A").map((call) => call.page)).toEqual([0, 1]);
    expect(await hits(db)).toHaveLength(28);
  });

  it.each([
    ["A", 30],
    ["G", 10],
  ] as const)(
    "%s: an empty page after an exact multiple of %i rows completes the scan",
    async (stream, size) => {
      const list = posts(size);
      await seedVersions(list, stream === "G" ? 48 : 11);
      naver.page(stream, 0, page(stream, list)).page(stream, 1, pagePayload([]));
      const slot = stream === "G" ? "03" : "00";
      expect(await invoke(at(`03:${slot}`))).toEqual({ outcome: "running" });
      expect(await invoke(at("03:09"))).toEqual({ outcome: "completed" });
      expect(await boundary(db, stream)).toEqual({
        createdAt: iso(list[0]!.created),
        feedIds: [String(list[0]!.feedId)],
      });
      expect((await state(db, stream)).consecutive_holds).toBe(0);
    },
  );

  it("an empty first page completes and keeps the bootstrap boundary", async () => {
    naver.page("A", 0, pagePayload([]));
    expect(await invoke(at("03:00"))).toEqual({ outcome: "completed" });
    expect(await boundary(db, "A")).toEqual({ createdAt: cutoff, feedIds: [] });
    expect(await alerts(db)).toEqual([]);
  });
});

describe("T15 stale coverage alerts via forecast_ops_alerts (F9)", () => {
  const alertFor = (code: string) => ({
    environment: "staging",
    component: "collector",
    error_code: code,
    state: "open",
    context: { stream: "A" },
  });

  it.each([
    ["on", 1],
    ["hold", 0],
  ] as const)("%s: budget exhaustion raises %i alert", async (mode, n) => {
    await seedBudget(db, "2026-10-18", { metadata: 240 });
    expect(await invoke(at("03:00"), mode)).toEqual({
      outcome: "held",
      reason: "budget_exhausted",
    });
    const raised = await alerts(db);
    expect(raised).toHaveLength(n);
    if (n)
      expect(raised[0]).toEqual({
        environment: "staging",
        component: "collector",
        error_code: "budget_exhausted",
        state: "open",
        context: {
          gameDay: "2026-10-18",
          kind: "metadata",
          used: 240,
          limit: 240,
          resetAt: "2026-10-18T20:00:00.000Z",
          affectedStreams: "A",
        },
      });
  });

  it.each([
    ["on", 1],
    ["hold", 0],
  ] as const)(
    "%s: the third consecutive hold of a stream raises %i alert (A6)",
    async (mode, n) => {
      naver.page("A", 0, status(500));
      for (const minute of ["03:00", "04:00"])
        expect(await invoke(at(minute), mode)).toEqual({ outcome: "held", reason: "http_500" });
      expect(await alerts(db)).toEqual([]);
      expect(await invoke(at("05:00"), mode)).toEqual({ outcome: "held", reason: "http_500" });
      expect((await state(db, "A")).consecutive_holds).toBe(3);
      expect(await alerts(db)).toEqual(n ? [alertFor("http_500")] : []);
    },
  );

  it("a body that exhausts its attempts raises an alert in on mode only", async () => {
    for (const mode of ["hold", "on"]) {
      await resetHarness();
      naver
        .page("A", 0, page("A", [failurePost, oldPost]))
        .detail(failurePost.feedId, malformedJson());
      await invoke(at("03:00"), mode);
      for (const minute of ["03:09", "03:15"]) await invoke(at(minute), mode);
      expect(await invoke(at("03:21"), mode)).toEqual({
        outcome: "held",
        reason: "attempts_exhausted",
      });
      const raised = await alerts(db);
      expect(
        raised.map((row) => row.error_code),
        mode,
      ).toEqual(mode === "on" ? ["attempts_exhausted"] : []);
    }
  });
});
