# Forecast monitoring v2 — integrated implementation plan (PLAN-v2.1, AUDIT_PLAN; §7A amendments override earlier sections)

- Requirement source: `.artifacts/forecast-rules-v2.md` (user-approved 2026-10-18).
- Baseline: branch `next`, HEAD `8e30e4d`, clean tracked tree. Staging collector = this commit; staging D1 schema 29; production D1 schema 10 (untouched).
- Inputs: specialist audit reports (architecture/Heavy Worker, database, admin page/Front Worker, security, tests) — summarized here with IDs. Nothing implemented, run, or deployed.
- Platform fact (Cloudflare docs, read 2026-10-18): cron minute field accepts `,` lists; Workers Paid allows 250 cron triggers per account; cron CPU limit is configurable (`cpu_ms = 100` kept).

## 1. Target architecture

| Component | Role in v2 | Basis |
|---|---|---|
| `forecast-collector` | Monitors A–G, detail fetch, judgments, calendar projection, candidate build. Old rotation/queue/2-body path removed after cutover. | ARCH H1–H2 |
| `forecast-dispatcher` | Delivers 3 new Discord message types (B report, grant-date decision, calendar changed) through existing outbox/`sendDiscordMessage`. | ARCH §4, ADMIN F7 |
| `forecast-interactions` | Handles new buttons/modals (confirm/edit schedule, choose grant date) with environment + message + revision binding. Approve/off/rollback unchanged. | SEC S1, S3 |
| `forecast-admin` (new Worker, own hostname) | Read-only server-rendered calendar (no JS, not in Vite bundle) behind Cloudflare Access + in-Worker JWT/email check. | ADMIN P1–P3 |
| Publication path (seal/approve/activate, `site-worker` `/api/forecast`) | Unchanged; new rules produce new candidates through existing approval. | ARCH §5, DB §3 |

### 1.1 Scheduling (one cron, minute list, one bounded work unit per invocation)
- Hourly slots: A `:00`, B `:06`, C-open `:12`, C-reopen `:18`, D `:24`, F `:36`, G `:03` and `:33`; remaining listed minutes run continuation/detail/judgment, candidate, and notification units. E only when a B review requests it (admitted into continuation slots).
- Budgets per environment per KST game day (proposal): 240 metadata requests (normal use 192), 48 detail requests, max 4 pages per scan, E ≤ 4 metadata + 4 details per request, 3 attempts per item with backoff. Exhaustion holds work and raises a stale-coverage alert; never silently advances a boundary. Usage Guard before work and before commit; `cpu_ms = 100`, no 50 ms warning.

### 1.2 Monitor state contract
- One stream per query (A, B, C-open, C-reopen, D, E, F, G). Committed boundary advances only after the scan reaches the previous boundary and every eligible hit is durably stored. Equal-timestamp ties tracked by feed ID set. Search offsets are row offsets; G list offsets are page indexes. Timestamps normalized from `+09` (search) and `yyyyMMddHHmmss` (list).
- Validation: lounge, board, `game_manager`, feed ID, timestamp, ordering, detail identity; drift/missing boundary → hold + alert (existing `source-queue.ts` hold semantics reused).
- Bootstrap: explicit cutoff + bounded catch-up (separately approved); old board cursors are not translated.

## 2. Rule implementation map

| Rule | Change | Reuse |
|---|---|---|
| Solo (C/E) | Monitor-specific routing; `진행 기간` line; 4:59 → 04:59:59; end-only "오픈 안내" → post time start; `점검 완료 후` → G maintenance end (typed reference, missing/multiple → unresolved, never guess). | `solo-sections.ts` `soloSections`/`extractNoticeText`, `solo-judgment.ts` `judgeSolo` |
| Maintenance (G) | New first-class maintenance schedule; replaces text-history lookup `notice-processing.ts` `noticeMaintenance`; corrections invalidate dependents. | existing maintenance-time parsing |
| B interruptions | Always Discord report; parsed result is evidence until admin confirms; E triggered once per unresolved review. | `solo-interruptions.ts` `judgeInterruption`, `collapseSoloSegments` |
| Prediction | Median of season start intervals (S1–S40 history + confirmed later seasons, one start per season), duration = previous season. **Also replace certified-output mean/Thursday-snap/fixed-7-day logic** in `shared/certifiedSupplyBuild.ts` `soloLedger` / `shared/soloRaidCadence.ts` `estimateCertifiedSoloRounds` so site forecast and admin calendar agree. Replace the 21–35-day gap rejection in `candidate.ts` `resolveSoloSchedule`. | `summarizeSoloRaidCadence` |
| Kit grants | Items alone qualify (drop `보상|기념|축하` prerequisite in `grants.ts` `parseGrantBlocks`); date priority explicit → in-post → creation; multiple in-post schedules → Discord decision, no supply until decided; dedup = canonical occurrence + same game day (replace adjacent-date ambiguity in `grantTarget`/`restatementTarget`). | `parseKits`, `grantRefs` |
| Collaboration (D) | Collaboration-specific start extraction (replaces generic `naver.ts` `parseScheduleEvents` use); end = 04:59:59 after 28 included game days; sub-event ends are evidence only; Pick Up titles excluded. | — |
| Co-op | No change: `certifiedSupplyBuild.ts` `recurringEvents` Tuesday 05:00 ×5/×10 with `.some(...)` overlap; fed validated collaboration windows. Co-op keyword monitoring removed. | as is |
| Game day | Exact instants stored + derived game day (05:00 KST) everywhere incl. budgets; date-only sources keep date precision. | — |

