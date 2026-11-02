import { gameDayStartMs } from "../../shared/gameDay";
import type { SupplyForecastGrant } from "../../shared/supplyForecastCandidate";
import { board11InvocationGate } from "./board11-policy";
import { stableJson } from "./crypto";
import type { StatementWriteCondition } from "./db";
import type { Judgment } from "./solo-contracts";
import { noticeTexts } from "./solo-sections";
import type { NormalizedSourceItem } from "./types";

export type KitCount = { law: "box-ii-v1" | "regular-box-v1"; count: number };
function normalizeKits(kits: readonly KitCount[]) {
  const totals = new Map<KitCount["law"], number>();
  for (const kit of kits) {
    const total = (totals.get(kit.law) ?? 0) + kit.count;
    if (!Number.isSafeInteger(total) || total <= 0) throw new Error("grant_quantity_invalid");
    totals.set(kit.law, total);
  }
  return [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([law, count]) => ({ law, count }));
}
export type GrantBlock = {
  grantGameDate: string | null;
  kits: KitCount[];
  claimUntilKst: string | null;
  claimWindowAssumed: boolean;
  explicitDate: boolean;
  dateAmbiguous?: boolean;
  restatement: boolean;
  evidence: string;
};
export type GrantPlan = {
  grants: SupplyForecastGrant[];
  statements: D1PreparedStatement[];
  judgments: Judgment[];
};
const datePattern = String.raw`(?:(\d{4})년\s*)?(\d{1,2})[월/]\s*(\d{1,2})일?(?:\([^)]*\))?`;

function dateValue(match: RegExpMatchArray, published: string) {
  const year = Number(match[1] ?? new Date(Date.parse(published) + 9 * 3600000).getUTCFullYear());
  const month = Number(match[2]),
    day = Number(match[3]);
  const stamp = new Date(Date.UTC(year, month - 1, day));
  if (
    stamp.getUTCFullYear() !== year ||
    stamp.getUTCMonth() !== month - 1 ||
    stamp.getUTCDate() !== day
  )
    return null;
  const date = stamp.toISOString().slice(0, 10);
  const publishedGameDate = new Date(gameDayStartMs(Date.parse(published)) + 9 * 3600000)
    .toISOString()
    .slice(0, 10);
  return !match[1] && date < publishedGameDate ? "ambiguous" : date;
}

export function parseGrantBlocks(item: NormalizedSourceItem): GrantBlock[] {
  const text = noticeTexts.get(item)?.effective ?? item.normalizedText;
  return text.split(/(?=^[^\n]*보상\s*안내[^\n]*$)/m).flatMap((block) => {
    if (!/보상|기념|축하/.test(block)) return [];
    const kits = parseKits(block);
    if (!kits.size) return [];
    const dates = [
      ...block.matchAll(new RegExp(String.raw`지급일\s*[:：-]?\s*-?\s*${datePattern}`, "g")),
      ...block.matchAll(new RegExp(String.raw`${datePattern}\s*(?:에\s*)?지급`, "g")),
    ].map((match) => dateValue(match, item.publishedAt));
    const explicitDate = dates.length > 0;
    if (!dates.length && /오늘(?:\s*중)?\s*지급/.test(block))
      dates.push(new Date(Date.parse(item.publishedAt) + 9 * 3600000).toISOString().slice(0, 10));
    const distinct = new Set(dates);
    const deadline = block.match(
      new RegExp(
        String.raw`수령\s*기한\s*[:：-]?\s*${datePattern}\s*(\d{1,2}):(\d{2})(?::(\d{2}))?`,
      ),
    );
    const deadlineDate = deadline && dateValue(deadline, item.publishedAt);
    const dateAmbiguous = dates.includes("ambiguous") || deadlineDate === "ambiguous";
    return [
      {
        grantGameDate: !dateAmbiguous && distinct.size === 1 ? (dates[0] ?? null) : null,
        kits: [...kits]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([law, count]) => ({ law, count })),
        claimUntilKst: claimDeadline(deadlineDate === "ambiguous" ? null : deadlineDate, deadline),
        claimWindowAssumed: !/수령\s*기한/.test(block),
        explicitDate,
        dateAmbiguous,
        restatement:
          new RegExp(String.raw`${datePattern}\s*지급\s*보상\s*안내`).test(block) ||
          /이전\s*공지에서\s*약속드린\s*보상/.test(block),
        evidence: block.slice(0, 1200),
      },
    ];
  });
}

function parseKits(block: string) {
  const kits = new Map<KitCount["law"], number>();
  for (const match of block.matchAll(
    /관리\s*키트\s*상자\s*(II|Ⅱ)?\s*(?:[*×xX:]|\s)\s*(\d[\d,]*)/g,
  )) {
    const count = Number(match[2]?.replaceAll(",", ""));
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error("grant_quantity_invalid");
    const law = match[1] ? "box-ii-v1" : "regular-box-v1";
    kits.set(law, (kits.get(law) ?? 0) + count);
  }
  return kits;
}

