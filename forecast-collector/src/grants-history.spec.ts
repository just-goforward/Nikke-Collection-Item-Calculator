import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { sha256Hex } from "./crypto";
import { grantRefs, loadGrants, parseGrantBlocks, planGrants } from "./grants";
import { extractNoticeText, noticeTexts } from "./solo-sections";
import { runtimeTestDb } from "./test-runtime-db";
import type { NormalizedSourceItem } from "./types";

// Historical ledger reproduction also supports the independently sealed v4 oracle.
let sqlite: DatabaseSync;
beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../fixtures/schema-v27-test.sql", import.meta.url), "utf8"));
});
afterEach(() => sqlite.close());
async function fixture(id: number): Promise<NormalizedSourceItem> {
  const payload = JSON.parse(
    readFileSync(new URL(`../fixtures/naver-detail-${id}.json`, import.meta.url), "utf8"),
  );
  const text = extractNoticeText(payload.content.feed.contents);
  const item: NormalizedSourceItem = {
    source: `naver-board-${payload.content.board.boardId}` as NormalizedSourceItem["source"],
    itemId: String(id),
    url: `https://game.naver.com/lounge/nikke/board/detail/${id}`,
    title: payload.content.feed.title,
    excerpt: text.effective.slice(0, 600),
    normalizedText: text.effective,
    publishedAt: "2026-06-23T11:51:38.000Z",
    contentHash: await sha256Hex(text.effective),
    structured: true,
    official: true,
  };
  noticeTexts.set(item, text);
  return item;
}
async function settle(item: NormalizedSourceItem) {
  const db = runtimeTestDb(sqlite);
  const plan = await planGrants(db, item, 0);
  if (plan.statements.length) await db.batch(plan.statements);
  return plan;
}
it.each([
  ["2025-12-30T10:00:00Z", "1월 2일"],
  ["2026-06-25T10:00:00Z", "6월 20일"],
])("reviews past implied-year dates published %s", async (publishedAt, date) => {
  const item = {
    ...(await fixture(7833931)),
    publishedAt,
    normalizedText: `보상 안내\n관리 키트 상자 II * 56\n지급일: ${date}`,
  };
  const plan = await settle(item);
  expect(plan.grants).toEqual([]);
  expect(plan.judgments[0]).toMatchObject({
    verdict: "manual_review",
    reason: "compensation_grant_date_ambiguous",
    comparison: { blocking: true },
  });
});
it("keeps explicit past years and normal same-year dates", async () => {
  const base = await fixture(7833931);
  for (const date of ["2026년 6월 20일", "6월 26일"]) {
    const item = {
      ...base,
      publishedAt: "2026-06-25T10:00:00Z",
      normalizedText: `보상 안내\n관리 키트 상자 II * 56\n지급일: ${date}`,
    };
    expect(parseGrantBlocks(item)[0]?.dateAmbiguous).toBe(false);
  }
});
it("scopes historical restatement language to its block", async () => {
  const item = {
    ...(await fixture(7833931)),
    normalizedText:
      "첫 보상 안내\n이전 공지에서 약속드린 보상\n관리 키트 상자 II * 1\n지급일: 6월 20일\n새 보상 안내\n관리 키트 상자 II * 2\n지급일: 6월 26일",
  };
  expect(parseGrantBlocks(item).map((block) => block.restatement)).toEqual([true, false]);
  expect((await settle(item)).judgments[0]?.reason).toBe("compensation_grant_date_ambiguous");
});
it("extracts explicit kit grant dates without treating non-kit rewards as supply", async () => {
  expect(parseGrantBlocks(await fixture(7833931))[0]).toMatchObject({
    grantGameDate: "2026-06-23",
    kits: [
      { law: "box-ii-v1", count: 56 },
      { law: "regular-box-v1", count: 16 },
    ],
    claimUntilKst: null,
    claimWindowAssumed: true,
  });
  expect(parseGrantBlocks(await fixture(7879335))).toEqual([]);
  expect(parseGrantBlocks(await fixture(8091116))[0]?.grantGameDate).toBeNull();
  expect((await settle(await fixture(8091116))).judgments[0]?.reason).toBe(
    "compensation_grant_date_missing",
  );
});