## 3. Data (additive migrations 0030–0033, staging only)
- 0030: monitor definitions/queries/state/runs, search hits, post versions, fetch attempts, legacy revision links.
- 0031: calendar event revisions + heads (`maintenance|solo|collaboration`, `predicted|confirmed|pending|cancelled`, maintenance dependency, prediction provenance), decisions + immutable results, idempotent admin commands with expected revision (CAS).
- 0032: grant observations, occurrence revisions + heads (date basis `explicit_payment|in_post_datetime|maintenance_end|post_created|admin_selected|legacy_unverified`), observation links incl. legacy grant IDs.
- 0033: calendar snapshots/days/event links, active pointer with version fence, outbox (atomic with snapshot; identical content → no notification).
- Preserve all existing evidence, grants, sealed candidates, approvals, pointers. Retire legacy tables operationally only. Backfill with deterministic import keys; legacy dates without basis → `legacy_unverified`. Migration tooling needs an explicit staging-target preflight (`scripts/apply-forecast-d1-migrations.ts` applies all missing files). Rollback = disable v2 writers/readers; Time Travel only as whole-DB recovery per runbook with bookmarks before migration and after backfill.

## 4. Discord and admin interfaces
- Message types: (1) B report with extracted change, kits, buttons `확정` / `일정 수정` (modal) / `관련 없음`; (2) grant-date decision listing exact candidates + evidence; (3) calendar changed: semantic diff + admin-page link (`?rev=` + `#gd-<day>`), no calendar body.
- Interaction safety (SEC S1/S3): bind environment, DB, guild/channel/admin ID, message ID, persisted expiring request, source hash and expected calendar revision; consume interaction ID atomically; CAS mutation; reject stale/replayed/cross-environment. Production mutations stay disabled; staging buttons must provably not write production (separate staging endpoint/bindings if the shared endpoint cannot enforce it).
- Output encoding (SEC S5): one HTML encoder, one Discord-markdown encoder, URL host allow-list, mentions suppressed everywhere, length caps. Fix current unescaped title/link path in `forecast-dispatcher/src/discord.ts` (no-evidence branch).
- Admin page (ADMIN P1–P9): separate Worker `forecast-admin`, hostname e.g. `forecast-admin-staging.nikkecollection.com`; `workers_dev=false`; Access app + `Cf-Access-Jwt-Assertion` verification (aud/iss/exp, email allow-list), fail closed; pre-auth IP limit, per-identity limit, Usage Guard; `no-store`, `noindex`, strict CSP; one fixed SELECT of the active snapshot. v1 read-only. Accessible `<ol>` day list, 7-column grid on wide screens, single-column agenda < 640 px; status always text + pattern; empty/stale/error states. Range = current game day through same date next month inclusive (month-end clamped). Public bundle sizes unchanged.

## 5. Stages (each needs the listed approval)

| Stage | Content | Approval |
|---|---|---|
| S0 | User decisions §7; read-only Naver fixture capture (sanitized, manifest with hashes) into `forecast-collector/fixtures/forecast-v2/` | this plan approval + network read |
| S1 | Migrations 0030–0033 (files only) + pure search/list clients, parsers, rules, projection, prediction alignment; offline fixtures | implementation approval |
| S2 | Discord message types, interactions with binding/replay protection, dispatcher outbox | implementation approval |
| S3 | `forecast-admin` Worker (read-only) | implementation approval |
| S4 | Local verification (§6), both reviewers, local commits on `next` | implementation approval |
| S5 | Staging: bookmark → apply 0030–0033 → bootstrap catch-up → old writer off → deploy collector/dispatcher/interactions/admin → Access app/DNS/secrets | separate staging approval per action |
| S6 | Staging validation: real CPU (≤100 ms) per unit, 1-week monitor run, candidate → approve → off → rollback E2E, admin page access tests | staging approval |
| S7 | Production cutover, legacy table retirement | separate approvals |

Certified-supply code changes (prediction alignment) require the existing v10 re-seal/oracle process before approval of any new candidate.

