import type { PublicCell, PublicStatistics, SelfPercentile, StageSummary } from "./contracts";
import type { PersonalEnv } from "./types";

const K = 10;
const BIN_WIDTH = 100;
const CLAMP_MAX = 1_000;
const POLICY = "post-signup-income-v1-k10-client-flags";

interface Point {
  userId: string; stage: string; income: number; manual: boolean; verified: boolean;
}
interface Fence { generation: number; intent_version: number }
interface Hooks {
  afterSnapshot?: () => Promise<void>;
  afterPrepare?: () => Promise<void>;
  afterSelfRanks?: () => Promise<void>;
}

export function weekStart(now: number): string {
  const date = new Date(now);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function cohort(point: Point): string {
  return `${point.manual ? "manual" : "nonmanual"}_${point.verified ? "self_reported_verified" : "unverified"}`;
}
function bin(income: number): number {
  return Math.min(CLAMP_MAX / BIN_WIDTH - 1, Math.floor(Math.min(income, CLAMP_MAX) / BIN_WIDTH));
}

function points(rows: Record<string, unknown>[]): Point[] {
  const result = new Map<string, Point>();
  for (const row of rows) {
    const summary = JSON.parse(String(row["summary"])) as StageSummary;
    if (summary.itemId !== row["item_id"] || summary.stage !== row["stage"]
      || typeof summary.manualEntry !== "boolean" || typeof summary.verified !== "boolean"
      || typeof summary.lifetimeIncome !== "number" || !Number.isFinite(summary.lifetimeIncome)
      || typeof summary.preSignupIncome !== "number" || !Number.isFinite(summary.preSignupIncome)
      || summary.preSignupIncome < 0 || summary.lifetimeIncome < summary.preSignupIncome) {
      throw new Error("invalid_summary");
    }
    const userId = String(row["user_id"]);
    const key = JSON.stringify([userId, summary.stage]);
    const previous = result.get(key);
    const income = (previous?.income ?? 0) + summary.lifetimeIncome - summary.preSignupIncome;
    if (!Number.isFinite(income)) throw new Error("invalid_summary");
    result.set(key, {
      userId, stage: summary.stage, income,
      manual: (previous?.manual ?? false) || summary.manualEntry,
      verified: (previous?.verified ?? true) && summary.verified,
    });
  }
  return [...result.values()];
}

function cells(all: Point[], participants: Set<string>): PublicCell[] {
  const grouped = new Map<string, Point[]>();
  for (const point of all) {
    if (!participants.has(point.userId)) continue;
    const key = JSON.stringify([point.stage, cohort(point)]);
    const group = grouped.get(key) ?? [];
    group.push(point);
    grouped.set(key, group);
  }
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => {
    const [stage, label] = JSON.parse(key) as [string, string];
    const counts = Array.from({ length: CLAMP_MAX / BIN_WIDTH }, () => 0);
    for (const point of group) counts[bin(point.income)] = (counts[bin(point.income)] ?? 0) + 1;
    const disclosed = counts.map((count) => Math.floor(count / K) * K);
    const suppressed = group.length < K || disclosed.every((count) => count === 0);
    return {
      stage, cohort: label, suppressed,
      bands: suppressed ? [] : disclosed.map((count, index) => ({
        lower: index * BIN_WIDTH, upper: (index + 1) * BIN_WIDTH, count,
      })),
    };
  });
}