it("refuses grant settlement before migration 27", async () => {
  sqlite.exec("DELETE FROM schema_migrations WHERE version>=27");
  await expect(settle(await fixture(7833931))).rejects.toThrow("board11_schema_required");
  expect(await loadGrants(runtimeTestDb(sqlite))).toEqual([]);
});
it.each([false, true])("links restatements in either arrival order, retry=%s", async (reverse) => {
  const origin = await fixture(7833931),
    repeated = await fixture(7837735);
  if (reverse)
    expect((await settle(repeated)).judgments[0]?.reason).toBe(
      "compensation_restatement_ambiguous",
    );
  const first = await settle(origin);
  expect(first.grants[0]?.id).toBe("grant:naver-board-11:7833931:2026-06-23:1");
  const linked = await settle(repeated);
  expect(linked.grants[0]?.id).toBe(first.grants[0]?.id);
  await settle(origin);
  await settle(repeated);
  expect(await loadGrants(runtimeTestDb(sqlite))).toHaveLength(1);
  expect(sqlite.prepare("SELECT COUNT(*) AS n FROM forecast_grant_revisions").get()?.["n"]).toBe(1);
  expect(sqlite.prepare("SELECT COUNT(*) AS n FROM forecast_grant_restatements").get()?.["n"]).toBe(
    1,
  );
});
it("keeps an origin's identity on a single-block quantity revision", async () => {
  const original = await fixture(7833931);
  const first = await settle(original);
  const changed = {
    ...original,
    normalizedText: original.normalizedText.replace("II * 56", "II * 57"),
    contentHash: "b".repeat(64),
  };
  const next = await settle(changed);
  expect(next.grants[0]?.id).toBe(first.grants[0]?.id);
  expect(next.grants[0]?.refs).toContainEqual({ lawId: "box-ii-v1", count: 57 });
  expect(sqlite.prepare("SELECT COUNT(*) AS n FROM forecast_grant_revisions").get()?.["n"]).toBe(2);
});
it("rejects nearby grants without explicit restatement evidence", async () => {
  const original = await fixture(7833931);
  await settle(original);
  const other = { ...original, itemId: "999", contentHash: "c".repeat(64) };
  expect((await settle(other)).judgments[0]?.reason).toBe("compensation_restatement_ambiguous");
});
it("splits counts over 64 without changing quantities", () => {
  expect(grantRefs([{ law: "box-ii-v1", count: 130 }])).toEqual([
    { lawId: "box-ii-v1", count: 64 },
    { lawId: "box-ii-v1", count: 64 },
    { lawId: "box-ii-v1", count: 2 },
  ]);
});

it("keeps an invalid explicit claim deadline in manual review", async () => {
  const original = await fixture(7833931);
  const item = {
    ...original,
    contentHash: "e".repeat(64),
    normalizedText: "보상 안내\n관리 키트 상자 II * 1\n지급일 6/23\n수령 기한 6/24 99:99",
  };
  expect((await settle(item)).judgments[0]?.reason).toBe("compensation_claim_deadline_ambiguous");
  expect(await loadGrants(runtimeTestDb(sqlite))).toEqual([]);
});

it("allocates distinct same-date block identities once and rejects later block-set changes", async () => {
  const original = await fixture(7833931);
  const text =
    "보상 안내\n관리 키트 상자 II * 2\n지급일 6/23\n보상 안내\n관리 키트 상자 II * 2\n지급일 6/23";
  const item = { ...original, normalizedText: text, contentHash: await sha256Hex(text) };
  const first = await settle(item);
  expect(first.grants.map((grant) => grant.id)).toEqual([
    "grant:naver-board-11:7833931:2026-06-23:1",
    "grant:naver-board-11:7833931:2026-06-23:2",
  ]);
  expect((await settle(item)).grants.map((grant) => grant.id)).toEqual(
    first.grants.map((grant) => grant.id),
  );
  const changed = {
    ...item,
    normalizedText: text.replace("II * 2", "II * 3"),
    contentHash: "d".repeat(64),
  };
  expect(
    (await settle(changed)).judgments.every(
      (entry) => entry.reason === "grant_same_date_blocks_changed",
    ),
  ).toBe(true);
  expect(await loadGrants(runtimeTestDb(sqlite))).toHaveLength(2);
});

it("rolls a concurrent allocation back and returns the winning identity on retry", async () => {
  const item = await fixture(7833931),
    db = runtimeTestDb(sqlite);
  const left = await planGrants(db, item, 0),
    right = await planGrants(db, item, 0);
  await db.batch(left.statements);
  await expect(db.batch(right.statements)).rejects.toThrow("forecast_grant_immutable");
  expect((await settle(item)).grants[0]?.id).toBe(left.grants[0]?.id);
  expect(await loadGrants(db)).toHaveLength(1);
});