## 6. Verification (Test plan T01–T15)
- Unit: game day (T01, multiple process TZs), search client params/quirks (T02), boundary/pagination/failures/leases (T03), kit grants incl. 5013873→11/01, 6252194→06/25, 6579018→decision, dedup pairs (T04), solo incl. S19/S26/S38 sequences and E once (T05), median 28 → S43 2026-11-12 12:00~11-19 04:59:59 (T06), collaborations 28-day + Pick Up exclusion (T07), co-op ×5/×10 boundaries and 7/8 overlap = 10 (T08).
- Backtest (T09): fake Naver server over captured fixtures, stepped clock, scripted admin decisions → S19–S42, 7877359 via 재오픈, 6 collaborations, 11 grants = II 338 / I 35, 104 co-op weeks, 23 doubled, 15 B reports. Oracle integrity (T10).
- E2E admin page (T11, Miniflare, no network, axe, 390/1280 px, two timezones); admin API/auth (T12); Discord messages (T13, escaping, mentions, size, one message per revision); migrations (T14, populated v29 upgrade, idempotency, immutability); CPU specs per unit ≤ 50 ms Node proxy (T15) and real workerd ≤ 100 ms in S6.
- Existing: `test:forecast-collector`, `test:forecast-dispatcher`, `test:forecast-interactions`, root `npm test`, `typecheck`, `lint`, `check:bundle-budget` totals unchanged; obsolete tests (rotation, source queue, daily limit, board11 policy, old CPU specs) removed only together with their modules; contradicted tests rewritten.

## 7. User decisions required (recommended default in bold)

| ID | Question | Recommendation |
|---|---|---|
| U1 | Search indexing may lag; strict "newer than boundary" can miss late-indexed posts. | **Re-scan an overlap window (last 24 h of each stream) every run; dedupe by feed ID.** |
| U2 | Edited posts (e.g. "(5/28 내용 수정)") | **Re-fetch when a search/list hit shows a newer `updatedDate` within 14 days of creation.** |
| U3 | Daily budget per game day | **240 metadata / 48 detail requests (normal use 192).** |
| U4 | Collaboration start with date only (e.g. `7/3(목)`) | **Use the same-date G maintenance end; if none, Discord decision.** |
| U5 | Prediction duration when the previous season was suspended; even-count median | **Use the originally announced duration; even median = mean of middle two rounded down to whole days.** |
| U6 | Same game day, different quantities across posts | **Discord decision (correction vs. separate grant).** |
| U7 | Which board-48 posts are maintenance notices; scheduled vs actual end | **Title contains `점검` and body has `점검 일시`; use the latest revision's end (extensions/`[점검 완료]` updates override); multiple same-day → decision.** |
| U8 | Pick Up variants | **Exclude `Pick Up`, `PickUp`, `픽업` (case-insensitive).** |
| U9 | Where admin edits schedules | **Discord `일정 수정` modal in v1; admin page read-only.** |
| U10 | Admin page location | **Separate `forecast-admin` Worker on its own hostname with Cloudflare Access.** |
| U11 | Prototype extras (35-day alternative, expected notice date) | **Keep both as labeled predictions.** |
| U12 | Shared Discord interaction endpoint | **Separate staging Discord app/endpoint before enabling edit/decision buttons.** |

## 7A. PLAN-v2.1 amendments after dual review (these override §1–§7 where they differ)