function claimDeadline(deadlineDate: string | null, deadline: RegExpMatchArray | null) {
  return deadlineDate &&
    deadline &&
    Number(deadline[4]) < 24 &&
    Number(deadline[5]) < 60 &&
    Number(deadline[6] ?? 0) < 60
    ? `${deadlineDate}T${deadline[4]?.padStart(2, "0")}:${deadline[5]}:${deadline[6] ?? "00"}+09:00`
    : null;
}

export function grantRefs(kits: readonly KitCount[]) {
  return kits.flatMap(({ law, count }) => {
    const refs: { lawId: string; count: number }[] = [];
    for (let remaining = count; remaining > 0; remaining -= 64)
      refs.push({ lawId: law, count: Math.min(64, remaining) });
    return refs;
  });
}
type GrantRow = {
  grant_id: string;
  source: string;
  origin_item_id: string;
  grant_game_date: string;
  seq: number;
  kits_json: string;
  claim_until: string | null;
  claim_window_assumed: number;
  content_hash: string;
};
const grantSelect = `SELECT g.*,r.kits_json,r.claim_until,r.claim_window_assumed,r.content_hash
  FROM forecast_grants g JOIN forecast_grant_revisions r ON r.grant_id=g.grant_id
  WHERE r.rowid=(SELECT rowid FROM forecast_grant_revisions WHERE grant_id=g.grant_id
    ORDER BY (content_hash=(SELECT content_hash FROM source_items WHERE source=g.source AND item_id=g.origin_item_id)) DESC,
      observed_at DESC,rowid DESC LIMIT 1)`;
function supplyGrant(row: GrantRow): SupplyForecastGrant {
  return {
    id: row.grant_id,
    grantGameDate: row.grant_game_date,
    refs: grantRefs(JSON.parse(row.kits_json) as KitCount[]),
    ...(row.claim_until ? { claimUntil: row.claim_until } : {}),
    claimWindowAssumed: row.claim_window_assumed === 1,
    sourceIds: [`https://game.naver.com/lounge/nikke/board/detail/${row.origin_item_id}`],
    restatementOf: [],
  };
}
export async function loadGrants(db: D1Database) {
  const rows = await db.prepare(grantSelect).all<GrantRow>();
  return rows.results.map(supplyGrant);
}
function grantTarget(
  block: GrantBlock,
  blocks: GrantBlock[],
  origin: GrantRow[],
  rows: GrantRow[],
  item: NormalizedSourceItem,
  override: GrantBlock[] | undefined,
) {
  let reason: string | null = !block.grantGameDate
    ? "compensation_grant_date_missing"
    : !block.claimWindowAssumed && !block.claimUntilKst
      ? "compensation_claim_deadline_ambiguous"
      : null;
  const sameOrigin = origin.filter((row) => row.grant_game_date === block.grantGameDate);
  const sameBlocks = blocks.filter((entry) => entry.grantGameDate === block.grantGameDate);
  const retry = sameOrigin.filter((row) => row.content_hash === item.contentHash);
  const retryTarget = retry.sort((a, b) => a.seq - b.seq)[sameBlocks.indexOf(block)];
  let target = retryTarget?.kits_json === stableJson(block.kits) ? retryTarget : undefined;
  if (!target && sameOrigin.length) {
    if (sameOrigin.length === 1 && sameBlocks.length === 1) target = sameOrigin[0];
    else reason = "grant_same_date_blocks_changed";
  }
  if (origin.some((row) => !blocks.some((entry) => entry.grantGameDate === row.grant_game_date)))
    reason = "grant_same_date_blocks_changed";
  const nearby = block.grantGameDate
    ? rows.filter(
        (row) =>
          !(row.source === item.source && row.origin_item_id === item.itemId) &&
          Math.abs(Date.parse(row.grant_game_date) - Date.parse(block.grantGameDate as string)) <=
            86400000,
      )
    : [];
  const exact = nearby.filter((row) => row.grant_game_date === block.grantGameDate);
  const restated = restatementTarget(block, override, target, nearby, exact, reason);
  return {
    ...restated,
    ...(block.dateAmbiguous ? { reason: "compensation_grant_date_ambiguous" } : {}),
    sameBlocks,
  };
}

function restatementTarget(
  block: GrantBlock,
  override: GrantBlock[] | undefined,
  target: GrantRow | undefined,
  nearby: GrantRow[],
  exact: GrantRow[],
  reason: string | null,
) {
  let restatement = false;
  if (!override && !target && (nearby.length || block.restatement)) {
    if (
      block.restatement &&
      block.explicitDate &&
      exact.length === 1 &&
      exact[0]?.kits_json === stableJson(block.kits)
    ) {
      target = exact[0];
      restatement = true;
    } else reason = "compensation_restatement_ambiguous";
  }
  return { target, restatement, reason };
}