/** Local hooks model interleavings/crash boundaries; no HTTP route exposes them. */
export async function publishWeekly(
  env: PersonalEnv, now: number, hooks: Hooks = {},
): Promise<"disabled" | "blocked" | "unchanged" | "published"> {
  if (env.PUBLICATION_ENABLED !== "true") return "disabled";
  const week = weekStart(now);
  const current = await env.PUBLIC_AGGREGATE_DB.prepare(
    `SELECT r.week_start FROM privacy_fence f JOIN current_release p ON p.singleton = f.singleton
     JOIN weekly_releases r ON r.release_id = p.release_id
     WHERE f.blocked = 0 AND f.pending_intents = 0 AND r.state = 'published'
     AND r.fence_generation = f.generation AND p.fence_generation = f.generation`,
  ).first<{ week_start: string }>();
  if (current?.week_start === week) return "unchanged";
  const id = crypto.randomUUID();
  const fence = await env.PUBLIC_AGGREGATE_DB.prepare(
    `UPDATE privacy_fence SET publisher_token = ?, blocked = 1
     WHERE singleton = 1 AND publisher_token IS NULL AND pending_intents = 0
     RETURNING generation, intent_version`,
  ).bind(id).first<Fence>();
  if (!fence) return "blocked";
  // Unknown errors intentionally retain the publisher token/block, including process death.
  const privacy = await env.PRIVACY_CONTROL_DB.batch([
    env.PRIVACY_CONTROL_DB.prepare(
      `SELECT c.user_id FROM consent_decisions c WHERE c.participation = 1
       AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.user_id = c.user_id AND t.kind = 'deletion')`,
    ),
    env.PRIVACY_CONTROL_DB.prepare(
      `SELECT (SELECT count(*) FROM consent_reservations)
       + (SELECT count(*) FROM privacy_operations WHERE state = 'pending') AS n`,
    ),
  ]);
  const personal = await env.PERSONAL_DB.batch([
    env.PERSONAL_DB.prepare(
      `SELECT s.user_id, s.item_id, s.stage, s.summary FROM stage_summaries s JOIN accounts a USING(user_id)
       WHERE a.blocked = 0 ORDER BY s.user_id, s.item_id, s.stage`,
    ),
    env.PERSONAL_DB.prepare("SELECT count(*) AS n FROM deletion_jobs"),
  ]);
  async function abort(): Promise<"blocked"> {
    // Only unpublished projections of this attempt are removed.
    await env.PERSONAL_DB.prepare("DELETE FROM self_percentiles WHERE release_id = ?").bind(id).run();
    await env.PUBLIC_AGGREGATE_DB.batch([
      env.PUBLIC_AGGREGATE_DB.prepare("DELETE FROM weekly_releases WHERE release_id = ? AND state = 'staged'").bind(id),
      env.PUBLIC_AGGREGATE_DB.prepare(
        "UPDATE privacy_fence SET publisher_token = NULL WHERE publisher_token = ?",
      ).bind(id),
    ]);
    return "blocked";
  }
  if (Number(privacy[1]?.results[0]?.["n"]) || Number(personal[1]?.results[0]?.["n"])) return abort();
  const all = points(personal[0]?.results ?? []);
  const participants = new Set((privacy[0]?.results ?? []).map((row) => String(row["user_id"])));
  const publicCells = cells(all, participants);
  const release: PublicStatistics = {
    releaseId: id, weekStart: week, fenceGeneration: fence.generation, cells: publicCells,
    policy: { k: K, metric: "post_signup_income", binWidth: BIN_WIDTH, clampMax: CLAMP_MAX, countQuantum: K },
  };
  await hooks.afterSnapshot?.();
  const prepared = await env.PUBLIC_AGGREGATE_DB.prepare(
    `INSERT INTO weekly_releases
     (release_id, week_start, fence_generation, payload, published_at, state, intent_version)
     SELECT ?, ?, ?, ?, ?, 'staged', ? FROM privacy_fence
     WHERE singleton = 1 AND publisher_token = ? AND pending_intents = 0
     AND generation = ? AND intent_version = ?`,
  ).bind(id, week, fence.generation, JSON.stringify(release), now, fence.intent_version,
    id, fence.generation, fence.intent_version).run();
  if (prepared.meta.changes !== 1) return abort();
  await hooks.afterPrepare?.();
  const ranks = all.map((point): SelfPercentile & { userId: string } => {
    const cell = publicCells.find((value) => value.stage === point.stage && value.cohort === cohort(point));
    const total = cell?.bands.reduce((sum, value) => sum + value.count, 0) ?? 0;
    const index = bin(point.income);
    const below = cell?.bands.slice(0, index).reduce((sum, value) => sum + value.count, 0) ?? 0;
    return {
      userId: point.userId, releaseId: id, stage: point.stage,
      percentileBand: total ? {
        lower: Math.floor(100 * below / total),
        upper: Math.ceil(100 * (below + (cell?.bands[index]?.count ?? 0)) / total),
      } : null,
      manualEntry: point.manual, verified: point.verified,
    };
  });
  const rankRows = ranks.map(({ userId, ...payload }) => ({ userId, stage: payload.stage, payload: JSON.stringify(payload) }));
  await env.PERSONAL_DB.prepare(
    `INSERT INTO self_percentiles (user_id, release_id, stage, payload)
     SELECT json_extract(j.value, '$.userId'), ?, json_extract(j.value, '$.stage'),
     json_extract(j.value, '$.payload') FROM json_each(?) j JOIN accounts a
     ON a.user_id = json_extract(j.value, '$.userId') WHERE a.blocked = 0`,
  ).bind(id, JSON.stringify(rankRows)).run();
  await hooks.afterSelfRanks?.();
  const activated = await env.PUBLIC_AGGREGATE_DB.batch([
    env.PUBLIC_AGGREGATE_DB.prepare(
      `UPDATE privacy_fence SET blocked = 0, activated_token = ?
       WHERE singleton = 1 AND publisher_token = ? AND pending_intents = 0
       AND generation = ? AND intent_version = ?
       AND EXISTS (SELECT 1 FROM weekly_releases WHERE release_id = ? AND state = 'staged')`,
    ).bind(id, id, fence.generation, fence.intent_version, id),
    env.PUBLIC_AGGREGATE_DB.prepare(
      `UPDATE weekly_releases SET state = 'published' WHERE release_id = ?
       AND EXISTS (SELECT 1 FROM privacy_fence WHERE activated_token = ? AND blocked = 0 AND pending_intents = 0)`,
    ).bind(id, id),
    env.PUBLIC_AGGREGATE_DB.prepare(
      `UPDATE current_release SET release_id = ?, fence_generation = ?
       WHERE singleton = 1 AND EXISTS
       (SELECT 1 FROM privacy_fence WHERE activated_token = ? AND blocked = 0 AND pending_intents = 0)`,
    ).bind(id, fence.generation, id),
    env.PUBLIC_AGGREGATE_DB.prepare(
      `INSERT INTO disclosure_history
       (release_id, week_start, fence_generation, disclosure_policy_version, published_at)
       SELECT ?, ?, ?, ?, ? FROM privacy_fence
       WHERE singleton = 1 AND activated_token = ? AND blocked = 0 AND pending_intents = 0`,
    ).bind(id, week, fence.generation, POLICY, now, id),
    env.PUBLIC_AGGREGATE_DB.prepare(
      "UPDATE privacy_fence SET publisher_token = NULL WHERE publisher_token = ? AND activated_token = ? AND blocked = 0",
    ).bind(id, id),
  ]);
  if (activated[0]?.meta.changes !== 1) return abort();
  return "published";
}