| ID | Amendment | Source |
|---|---|---|
| A1 (blocker) | `forecast-interactions` has no staging env and binds both DBs (`forecast-interactions/wrangler.toml`; DB chosen from custom_id in `src/worker.ts`). **Precondition of S2/S5:** a separate staging interactions Worker + staging Discord app holding only the staging DB binding (U12 becomes mandatory, not optional). Test: staging custom_ids can never reach `PRODUCTION_FORECAST_DB`. Any deploy of the existing shared Worker = production-endpoint deployment needing its own approval. | R1-01, R2 accept |
| A2 | Public forecast prediction change is **not** in the approved scope → new decision **U13**. If aligned: add a new cadence version next to `observed-mean-thursday-v1` (`shared/certifiedSupplyValidation.ts` `validateCadenceMean`) so existing sealed/approved records still validate and roll back; also decide the `transitionCertifiedSoloDelay` delay offset (U15). Bundle criterion becomes "within budget, delta reported". Re-seal wording: next evidence panel after `scripts/certified-staging-approved-panel/v9` (not runbook "v10 canary"). | R1-02, R2-01 |
| A3 | E repeats (hourly in continuation slots, within budget) while a solo review stays unresolved; stops on resolution or review expiry; admin can request another search. One run = one durable job incl. pagination/retries. Decision **U14**, decided together with U17 (review expiry must be ≥ 7 days for the S26 case). When a stream's edit horizon is not covered by one page, A6 continuation finishes it; otherwise the stream is reported stale, never silently truncated. Tests prove S26 resolves via 6280133 posted 6 days later. | R1-03, R2-06 |
| A4 | Kits found by B go through the grant pipeline immediately; only the solo schedule change waits for admin confirmation. One observation per feed across A/B/F. | R1-04 |
| A5 | Single traversal contract: each invocation belongs to exactly one due stream and reads one page (A6). New-post scan: newest first until the committed boundary. Edit/late-arrival scan: a separately scheduled, bounded job per stream (own slots, durable progress, counted in the budget) walks rows created within the horizon and compares `updatedDate`/feed IDs; body re-fetch only when changed or unseen. Horizon is decision **U1/U2 merged** (recommend 14 days). Fixtures for >24 h edits and late arrivals. | R1-05, R2-03, R2 A5 dissent |
| A6 | Bounds: search page size 30; board-48 list (G) page size 10 (S0 evidence: a 30-row list response exceeded the 2 MB guard); detail response ≤ 2 MB (`naver.ts` `MAX_RESPONSE_BYTES`); one page or one body per invocation; max 4 pages per scan generation with durable continuation + lease; retries counted in budget; a held stream retries next slot and alerts after 3 consecutive holds; admin can authorize a bounded extended catch-up. | R2-04 |
| A7 | Collaboration identity: no automatic heuristic grouping. A D post with an extractable start whose 28-day window overlaps an existing collaboration with the same start game day is the same collaboration; any other overlap (different start, or unclear) → Discord decision (same / new / not a collaboration). Posts without a start are evidence only and do not create collaborations. Any automatic grouping rule needs user approval (decision **U21**). | R1-06, R2 A7 dissent |
| A8 | Grant-date candidates = date-times in the grant block and in the post's schedule lines (`중단`, `연장`, `재개`, `점검`, `진행 기간`, `일시`), incl. open ranges `~ 추후 안내`; excluded: `수령 기한`, title edit notes `(○/○ 내용 추가/수정)`. 6579018 stays a decision. | R1-07 (+R2 correction) |
| A9 | Grant eligibility is decision **U16** (recommend: distribution to all accounts — compensation/celebration mail; not event missions or shop items). | R1-08 |
| A10 | Keep cron `*/3`; explicit minute→unit table; update `canary-start-contract.ts`/`canary.ts`/`profile.ts` routing and their tests. | R1-09 |
| A11 | Access JWT: signature verification against team JWKS (kid lookup, bounded cache, RS256 pinned) + claims; forged/unsigned token tests. | R1-10 |
| A12 | CPU tests for interactions (10 ms) and dispatcher (25 ms) units; raising either is a separate config approval. | R1-11 |
| A13 | Rollback target: redeploy staging collector `2dc47cb4` with its own settings; old modules kept until S7; a test runs the old collector against a DB containing 0030–0033 data; cursor reconciliation documented; v2-only observations retained inert. Disabling v2 alone is a stop, not rollback. | R1-12, R2-05 |
| A14 | S5 order: deploy v2 in hold mode → old writer off (fence) → cutoff ≤ old last boundary minus overlap → bounded catch-up. Bootstrap horizon derived from dependencies (≥ 28 days for collaborations, latest confirmed solo season, open reviews, maintenance referenced by them); sufficiency verified by the backtest, not assumed. | R1-13 |
| A15 | T09 expectations derived per item from the rules over fixtures with a trace; differences from the 2y HTML (built with older parameters) escalated to the user. | R1-14, R2-08 |
| A16 | Single outbox owner = the dispatcher. Superseded by Lead decision during S1: the existing `forecast_runtime_outbox` (0027: kinds `review|result`, mandatory publication `review_id`) is NOT altered or rebuilt. 0033 adds a separate v2 notification outbox table for the three new message kinds; the dispatcher drains both through the same send/rate-limit code. Reason: no rebuild of an existing constrained table, and a rolled-back legacy dispatcher simply ignores v2 rows. | R1-15, DB S1 conflict |
| A17 | `?rev=` is display-only: page shows latest snapshot plus "이 링크 이후 갱신됨" when superseded. | R1-16, R2-07 |
| A18 | Approvals listed separately: local commits; S6 real Discord delivery for ~1 week; S7 no DROP, production 10 → 33. | R1-17, R2-02 |
| A19 | S0 capture: ≤ 300 requests, ≥ 1 s spacing; keep only `game_manager` content, no user identifiers; manifest hashes. | R1-18 |
| A20 | Cutover disposition for legacy manual reviews/buttons and collector `/discord/interactions` (`DISCORD_INTERACTION_OWNER`): resolve or migrate open reviews, then disable old buttons with an explanatory reply. | R1-19 |
| A21 | U8 default changed to the approved literal: exclude titles containing `Pick Up` (case-insensitive); other variants only if the user approves. | R1-20 (R2 noted U8 is already a decision) |
| A22 | 35-day alternative = second most frequent interval; expected notice = start − 6 days at 17:00 (2-year pattern); both labeled predictions with tests. | R2-08 |

