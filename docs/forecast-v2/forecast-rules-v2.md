# Forecast monitoring rules v2 (user-approved 2026-10-18 KST)

Status: approved by the user as the target behavior. Replaces the current list-based monitoring in
`forecast-collector` completely. Baseline code: branch `next`, commit `8e30e4d`
(staging collector deployment `2dc47cb4`). Nothing below is implemented yet.

## 1. Monitors (replace current 48→56→11 list rotation + daily 2-body reservation entirely)

Common: only posts whose author role is `game_manager`; results ordered newest first
(`orderType=LATEST`); process only posts newer than the stored per-monitor boundary.

| ID | Board | Interval | Search scope | Keyword(s) | Action |
|---|---|---|---|---|---|
| A | 11 | 1 h | title+content | `관리 키트` | Parse kit grants (§3) |
| B | 11 | 1 h | title only | `솔로 레이드` | Report to Discord; admin reviews and can edit the schedule directly. If the body has kit grants, parse them like A |
| C | 56 | 1 h | title+content | `솔로 레이드 오픈`, `솔로 레이드 재오픈` (separate searches) | Read body, extract solo schedule (§2) |
| D | 56 | 1 h | title+content | `콜라보`; exclude titles containing `Pick Up` (case-insensitive) | Read body, extract collaboration start (§4) |
| E | 48 | on demand | title+content | `솔로 레이드 시즌` | Supplement when board 11 information cannot settle a solo schedule |
| F | 48 | 1 h | title+content | `관리 키트` | Parse kit grants (§3) |
| G | 48 | 30 min | full board list (not search) | maintenance notices | Create maintenance schedules; used for every "점검 완료 후" start time |

`협동 작전` keyword monitoring is removed (the co-op shop supply rule in §5 stays).

## 2. Solo raid
- Period line after `진행 기간`: `- M/D(요일) HH:MM ~ M/D(요일) 4:59`; an end of 4:59 means 04:59:59.
- Start `점검 완료 후` → start = end time of the matching maintenance schedule from G.
- "오픈 안내" posts with only an end (`6/25(목) 4:59까지`) → start = post time.
- Suspension / reopen / extension: found by B, reported to Discord, admin confirms. If board 11 cannot
  settle it, supplement with E (example: S26 7/3~7/10 came from board 48 post 6280133).
- Before an official notice exists, predict: next start = last start + median start interval
  (currently 28 days over 41 intervals: official record S1–S40 in `shared/soloRaidCadence.ts` + S41/S42);
  duration equal to the previous season.

## 3. Kit grants (boards 11 and 48)
- Items: `관리 키트 상자 II` (also `Ⅱ`) and `관리 키트 상자`, with quantities.
- Grant date priority:
  1. Explicit `보상 지급일` / `○/○ 지급`.
  2. Otherwise the date-time written inside the post (e.g. `11월 1일(금) 22:00`,
     `6월 26일(목) 00:00 ~ 추후 안내`, `6/11(목) 점검 완료 후 ~`). If the post contains more than one
     candidate schedule → ask the admin on Discord to decide (e.g. 6579018: suspension 8/26 17:00~21:00
     and extension 8/26 21:00~9/1 4:59).
  3. Otherwise the post creation time.
- Dedup: a re-announcement of the same grant on the same grant date counts once; different dates count
  separately even with equal quantities (8/22 and 8/23 2026 both count).

## 4. Collaborations
- New and re-run collaborations both last until 04:59:59 of day 28 from the start date. Sub-event end
  dates in the body are reference only.
- Start sources: `○/○(목) 점검 완료 후`, `○/○ 콜라보 진행 결정`, `○/○ 재등장 예정`, mini-game/story event
  period lines.

## 5. Co-op shop (recurring)
- Every Tuesday 05:00 KST: kit box II ×5; ×10 if that instant lies inside a collaboration period.
  Overlapping collaborations still double only once. Same as current `shared/certifiedSupplyBuild.ts`.

## 6. Day boundary
- All dates are game days (05:00 ~ next day 04:59:59 KST). Times before 05:00 belong to the previous
  game day (6/26 00:00 → game day 6/25).

## 7. Admin calendar
- An admin-only web page shows the next 1 month: solo raid (confirmed and predicted), collaborations,
  maintenance, and per-game-day kit supply (notice grants + co-op shop).
- Discord cannot render calendars: the Discord bot receives calendar update information (what changed,
  link to the admin page) whenever the calendar changes.
- Prototype of the expected content: `.artifacts/forecast-next-month.html`; 2-year backtest:
  `.artifacts/forecast-calendar-2y.html`.

## Naver lounge API facts (measured 2026-10-18, unofficial API, read-only probes)
- Search: `GET https://comm-api.game.naver.com/nng_main/v2/search/feeds?keyword=..&loungeId=nikke&offset=N&limit=N&orderType=LATEST&searchOption=COMMUNITY_FEED_TITLE|COMMUNITY_FEED_TITLE_CONTENT&boardId=11|48|56`
  - Works: title search, title+content search, single boardId, LATEST, offset/limit (limit 500 returned 500).
  - 400 errors: `COMMUNITY_FEED_CONTENT`, `FEED_TITLE_CONTENT`, `orderType=POPULAR|NEW`, `boardId=48,11`.
  - Row fields: feedId, title, board.boardId, user.userRoleCode, createdDate (`2026-09-17T18:00:09.000+09`,
    note the `+09` offset without minutes), updatedDate, previewText.
  - Spacing-insensitive (`관리키트` = `관리 키트`), word-based (`솔레` → 0 hits; `재오픈` ≠ `오픈`).
  - Only roughly the first ~200 characters of long bodies are indexed: long maintenance notices are not
    found by body keywords. Board 48 `관리 키트` search returned the same 5 posts as a full scan of all
    132 official board-48 posts in 2 years. Board 11 `관리 키트` search missed 3 solo-suspension grant posts
    (5013873, 6252194, 6579018), all of which B (title `솔로 레이드`) catches.
  - Freshness: 8 of 9 newest posts found immediately; exact indexing delay not measured.
- Board list: `GET .../nng_main/v1/community/lounge/nikke/feed?boardId=48&buffFilteringYN=N&limit=30&offset=<page index>&order=NEW`
  (offset is a page index, not a row offset). createdDate in list rows is `yyyyMMddHHmmss`.
- Detail: `GET .../feed/<feedId>`; body text extraction: `forecast-collector/src/solo-sections.ts:extractNoticeText`.

## Backtest results (2024-10-18 ~ 2026-10-18)
- C with the new keywords finds S19–S42 with no gap; `솔로 레이드 재오픈` adds 7877359 (S38 reopen).
- Kit grants: 11 (board 11: 6, board 48: 5), box II 338, box 35. Co-op 2× weeks: 23.