export async function planGrants(
  db: D1Database,
  item: NormalizedSourceItem,
  firstIndex: number,
  override?: GrantBlock[],
  condition?: StatementWriteCondition,
  schema27Allowed = board11InvocationGate(db),
): Promise<GrantPlan> {
  if (!(await schema27Allowed())) throw new Error("board11_schema_required");
  const blocks = override
    ? override.map((block) => ({ ...block, kits: normalizeKits(block.kits) }))
    : parseGrantBlocks(item);
  const rows = (await db.prepare(grantSelect).all<GrantRow>()).results;
  const origin = rows.filter(
    (row) => row.source === item.source && row.origin_item_id === item.itemId,
  );
  const plan: GrantPlan = { grants: [], statements: [], judgments: [] };
  const now = new Date().toISOString();
  if (!blocks.length && origin.length)
    blocks.push({
      grantGameDate: null,
      kits: [],
      claimUntilKst: null,
      claimWindowAssumed: true,
      explicitDate: false,
      restatement: false,
      evidence: item.excerpt,
    });
  for (const [index, block] of blocks.entries()) {
    const { reason, target, sameBlocks, restatement } = grantTarget(
      block,
      blocks,
      origin,
      rows,
      item,
      override,
    );
    if (!reason && block.grantGameDate) {
      appendGrant(db, item, block, sameBlocks, target, restatement, plan, now, condition);
    }
    plan.judgments.push(grantJudgment(item, block, firstIndex + index, index, reason));
  }
  return plan;
}

function appendGrant(
  db: D1Database,
  item: NormalizedSourceItem,
  block: GrantBlock,
  sameBlocks: GrantBlock[],
  target: GrantRow | undefined,
  restatement: boolean,
  plan: GrantPlan,
  now: string,
  condition?: StatementWriteCondition,
) {
  const seq = target?.seq ?? sameBlocks.indexOf(block) + 1;
  const id =
    target?.grant_id ?? `grant:${item.source}:${item.itemId}:${block.grantGameDate}:${seq}`;
  const row: GrantRow =
    target && restatement
      ? target
      : {
          grant_id: id,
          source: item.source,
          origin_item_id: item.itemId,
          grant_game_date: block.grantGameDate as string,
          seq,
          kits_json: stableJson(block.kits),
          claim_until: block.claimUntilKst,
          claim_window_assumed: block.claimWindowAssumed ? 1 : 0,
          content_hash: item.contentHash,
        };
  plan.grants.push(supplyGrant(row));
  if (restatement) {
    plan.statements.push(
      db
        .prepare(`INSERT INTO forecast_grant_restatements
          (source,item_id,content_hash,grant_id,evidence_json,created_at)
          SELECT ?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM forecast_grant_restatements WHERE source=? AND item_id=? AND content_hash=? AND grant_id=?) AND (${condition?.sql ?? "1"})`)
        .bind(
          item.source,
          item.itemId,
          item.contentHash,
          id,
          stableJson(block),
          now,
          item.source,
          item.itemId,
          item.contentHash,
          id,
          ...(condition?.bindings ?? []),
        ),
    );
  } else {
    if (!target)
      plan.statements.push(
        db
          .prepare(`INSERT INTO forecast_grants
          (grant_id,source,origin_item_id,grant_game_date,seq,created_at)
          SELECT ?,?,?,?,?,? WHERE (${condition?.sql ?? "1"})`)
          .bind(
            id,
            item.source,
            item.itemId,
            block.grantGameDate,
            seq,
            now,
            ...(condition?.bindings ?? []),
          ),
      );
    plan.statements.push(
      db
        .prepare(`INSERT INTO forecast_grant_revisions
          (grant_id,content_hash,kits_json,claim_until,claim_window_assumed,observed_at)
          SELECT ?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM forecast_grant_revisions WHERE grant_id=? AND content_hash=?) AND (${condition?.sql ?? "1"})`)
        .bind(
          id,
          item.contentHash,
          row.kits_json,
          row.claim_until,
          row.claim_window_assumed,
          now,
          id,
          item.contentHash,
          ...(condition?.bindings ?? []),
        ),
    );
  }
}

function grantJudgment(
  item: NormalizedSourceItem,
  block: GrantBlock,
  blockIndex: number,
  index: number,
  reason: string | null,
): Judgment {
  return {
    blockIndex,
    verdict: reason ? "manual_review" : "schedule_change",
    reason,
    question: "일회성 관리 키트 지급일과 동일 보상의 재안내 여부를 확인해 주세요.",
    triggers: [],
    blockExcerpt: block.evidence,
    maintenanceInputs: [],
    comparison: {
      known: null,
      extracted: null,
      equal: false,
      blocking: reason !== null,
      grant: {
        grantGameDate: block.grantGameDate,
        kits: block.kits,
        claimUntilKst: block.claimUntilKst,
        claimWindowAssumed: block.claimWindowAssumed,
      },
    },
    event: {
      eventId: `${item.source}:${item.itemId}:grant:${index}`,
      eventType: "grant",
      sourceItem: item,
      startsAt: block.grantGameDate
        ? new Date(`${block.grantGameDate}T05:00:00+09:00`).toISOString()
        : null,
      endsAt: block.claimUntilKst,
      scheduleStatus: "confirmed",
      manualReview: reason !== null,
      reason,
    },
  };
}