Additional decisions: U13 public forecast alignment; U14 E repetition; U15 overdue prediction / delay offset; U16 grant eligibility; U17 decision/B-review expiry and reminders; U18 what counts as a calendar change (daily roll quiet, batching, bootstrap quiet); U19 Discord channel per message type; U20 Access allow-list email(s) and hostname; U21 automatic collaboration grouping (default: none, ask on Discord).

## 7B. User decisions (received 2026-10-18) — binding

- Recommended defaults accepted: U1/U2 (14-day edit/late-arrival horizon), U3 (240 metadata / 48 detail per game day), U4, U6, U7, U9, U10, U11, U13 (align public forecast to median; new cadence version coexisting with `observed-mean-thursday-v1`), U14 (E hourly while unresolved), U15 (overdue → "공지 대기", shift one day at a time), U16 (all-account mail grants only), U17 (14-day expiry, one reminder after 3 days), U18, U19 (B reports/decisions → approval channel, calendar changes → activity channel), U21 (same start game day → same collaboration, else Discord).
- **U8 changed:** D excludes titles containing `Pick Up` or `픽업` (case-insensitive, spacing-insensitive for `Pick Up`); `PickUp` also counts as `Pick Up`.
- **U5 changed:** when the previous season was interrupted, its duration for prediction = start → interruption (suspension) time, not the originally announced duration. Even-count median = mean of the middle two, rounded down to whole days (unchanged).
- **U7 widened (2026-10-18):** a board-48 post is a maintenance notice when its title contains `점검` and its body has an `점검 일시` or `일시` label (e.g. 6241570 `✔️ 일시`). Titles where `점검` occurs only inside `무점검` (no-maintenance updates) are not maintenance notices (Lead interpretation: `무점검` means no maintenance).
- **U22 (2026-10-18):** archive re-addition notices (e.g. 7660727, collaboration story re-added to the archive) are not collaborations and do not double co-op; future similar D posts → `collaboration` decision request (not counted until decided).
- **v2 candidate unit CPU (2026-10-18):** local Node regression threshold for `runV2CandidateUnit` only = 80 ms (measured median 47 / max 63 ms; legacy candidate 31 ms; two optimization attempts without gain). Production cap stays 100 ms; real workerd CPU is decided in S6.
- **lazy-certified budget:** 40,000 → 40,500 B gzip (user-approved after reduction to 40,019 B).
- U12: separate staging Discord application + staging-only interactions Worker (guidance started; user creates the app).
- U20: hostname `forecast-admin-staging.nikkecollection.com`; Access allow-list = one admin email (stored in deploy config, not in source or tests; tests use a placeholder).
- Approved now: S0 (fixture capture ≤ 300 requests, ≥ 1 s spacing, game_manager only, no user identifiers) and S1–S4 local implementation/verification. **Not approved:** commits, staging/production deployment, migrations on remote DBs, real Discord sends, Access/DNS changes.

## 7C. Implementation review round 1 — final disposition (both reviewers REJECT; fixes F1–F16)

