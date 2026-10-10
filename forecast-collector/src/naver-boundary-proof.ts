import type { NaverFeedMetadata, NaverSourceKind } from "./types";

export const NAVER_PAGE_SIZE = 10;
export const NAVER_SCAN_PAGES = 3;
// Recovery may need one adjacent page after a marker on page two.
export const NAVER_RECOVERY_PAGES = NAVER_SCAN_PAGES + 1;

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
) {
  if (rawCount < NAVER_PAGE_SIZE) return true;
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
