import type { NaverFeedMetadata, NaverSourceKind } from "./types";

const NAVER_PAGE_SIZE = 10;

// Scans cover 30 rows; recovery covers 40 (one adjacent page after a marker on the last scan page).
export function naverPagePolicy(board: 48 | 56, configured?: string) {
  const pageSize = board === 48 && configured === "5" ? 5 : 10;
  return { pageSize, scanPages: 30 / pageSize, recoveryPages: 40 / pageSize };
}

export function samePublicationTime(left: string | null, right: string | null) {
  return (
    left !== null &&
    right !== null &&
    Number.isFinite(Date.parse(left)) &&
    Date.parse(left) === Date.parse(right)
  );
}

export function orderedOfficialBoundaryItems(
  items: readonly NaverFeedMetadata[],
  source: NaverSourceKind,
  nowMs: number,
) {
  let previous = nowMs;
  const seen = new Set<string>();
  for (const item of items) {
    const time = Date.parse(item.publishedAt);
    if (
      item.source !== source ||
      !item.official ||
      !Number.isFinite(time) ||
      time > previous ||
      seen.has(item.itemId) ||
      item.url !== `https://game.naver.com/lounge/nikke/board/detail/${item.itemId}`
    )
      return false;
    seen.add(item.itemId);
    previous = time;
  }
  return true;
}

export function coveredBoundaryTail(
  page: readonly NaverFeedMetadata[],
  rawCount: number,
  boundary: string,
  knownTail: boolean,
  pageSize = NAVER_PAGE_SIZE,
) {
  if (rawCount < pageSize) return true;
  const tail = page.at(-1);
  const date = Date.parse(boundary);
  // An already-known older tail can be a pin. Require an adjacent older page
  // instead of treating that one row as proof that the equal-date cohort ended.
  return (
    tail !== undefined &&
    Date.parse(tail.publishedAt) < date &&
    (!knownTail || page.every((item) => Date.parse(item.publishedAt) < date))
  );
}