| Fix | Content | Source | Owner |
|---|---|---|---|
| F1 blocker | Compact deterministic decision IDs (e.g. `d_<24 hex>`), every producer's real decision rendered through `renderForecastV2Notification` in a test (all custom_ids ≤ 100). | R1-01/R2-09 | rules + tests |
| F2 blocker | Decision application isolated from post processing and calendar rebuild; deterministic failures recorded as terminal (`stale`/`failed` + new request or alert) so the queue advances; `bok` offered only when the extracted schedule is complete. | R1-02 | rules (+ dispatcher/interactions for `bok`) |
| F3 blocker | v2 publication-candidate adapter + bounded scheduling unit: v2 heads/grants/predictions → existing candidate/sealing pipeline input with cadence `observed-median-v2`; approved records untouched. Such candidates cannot be sent for approval until a new sealed evidence panel after `scripts/certified-staging-approved-panel/v9` covers the current engine (explicit, tested gate). Gate location: dispatcher admission (`forecast-dispatcher/src/admission.ts` `admitCandidates`) — a candidate whose snapshot cadence is `observed-median-v2` is held (`awaiting_evidence_panel`, no review/outbox) unless `shared/certifiedEvidenceCoverage.ts` lists a sealed panel anchor covering that cadence version and the current engine build hash (none today). | R2-10, R1-09 | candidate (new) + ingest wiring |
| F4 | Rules throughput and poison isolation: per-version attempt count, terminal disposition + alert after N, more than one version per invocation / more rules slots within CPU. | R1-03 | ingest |
| F5 | Decision identity per feed + source version (not monitor); B sends only `b_report` for `solo_review`; new source version supersedes older pending decisions; acceptance/application rejects non-current source versions (grant decisions fenced by source version). | R1-04, R2-12 | rules + interactions |
| F6 | When an event advances, pending requests for it become `stale` and are re-issued. | R1-05 | rules |
| F7 | Non-manager rows filtered (not fatal); lounge taken from `lounge.loungeId` (present in live rows, verified 2026-10-18 with one read request); test with an unsanitized-shape page. | R1-06 | ingest |
| F8 | Migration gate: apply script refuses migrations ≥ 30 unless an explicit flag is given, so merging to `main` cannot apply v2 schema remotely through existing workflows; S5 prerequisites list workflow handling for staging interactions/admin Workers. | R1-07 (partial dispute) | db |
| F9 | Stale coverage alert delivered (existing ops alert path), pending decisions + stream coverage written into calendar snapshots. | R1-08 | ingest + rules |
| F10 | Unresolved collaboration/maintenance decisions carry actionable candidates and an edit path (modal for those types); maintenance requests refreshed. | R2-13 | rules + interactions |
| F11 | Edited grant date reconciles the same post's previous occurrence (correction), ambiguous cases → decision; distinct re-announcements unchanged. | R2-14 | rules |
| F12 | Backtest asserts every per-item difference against an approved list; no fixture writes during tests; add an end-to-end replay ingest → rules → render → interaction → apply. | R2-15 | tests |
| F13 minor | Stable prediction IDs per round (revisions, no daily remove/add noise). | R1-10 | rules |
| F14 minor | Empty / exact-multiple pagination no longer holds; deleted-boundary hold gets a bounded recovery. Lead decision (round 2): automatic re-seed to the newest valid row older than the stored boundary, with an alert, is accepted instead of an admin-triggered path — the boundary only moves older and replays are idempotent, so no post can be skipped; no older row → hold + alert. | R1-12 | ingest |
| F15 minor | `drainV2Outbox` isolated from legacy run; renderer/validation errors terminal; 5th-attempt send + commit-failure edge reconciles instead of `dead`. | R1-13 (+R2-11 edge) | dispatcher |
| F16 minor | Range-scoped reads in rebuild/process/refresh. | R2-16 | rules |

U12 staging Discord app (received 2026-10-18; public values, no token): name `Nikke Forecast Staging`, application ID `1561374944062087470`, public key `b79085a12035ecebb892f94d9711b5116c535b9fe0d324c6b6821b9deaaa0e1e`; staging channels approval `1561375802027810957`, activity `1561375968441143306`, alert `1561376052209778769`. Guild ID and approver user ID: same as the existing staging configuration. Interactions Endpoint URL is set only after the staging interactions Worker (`collection-kit-forecast-interactions-staging`) is deployed in S5; the bot token is entered by the user directly as a Worker/dispatcher secret in S5.

Round 2 notes (Lead): R1-18 — once 0030+ is on `main`, every existing staging deploy/production promote fails at the migration gate (fail-safe); merging to `main` therefore requires the S5 workflow changes first (per-environment approved maximum or explicit flag) — merge prerequisite. R1-19 — S6's "candidate → approve → off → rollback" for v2 candidates requires the post-v9 sealed evidence panel (and `CERTIFIED_EVIDENCE_COVERAGE` entry) before S6; until then S6 covers ingestion/rules/calendar/Discord only.

Deferred / not defects: R1-11 budget headroom (validate in S6), R1-14 admin hostname (staging-only, configure before S7), R1-15 real G CPU/size (S6), R1-16 staging dispatcher must use the staging app bot token (S5 prerequisite).

Round 2 candidate notes (R1-17/R1-20): publication reads only window-overlapping event/grant payloads, plus the latest solo anchor's complete segments. Seasons above the bundled history (currently S40) remain compact cadence dependencies: one confirmed initial start per season, passed as `confirmedRounds` and included in the input signature. They are not truncated to the event-capacity sentinel; dropping old starts would change the exact median. This compact history remains O(number of unbundled seasons), while body/admission work is window-scoped. Refresh the bundled history during a separately reviewed engine release after new seasons are confirmed: verify source-backed starts and interruption identities, regenerate engine identity, rerun median/payload/backtest regressions, and obtain covering evidence-panel approval before publication. No automatic runtime history rewrite or retroactive mutation of sealed candidates is permitted. Refresh is operational maintenance, not a correctness prerequisite for several years of compact accumulated history. Held outcomes open one deduplicated ops alert per environment/reason; successful work resolves these alerts.

