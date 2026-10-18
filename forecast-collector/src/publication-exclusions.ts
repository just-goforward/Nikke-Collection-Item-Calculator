import type { SupplyForecastGrant } from "../../shared/supplyForecastCandidate";
import { sha256Hex, stableJson } from "./crypto";
import type { Judgment } from "./solo-contracts";
import type { NormalizedSourceItem, ScheduleEvent } from "./types";

export type Exclusion = {
  rule: "irrelevant_museum" | "modeled_past_reopen" | "grant_outside_horizon";
  contextHash: string;
};
export type ReviewEvidence = {
  item: NormalizedSourceItem;
  judgments: Judgment[];
  publicationBinding?: { reviewId: string; contextHash: string };
  evaluations?: Record<number, Exclusion | null>;
};
type Horizon = { from: string; until: string };
const RULE = "forecast-exclusion-v2";
const instant = (value: string | null) => (value === null ? null : new Date(value).toISOString());

async function exclusionContext(
  item: NormalizedSourceItem,
  judgment: Judgment,
  events: readonly ScheduleEvent[],
  horizon: Horizon,
  rule: Exclusion["rule"],
) {
  const overlap = (start: string | null, end: string | null) =>
    start &&
    end &&
    Date.parse(start) < Date.parse(horizon.until) &&
    Date.parse(end) >= Date.parse(horizon.from);
  return sha256Hex(
    stableJson({
      ruleVersion: RULE,
      rule,
      dependencies:
        rule === "irrelevant_museum"
          ? {
              source: item.source,
              itemId: item.itemId,
              section: judgment.blockExcerpt,
            }
          : rule === "grant_outside_horizon"
            ? {
                outside: true,
                source: item.source,
                itemId: item.itemId,
                blockIndex: judgment.blockIndex,
                grant: judgment.comparison.grant,
              }
            : {
                events: events
                  .filter(
                    (event) =>
                      rule === "modeled_past_reopen" &&
                      !event.manualReview &&
                      event.segment?.kind === "reopen" &&
                      event.startsAt === judgment.comparison.extracted?.startsAt &&
                      event.endsAt === judgment.comparison.extracted?.endsAt,
                  )
                  .map((event) => ({
                    overlap: Boolean(overlap(event.startsAt, event.endsAt)),
                    id: event.eventId,
                    type: event.eventType,
                    from: instant(event.startsAt),
                    until: instant(event.endsAt),
                    status: event.scheduleStatus,
                    manual: event.manualReview,
                    kind: event.segment?.kind,
                  }))
                  .sort((a, b) => a.id.localeCompare(b.id)),
              },
    }),
  );
}
async function typedExclusion(
  item: NormalizedSourceItem,
  judgment: Judgment,
  events: readonly ScheduleEvent[],
  horizon: Horizon,
): Promise<Exclusion | null> {
  let rule: Exclusion["rule"] | null = null;
  const grant = judgment.comparison.grant;
  if (grant?.grantGameDate) {
    const at = Date.parse(`${grant.grantGameDate}T05:00:00+09:00`);
    if (at < Date.parse(horizon.from) || at >= Date.parse(horizon.until))
      rule = "grant_outside_horizon";
    else return null;
  } else if (
    judgment.reason === "reopen_without_suspension" &&
    judgment.comparison.extracted?.startsAt &&
    judgment.comparison.extracted.endsAt &&
    Date.parse(judgment.comparison.extracted.endsAt) < Date.parse(horizon.from) &&
    events.some(
      (event) =>
        !event.manualReview &&
        event.segment?.kind === "reopen" &&
        event.startsAt === judgment.comparison.extracted?.startsAt &&
        event.endsAt === judgment.comparison.extracted?.endsAt,
    )
  )
    rule = "modeled_past_reopen";
  else if (
    (judgment.verdict === "ignored" || judgment.reason === "ambiguous_schedule_change") &&
    judgment.blockExcerpt.length < 1200 &&
    /^(?:\d+\.\s*)?(?:솔로\s*레이드\s+)?(?:박물관|아카이브)(?:\s|$)/.test(judgment.blockExcerpt) &&
    !/관리\s*키트\s*상자|중단|재오픈|재개|진행\s*기간/.test(judgment.blockExcerpt)
  )
    rule = "irrelevant_museum";
  if (!rule) return null;
  return { rule, contextHash: await exclusionContext(item, judgment, events, horizon, rule) };
}

