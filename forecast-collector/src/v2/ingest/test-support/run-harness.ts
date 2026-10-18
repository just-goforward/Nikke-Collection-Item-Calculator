import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { executeTestSql } from "../../../../../shared/testD1Sql";
import schemaSql from "../../../test-schema";
import type { RulesPort } from "../rules-port";
import { runV2Invocation, type V2Env } from "../run";
import type { Stream } from "../schedule";
import { collectorTestEnv } from "./env";
import { detailPayload, FakeNaver, iso, type Post, page, pagePayload } from "./naver";
import { seedVersion, versions } from "./v2-db";

// Shared workerd harness for the runV2Invocation behaviour tests. Call
// useRunHarness() once per test file; state is reset before every test.
export const db = env.FORECAST_DB;
export const cutoff = "2026-10-15T00:00:00.000Z"; // 2026-10-15 09:00 KST
export const at = (hhmm: string, day = "2026-10-18") => `${day}T${hhmm}:00.000Z`;
export const kstMinus = (kst: string, minutes: number) =>
  new Date(Date.parse(`${kst}+09:00`) - minutes * 60_000 + 9 * 3_600_000)
    .toISOString()
    .slice(0, 19);
/** n posts newer than the cutoff, newest first, one minute apart. */
export const posts = (n: number, top = 5000, newest = "2026-10-18T11:00:00"): Post[] =>
  Array.from({ length: n }, (_, i) => ({ feedId: top - i, created: kstMinus(newest, i) }));
export const oldPost: Post = { feedId: 1, created: "2026-09-01T12:00:00" };

function rulesPort() {
  return {
    processPostVersion: vi.fn<RulesPort["processPostVersion"]>(async () => ({
      calendarDirty: false,
      decisionRequests: 0,
      grants: 0,
    })),
    rebuildCalendar: vi.fn<RulesPort["rebuildCalendar"]>(async () => ({
      snapshotId: "calendar_test",
      changed: true,
    })),
    dueEFollowUps: vi.fn<RulesPort["dueEFollowUps"]>(async () => 0),
    applyPendingDecisions: vi.fn<RulesPort["applyPendingDecisions"]>(async () => ({
      applied: 2,
    })),
  };
}
export const v2Env = (mode: string | undefined): V2Env =>
  ({
    ...collectorTestEnv,
    ENVIRONMENT: "staging",
    FORECAST_V2_BOOTSTRAP_CUTOFF: cutoff,
    ...(mode === undefined ? {} : { FORECAST_V2_MODE: mode }),
  }) as V2Env;

export let naver: FakeNaver;
export let rules: ReturnType<typeof rulesPort>;
export let guard: ReturnType<typeof vi.fn<() => Promise<void>>>;

/** Fresh schema and fakes; also usable inside a test to start over. */
export async function resetHarness() {
  await reset();
  await executeTestSql(db, schemaSql, applyD1Migrations);
  naver = new FakeNaver();
  rules = rulesPort();
  guard = vi.fn(async () => {});
}
export function useRunHarness() {
  beforeEach(async () => {
    await resetHarness();
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
}

export async function invoke(instant: string, mode: string | undefined = "on", withRules = true) {
  const now = Date.parse(instant);
  vi.setSystemTime(now);
  return runV2Invocation(v2Env(mode), now, {
    fetcher: naver.fetcher,
    guard,
    ...(withRules ? { rules } : {}),
  });
}
export async function seedVersions(list: Post[], board = 11) {
  for (const post of list)
    await seedVersion(
      db,
      String(post.feedId),
      iso(post.created),
      iso(post.updated ?? post.created),
      board,
    );
}

export const failureT = "2026-10-17T12:00:00";
export const failurePost: Post = { feedId: 11, created: kstMinus(failureT, -60) };
export const disposition = async (feedId: number) =>
  (
    await db
      .prepare(`SELECT DISTINCT json_extract(metadata_json,'$.bodyDisposition') AS d FROM forecast_v2_search_hits
      WHERE feed_id=?`)
      .bind(String(feedId))
      .all<{ d: string | null }>()
  ).results.map((r) => r.d);

export const older: Post = { feedId: 21, created: "2026-10-16T12:00:00" };
export const newer: Post = { feedId: 22, created: "2026-10-17T12:00:00" };
/** Scan A and store bodies of `older` and `newer` (03:00, 03:09, 03:15). */
export async function ingestTwo(mode = "on") {
  naver
    .page("A", 0, page("A", [newer, older, oldPost]))
    .detail(21, detailPayload("A", older))
    .detail(22, detailPayload("A", newer));
  await invoke(at("03:00"), mode);
  await invoke(at("03:09"), mode);
  await invoke(at("03:15"), mode);
  const stored = await versions(db);
  expect(stored.map((v) => v.feed_id)).toEqual(["21", "22"]);
  return stored;
}
/** Empty result pages for every stream but `except`, so slots that fall through to ingestion stay benign. */
export function quietStreams(except: Stream = "A") {
  for (const stream of ["A", "B", "C-open", "C-reopen", "D", "E", "F", "G"] as const)
    if (stream !== except) naver.page(stream, 0, pagePayload([]));
}
export const processed = () => rules.processPostVersion.mock.calls.map(([, input]) => input.feedId);