### S5 prerequisites
- Explicitly pass `--allow-forecast-v2` with `--env staging|production` and the target flag for authorized v2 migration runs. The local inventory gate refuses versions ≥30 before any Wrangler call, even if they may already be applied; remote pending state is not read without opt-in. Existing workflows remain unchanged and therefore fail closed.
- Arrange staging interactions and admin Worker deployment handling in workflows before S5; this local implementation does not authorize those workflow changes or deployments.
- Configure the staging dispatcher with the staging Discord application's bot token, not the production token.

## 8. Known corrections and risks
- Bundle budget naming: 40,000 B is `lazy-certified`; `lazy-solver` is 5,000 B (earlier conversation said "solver 40,000 B").
- Unofficial Naver API may change without notice; search indexes only roughly the first ~200 body characters (A/B/C/D/F rely on title or short bodies; G uses the full list).
- CPU compliance is unproven until S6; request budgets bound requests, not total cost.
- Time Travel restores the whole DB and cannot retract Discord messages.

## §3B Module contracts (Lead, S1)

- Ingest → rules: ingest stores bodies in `forecast_v2_post_versions` and calls `forecast-collector/src/v2/rules/index.ts`:
  `processPostVersion(db, { monitorId, feedId, versionId }, now): Promise<RulesResult>` and `rebuildCalendar(db, now): Promise<{ snapshotId: string | null; changed: boolean }>` (TEXT IDs, matching 0033 and `shared/forecastV2Notifications.ts`); plus `dueEFollowUps(db, now): Promise<number>` (count of unresolved solo reviews requiring E). Each call must fit one invocation (bounded work); `RulesResult` = `{ calendarDirty: boolean; decisionRequests: number; grants: number }`.
- Notification payloads (`forecast_v2_notification_outbox.payload`, JSON), types/validators/renderers in `shared/forecastV2Notifications.ts` (owned by the dispatcher scope; collector imports types only):
  - `b_report`: `{ feedId, title, url, postedAt, extracted: { segments: {kind:"open"|"suspend"|"resume"|"extend"|"reopen"|"close", startAt?: string, endAt?: string}[]; kits: {gameDay, ii, box}[] }, decisionRequestId }`
  - `decision_request`: `{ decisionRequestId, type: "solo_review"|"grant_date"|"collaboration"|"maintenance"|"grant_quantity", feedIds: number[], title, url, options: {id, label}[], expiresAt }`
  - `calendar_changed`: `{ snapshotId, revision, adminUrl, changes: {kind:"solo"|"collaboration"|"maintenance"|"grant", label, change:"added"|"removed"|"changed", before?: string, after?: string}[] }`
  - `decision_reminder`: `{ decisionRequestId }`
- Button/modal custom_id contract (≤ 100 chars): `fv2:<env>:<action>:<decisionRequestId>:<expectedRevision>[:<optionId>]`, env `s|p`, action `opt` (choose decision option), `bok` (B report confirm), `bedit` (open schedule-edit modal), `bno` (B report unrelated); modal submit `fv2m:<env>:<decisionRequestId>:<expectedRevision>`. Interactions reject unknown env/action, env mismatch with the Worker environment, expired or already-resolved requests, and revision mismatch.
- Delivery idempotency: each v2 message embeds a marker `ref:<idempotencyKey>` (footer) and uses `enforce_nonce`; an ambiguous outcome (timeout, 5xx after send, commit failure) is retried with the same nonce within 60 s; later retries first read the target channel's last 50 messages and resend only if no message carries the marker. Legacy title/link escaping in `shared/forecastManualReview.ts` is already correct and is reused, not re-encoded.
- Decision contract (Lead, S1/S2):
  - `forecast_v2_decision_requests.type` ∈ `solo_review | grant_date | collaboration | maintenance | grant_quantity` (same names in the `decision_request` notification payload; `solo_schedule` is renamed `solo_review`). New nullable column `event_id` (calendar event the decision targets; NULL for grant decisions or not-yet-created events).
  - `payload_json` = `{ env: "staging"|"production", eventId: string|null, sourceHash: string(64 hex), sourceVersion: string (post version id; interactions and appliers fence on it atomically), feedIds: number[], title, url, options: {id, label}[], extracted?: { startAt?: string, endAt?: string, segments?: [...§3B b_report segments], kits?: {gameDay, ii, box}[] } }`. `options` empty for `solo_review` (buttons `bok`/`bedit`/`bno`); for other types options are the selectable answers.
  - `expected_calendar_revision` = head revision of `eventId` at request creation (0 if `eventId` is NULL or the event has no head yet). It is the `<expectedRevision>` in custom_ids.
  - `result_json` = `{ action: "opt", optionId } | { action: "bok" } | { action: "bno" } | { action: "edit", startAt, endAt }` plus `{ actorId, decidedAt, expectedRevision }`. Times are ISO instants with `+09:00`.
  - Interactions, in one atomic batch: consume interaction ID; insert result only if request is `pending`, not expired, env matches, and (when `eventId` is set) the event head revision equals `expectedRevision`; set request `resolved`. Interactions never write calendar revisions or `forecast_v2_admin_commands`.
  - Collector (rules) applies each new result on its next invocation, writing calendar/grant revisions and recording `forecast_v2_admin_commands` with `idempotency_key = decision_id` for exactly-once application; a revision conflict marks the result `stale` (new decision request, old message updated by the notification flow).