export async function reviewExcluded(
  review: ReviewEvidence,
  events: readonly ScheduleEvent[],
  _grants: readonly SupplyForecastGrant[],
  horizon: Horizon,
  allowNew: boolean,
) {
  if (!review.judgments.length) return false;
  let excluded = true;
  for (const judgment of review.judgments) {
    if (judgment.verdict !== "manual_review" && judgment.comparison.blocking !== true) continue;
    const fresh = await typedExclusion(review.item, judgment, events, horizon);
    const stored = judgment.comparison.exclusion;
    const evaluated = Object.hasOwn(review.evaluations ?? {}, judgment.blockIndex);
    const prior = review.evaluations?.[judgment.blockIndex];
    const accepted = (!evaluated || prior !== null) && exclusionMatches(fresh, stored, allowNew);
    if (review.publicationBinding && !evaluated) {
      review.evaluations ??= {};
      review.evaluations[judgment.blockIndex] = accepted ? fresh : null;
    }
    if (!accepted || !fresh) {
      excluded = false;
      continue;
    }
    judgment.comparison.exclusion = fresh;
    judgment.comparison.blocking = false;
  }
  return excluded;
}

function exclusionMatches(
  fresh: Exclusion | null,
  stored: Exclusion | undefined,
  allowNew: boolean,
) {
  return Boolean(
    fresh &&
      (stored || allowNew) &&
      (!stored || (stored.rule === fresh.rule && stored.contextHash === fresh.contextHash)),
  );
}

export async function persistedReviewEvidence(
  db: D1Database,
  source: string,
  itemId: string,
): Promise<ReviewEvidence | null> {
  const revision = await db
    .prepare(`SELECT item_json,body_hash FROM source_notice_revisions
    WHERE source=? AND item_id=? ORDER BY source_revision DESC LIMIT 1`)
    .bind(source, itemId)
    .first<{ item_json: string; body_hash: string }>();
  if (!revision) return null;
  const rows = await db
    .prepare(`SELECT e.*,b.review_id FROM source_judgment_evidence e
    JOIN source_manual_reviews m ON m.source=e.source AND m.item_id=e.item_id AND m.state='pending'
    JOIN source_queue q ON q.source=m.source AND q.item_id=m.item_id AND q.review_generation=m.generation
    JOIN source_manual_review_bindings b ON b.review_id=m.review_id AND b.generation=m.generation
    WHERE e.source=? AND e.item_id=? AND e.content_hash=? AND e.rule_version='solo-section-v2'
      AND b.body_hash=e.content_hash AND e.context_hash=json_extract(b.metadata_json,'$.contextHash')`)
    .bind(source, itemId, revision.body_hash)
    .all<{
      block_index: number;
      verdict: Judgment["verdict"];
      reason: string | null;
      question: string;
      triggers_json: string;
      block_excerpt: string;
      comparison_json: string;
      review_id: string;
      context_hash: string;
    }>();
  const stored = await db
    .prepare(`SELECT block_index,exclusion_json FROM publication_review_exclusions
    WHERE review_id=? AND context_hash=?`)
    .bind(rows.results[0]?.review_id ?? "", rows.results[0]?.context_hash ?? "")
    .all<{ block_index: number; exclusion_json: string }>();
  return {
    item: JSON.parse(revision.item_json) as NormalizedSourceItem,
    evaluations: Object.fromEntries(
      stored.results.map((row) => [row.block_index, JSON.parse(row.exclusion_json)]),
    ),
    ...(rows.results[0]
      ? {
          publicationBinding: {
            reviewId: rows.results[0].review_id,
            contextHash: rows.results[0].context_hash,
          },
        }
      : {}),
    judgments: rows.results.map((row) => ({
      blockIndex: row.block_index,
      verdict: row.verdict,
      reason: row.reason,
      question: row.question,
      triggers: JSON.parse(row.triggers_json) as string[],
      blockExcerpt: row.block_excerpt,
      maintenanceInputs: [],
      comparison: {
        ...JSON.parse(row.comparison_json),
        ...Object.fromEntries(
          stored.results
            .filter((entry) => entry.block_index === row.block_index)
            .map((entry) => ["exclusion", JSON.parse(entry.exclusion_json)]),
        ),
      } as Judgment["comparison"],
    })),
  };
}

export function publicationExclusionStatements(db: D1Database, reviews: ReviewEvidence[]) {
  const statements: D1PreparedStatement[] = [];
  for (const review of reviews) {
    const binding = review.publicationBinding;
    if (!binding) continue;
    for (const judgment of review.judgments) {
      if (!Object.hasOwn(review.evaluations ?? {}, judgment.blockIndex)) continue;
      statements.push(
        db
          .prepare(`INSERT INTO publication_review_exclusions
      SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM publication_review_exclusions
      WHERE review_id=? AND context_hash=? AND block_index=?)`)
          .bind(
            binding.reviewId,
            binding.contextHash,
            judgment.blockIndex,
            JSON.stringify(review.evaluations?.[judgment.blockIndex]),
            binding.reviewId,
            binding.contextHash,
            judgment.blockIndex,
          ),
      );
    }
  }
  return statements;
}