- Interactions write only `forecast_v2_consumed_interactions`, `forecast_v2_decision_results`, and the request `status` (see Decision contract); collector applies results on its next rules invocation.
- Admin page reads only `forecast_v2_calendar_active` → snapshot → days/event links → revisions.
- Rollback source mapping: deployed collector version `2dc47cb4` must be mapped to its git commit (Cloudflare version metadata / `DEPLOY_SHA`) before S5; prerequisite, not a local task.

## §3A Implemented schema

Local migrations 0030–0033 add only new tables and ledger entries; no legacy table is rebuilt.
- Admin-command decision application: nullable `forecast_v2_admin_commands.event_id` has no head FK, allowing commands to create an event. Nullable `decision_id` is UNIQUE and references `forecast_v2_decision_requests`; `idempotency_key` remains UNIQUE. The INSERT CAS trigger skips head checks for NULL events, requires no head for expected revision 0, and otherwise requires the matching head revision. Commands must be inserted before creating/advancing the head in the same atomic application batch.
- 0030: `forecast_v2_monitors` seeds A/B/C-open/C-reopen/D/E/F/G, board, keyword, API search option and interval. `forecast_v2_monitor_state` stores committed creation time and tie IDs, continuation, generation, leases, holds and separate edit progress. `forecast_v2_monitor_runs`, `forecast_v2_search_hits`, `forecast_v2_post_versions`, `forecast_v2_fetch_attempts`, `forecast_v2_request_budgets`, `forecast_v2_legacy_links` retain traversal/evidence/budget/import identities. Post versions are unique by feed + updated date + content hash; budgets default to 240 metadata/48 detail per game day.
- 0031: `forecast_v2_calendar_revisions` and `forecast_v2_calendar_heads` store typed events, status, exact instants/game days, maintenance revision dependency, prediction provenance and source IDs. Heads advance one revision at a time. `forecast_v2_decision_requests` stores type (`solo_review|grant_date|collaboration|maintenance|grant_quantity`), nullable `event_id`, payload/hash, expected calendar revision, expiry/reminder/status (`pending|resolved|expired|stale`), with an index on `(status, expires_at)`. `event_id` deliberately has no FK so requests can target not-yet-created events. `forecast_v2_decision_results` blocks UPDATE, DELETE and conflicting INSERT/REPLACE. `forecast_v2_admin_commands` has unique idempotency keys and expected-head-revision insertion checks; `forecast_v2_consumed_interactions` has unique interaction IDs.
- 0032: `forecast_v2_grant_observations` stores version/feed, quantities, candidate dates and the six approved date bases. `forecast_v2_grant_revisions`, `forecast_v2_grant_heads` enforce current dedup by game day + II + box, with composite foreign keys binding quantities to the selected revision. `forecast_v2_grant_links` joins observations and legacy grant IDs; revisions link decisions.
- 0033: `forecast_v2_calendar_snapshots`, `forecast_v2_calendar_days`, `forecast_v2_calendar_event_links`, `forecast_v2_calendar_active`, `forecast_v2_calendar_diffs` store projections, immutable identities by range/hash, event revisions, active version fence and semantic differences. Writers must use expected-version predicates and atomic batches.
- Lead exception supersedes A16: separate `forecast_v2_notification_outbox`, not a rebuild of the legacy outbox. Kinds: `b_report`, `decision_request`, `calendar_changed`, `decision_reminder`. Unique idempotency key, snapshot/decision references, approval/activity channel role, payload/hash, legacy-shaped delivery state/attempt/lease/message columns and timestamps.
- Solo history is not seeded here; the source remains `shared/soloRaidCadence.ts`.
- Local migration tests pass, including populated v29 upgrade, rerun, CAS, dedup and immutable decision results. Earlier migration files have no Git diff. Collector validation reaches 337 passing tests but the health test still expects schema 29; its source is outside this task's owned paths. Typecheck stops at stale interactions generated types, also outside owned paths.
- Compatibility: current `8e30e4d` collector checks for presence of versions 23, 28/29 and `>=27`, not a maximum version ceiling (`db.ts`, `runtime-ingestion.ts`, `board11-policy.ts`). These checks still pass at v33; old tables and cursors remain unchanged. Exact rollback-source verification is blocked: local Git does not resolve `2dc47cb4`; the deployed version needs a verified source mapping before claiming that binary was tested. V2-only rows remain inert for legacy readers; no cursor reconciliation/backfill is performed by these migrations.
