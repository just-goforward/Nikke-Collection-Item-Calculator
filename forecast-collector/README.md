# Schedule forecast collector

[D1 Time Travel recovery runbook (Korean)](../docs/d1-time-travel-recovery-runbook.md)

`collection-kit-forecast-collector` is an isolated Cloudflare Worker that observes official NIKKE
schedule notices and proposes supply-forecast registry updates. It does not serve calculator
statistics and cannot modify the repository or activate a product forecast.

## Sources and cadence

### Staging CPU profiling

`COLLECTOR_PROFILE_PHASE` defaults to `off` and is ignored outside staging.
Use `alternate`, `poll-only`, `board-48`, `board-56`, or `ingest-only` to isolate scheduled
work for invocation-level tail `cpuTime`; timers are not CPU measurements.
Ingestion requires the latest non-board collection to have completed within six
minutes, with no ingestion run started at or after its finish;
partial-board profiling cannot admit ingestion. Guards, leases and quotas remain
active. Restore `off` after profiling. Profile logs contain counts, not notice content.
Body bytes count UTF-8 bytes of successfully read detail responses, not rejected
or incomplete bodies; counting adds profiling-only CPU overhead.

Never profile during an active staging canary window. Profiling invocation IDs
are excluded from canary evidence; health still reports the real deployment SHA.
Prefer one staging deployment with `--var COLLECTOR_PROFILE_PHASE:alternate`:
even three-minute slots poll, odd slots ingest subject to admission. This gives
10 polling and up to 10 admitted ingestion samples/hour (240 each/day).
The two/day notice reservation quota permits at most two body requests/day:
usually one or two nonempty ingestion samples; remaining samples are empty or
skipped, and failures may consume reservations. Do not raise the quota for profiling.
The phase is a manual `--var` override reverted by automated redeploys. Restore
`--var COLLECTOR_PROFILE_PHASE:off` explicitly when finished.

- Every three minutes the Collector Worker reads only ten shallow feed records from Naver Lounge
  boards 56 and 48. It queues IDs, titles, timestamps, manager roles, and URLs; it does not parse or
  hash post bodies on the Cron path.
- The offset Dispatcher Worker checks the shared D1 queue at minutes 1, 4, 7, and so on. New work
  is fingerprinted and reserved with a five-minute D1 lease before a repository-scoped GitHub App
  requests `forecast-proposal.yml`. The Actions workflow fetches pending details and accepts only
  official manager posts with structured SmartEditor JSON or a validated SmartEditor HTML envelope.
  It performs schedule parsing, ledger
  resolution, and candidate generation outside the Worker CPU limit.
- The proposal workflow's `17,47 * * * *` schedule is a thirty-minute watchdog, not the normal
  execution path. If it finds actionable work, it records `watchdog_fallback` and processes the work
  without weakening the same approval boundaries.
- Each Naver response is parsed as a complete feed contract. Explicitly recognized ad or banner rows
  may be skipped, but one unknown row shape fails the poll with `naver_partial_schema_drift`. No queue
  insert or cursor advancement from that response is committed.
- The Actions-side detail adapter validates board/feed identity and the official manager role, then
  accepts HTML only when both `SE_DOC_HEADER_START` and the `se-viewer` container are present. It
  removes comments and script/style/template contents before normalizing text into the same
  structured input consumed by the schedule parser. Arbitrary HTML, empty content, and ambiguous
  schedules still require manual review. The Worker Cron does not perform this body conversion.
- X is advisory only and runs in GitHub Actions only when a candidate exists. The FxTwitter path is
  currently withheld: the official numeric author ID and provider response contract must be verified
  before activation. It returns `author_identity_unverified` with zero requests while withheld.
- Once independently cleared, the bounded adapter allows one ten-entry timeline, at most one public
  X profile HTML request for status-ID discovery only, and at most ten detail requests shared across
  both paths: at most twelve requests total, without retries or redirects. Responses must satisfy
  author, ID, timestamp, raw-text, timeout and body-size guards.
- [Defuddle](https://github.com/kepano/defuddle) is not used for discovery because it converts an
  already known URL or accessible DOM to clean content. Its async X extractor also calls FxTwitter.
  It can read a known status after discovery, but the live result also included adjacent timeline
  content and its profile Markdown did not retain current status URLs. It would therefore add a
  second lossy representation rather than an independent official confirmation.
- Incomplete evidence creates a draft `[X 수동 확인 대기]` PR; conflicts take precedence over matches
  and create a draft `[X 일정 충돌 검토]` PR. A third-party match does not mark the official X
  checklist complete. A person must perform the manual X review and explicitly mark the PR ready
  before H/p research or the Discord approval test; re-proposing can return the PR to draft.

Do not restore paid recent-search calls as a rollback. Use a forward fix or manual, non-paid review,
and retain parsing support for both historical metadata and the new `fxtwitter` /
`author_identity_unverified` values already stored in PRs. This change does not delete repository
secrets or authorize provider activation. Run the local diagnostic with:

```powershell
npm run probe:forecast-x
```

While withheld, the diagnostic cannot supply a verified status URL; the workflow's status-URL check
therefore fails as expected. It is not evidence of a live provider outage or a successful probe.

The diagnostic prints only source, result count, reason, first status URL, and publication time. It
does not use a paid-X token or print response bodies.

`[historical]` A 2026-08-28 live probe found five exact status IDs in the public profile HTML and
verified all five through `tweet-result`, including author, text, and publication time. During the
same probe, the timeline syndication document and Jina were rate-limited. Defuddle 0.18.1 could read
a known status and display profile text, but the known-status output included adjacent timeline
content and its profile Markdown omitted the five status URLs. Those tweet-result, syndication and
Jina fallback paths have since been replaced; this probe does not validate the current FxTwitter
provider contract or current profile-HTML behavior.

The Naver cursor walks one overlapping page per invocation when more than ten posts arrived between
polls. Queue insertion and cursor advancement share one D1 batch, and `(source, itemId)` is unique.
The evidence watermark advances only after GitHub Actions has parsed and validated the post; a
failed action therefore cannot skip evidence.

## Forecast contract

The game day changes at 05:00 KST. Profiles use a Solo-day-3-pivoted supply reference. Solo days 1
and 2 accumulate expected supply from the previous round's day 3 through the current day. From day
3 onward, the reference covers the current game day through the current round's end and the next
round's days 1 and 2; between rounds it covers the current game day through the next day 2.
The previous profile remains active through 04:59:59 and the next game-day profile starts exactly
at 05:00:00.
Confirmed new-round cadence is measured between 05:00 KST game-day starts. When no official future
schedule exists, the median of every reconciled new-round start since round 1 is used. Interrupted
and reopened segments remain part of the original round. The tracked 40-round census currently has
39 intervals and a 28-day median; newly confirmed rounds are appended before recalculation.

The rules are versioned as `schedule-kit-v2` and `dispatch-policy-v1`. Dispatch mixes no-reroll,
one-reroll, and two-reroll cohorts equally. Its independently enumerated daily expectation is:

```text
blue   8.947399682
purple 2.014546824
yellow 0.714208160
```

Each candidate records source IDs, URLs, excerpts, hashes, schedule status, cadence, Solo periods,
confirmed collaboration periods, and the complete sequence of gain profiles. Co-op shop supply is
always five Kit Box II rewards at every Tuesday 05:00 in the reference window, regardless of
individual Co-op Operation dates. A Tuesday reset is doubled to ten only when it falls inside a
published official collaboration period; missing, estimated, or ambiguous collaboration dates keep
the base five-box amount. Full source bodies are not retained.

## State and approval boundary

Candidate states are restricted to:

```text
observed -> parsed -> crosschecked | x_unavailable | conflict
                         -> proposed -> approved | rejected | superseded
```

The Worker only exposes pending candidates through an authenticated read endpoint. The proposal
workflow validates the schema, payload hash, URL allowlist, dates, rules version, profile
continuity, and non-negative finite gains again before creating an
`automation/supply-forecast/<candidateId>` pull request.
Merging that PR sets `approvedForecastId` but leaves `activeForecastId` unchanged.

The proposal and staging-adoption workflows explicitly request the full `pages.yml` verification
after pushing their automation branch. This avoids relying on a new pull-request event from
`GITHUB_TOKEN`. The helper validates the branch namespace and pushed SHA, supports GitHub's 200
response with a run ID and the older 204 response, and confirms a matching workflow-dispatch run.
Manual verification never uploads or deploys Pages; those steps remain limited to a push on main.
Generated Forecast files still pass codegen equality checks even when the registry exceeds the
handwritten-file line limit.

## HTTP ownership

`src/worker.ts` owns scheduled execution and delegates requests to `src/http.ts`. HTTP handling keeps
public routes separate from the administrator chain: IP pre-limit, timing-safe Bearer authentication,
method/route-group rate limit, and quota guard. `admin-router.ts` then dispatches to the operations,
source/manual-review, canary, and Discord-administration route groups. These modules do not bypass
the shared security chain or redefine production/staging authorization.

## Event dispatch and operations alerts

`collection-kit-forecast-dispatcher` is a second Worker with no public route. It shares the Forecast
D1 database but has a separate CPU invocation from the Naver collector. Its GitHub target is fixed
in code to this repository, `forecast-proposal.yml`, and `main`; source titles, URLs, or bodies can
never select a repository, workflow, ref, branch, or shell argument.

The GitHub App is named `NIKKE Forecast Dispatcher`, is installed only on this repository, has
`Actions: write` plus implicit `Metadata: read`, and has webhooks disabled. The private key and the
Discord bot token are Dispatcher Worker secrets. Installation tokens are minted for one dispatch
and are never written to D1, logs, GitHub summaries, or Discord.

Each request uses a deterministic three-minute slot ID and a D1 owner lease. An accepted request is
reported as "execution request accepted", never as a completed run. A dispatched workflow calls the
Collector at start and finish with its fixed GitHub run URL; retransmission from the same run is
idempotent, while a second run identity is rejected. A smoke request is staging-only and performs
the callback and Discord path without reading the queue or changing candidates or repository files.

The Dispatcher sends concise Discord notices for accepted work and grouped operations alerts for
GitHub authentication or dispatch errors, workflow failures, Collector circuit-open state, stale
pending work, manual review transitions, invalid callbacks, and unsent critical alerts. Mentions are
always disabled. The same alert fingerprint sends at most once per thirty minutes unless a new
occurrence arrives; one green recovery notice is sent after a previously reported alert resolves.
X/FxTwitter unavailability remains advisory and does not create an independent operations incident.

After a verified production collector and an approved inactive forecast exist, the dynamic H/p
workflow runs only by explicit dispatch. It records `productAdoptionAuthorized: false`; merging an
inactive forecast no longer starts the expensive study again. A verified exact-gate certificate is
required before staging adoption can be requested.

## Discord interactions and manual review

`Request Staging Forecast Adoption` verifies a merged inactive forecast PR and its immutable H/p
artifact before posting a Discord button. Discord sends every component interaction to the dedicated
`collection-kit-forecast-interactions` Router. The Router has no Cron, GitHub key, Collector admin
token, or Discord bot token. It verifies the Ed25519 signature and the configured application,
guild, channel, and approver user IDs, then selects only the staging or production D1 named by the
opaque custom ID. The old Collector interaction route is disabled after Router readiness succeeds.
The Router and legacy compatibility route both consume `shared/discordInteraction.ts` for request
size, Ed25519 signature, five-minute freshness, payload parsing, and custom-ID constants. Collector
D1 mutations, manual-review decisions, and operations alerts remain Collector-owned rather than
moving into that neutral contract.

The button gives the Router no GitHub token. `Process Staging Forecast Adoption` polls approved
rows with the existing authenticated admin boundary, validates main and the artifact digest again,
and creates a non-auto-merged staging evidence PR. After that PR is merged and the normal static site
is deployed, `https://nikkecollection.com/?statsEnv=staging` reads `stagingForecastId`; the query-free
production path continues to read `activeForecastId`. No separate Forecast staging Static Assets
site is operated. Pending staging approvals expire after 24 hours.

Queue items that cannot be safely parsed create one `source_manual_reviews` row per generation and
one alert-channel card. `재처리` returns the queue item to `pending`; `관련 없음` records it as
`ignored`. A date-bearing `manual_event` is deliberately unavailable as a Discord button and must be
submitted through `Resolve Forecast Manual Review`, with structured fields and
`cloudflare-production` approval in production. All decisions are request-ID and payload-hash
idempotent; a reused request ID with different input is rejected.

Create a Discord application and bot, install the bot only in the intended server with `View
Channel` and `Send Messages`, and set the application's single Interactions Endpoint URL to:

```text
https://<forecast-interactions-router>/discord/interactions
```

The deployment workflow reads the application ID and public key from Discord's authenticated Bot
API, requires them to match the repository variables, and then passes them to the Router. Discord
identity and policy values are repository variables:

```text
DISCORD_FORECAST_GUILD_ID
DISCORD_FORECAST_APPROVER_USER_ID
DISCORD_FORECAST_APPLICATION_ID
DISCORD_FORECAST_PUBLIC_KEY
DISCORD_FORECAST_APPROVAL_CHANNEL_ID
DISCORD_FORECAST_ALERT_CHANNEL_ID
DISCORD_FORECAST_ACTIVITY_CHANNEL_ID
DISCORD_FORECAST_FALLBACK_CHANNEL_ID
DISCORD_FORECAST_CHANNEL_ID (legacy fallback during migration)
FORECAST_INTERACTIONS_URL
```

`DISCORD_FORECAST_BOT_TOKEN` remains a Dispatcher/Actions secret and is not present in the Router.
The first workflow run may deploy the Router before `FORECAST_INTERACTIONS_URL` exists; it keeps the
Dispatcher disabled and does not start a canary. After registering the emitted Router origin as the
repository variable and Discord Endpoint URL, manually rerun `Deploy Forecast Collector Staging`
with `router_endpoint_ready=true`.

Then run `Request Staging Forecast Adoption` with the merged inactive forecast PR number and the
successful dynamic H/p run ID. The card uses a formal system voice, shows only the schedule/X
review, exact-gate certificate summary, and staging-only effect, and registers the approval before
posting the button. The scheduled processor creates the staging adoption PR only after that button
is clicked. Neither workflow can merge the PR or authorize production adoption.

## Failure behavior

- Responses are capped at 2 MB and fetched with a 10-second timeout.
- Network errors and server errors receive one immediate retry.
- Three consecutive Naver failures open a circuit with exponential backoff capped at 30 minutes.
- Each scheduled invocation is inserted as `running` before polling. A row still running after 15
  minutes is counted as `abandoned`, so a hard CPU termination cannot disappear from the canary.
- Queue processing is idempotent. Retryable detail failures remain pending and the third failed
  attempt becomes `manual_review`; structurally unsupported detail bodies become `manual_review`
  immediately instead of being silently ignored.
- Empty feeds, malformed JSON, schema drift, unofficial posts, ambiguous schedule changes, inverted
  periods, non-finite gains, discontinuous profiles, and out-of-range cadence never delete or
  activate a forecast.
- Request and response limits use a streaming reader: `Content-Length` is checked first, and a
  chunked body is cancelled as soon as its accumulated bytes exceed the configured cap.
- `/health` exposes only source status, candidate counts, and redacted Dispatcher health: the latest
  invocation, actionable work count, oldest pending age, recent dispatch state, and open/unsent alert
  counts. Candidate payloads and canary evidence require a timing-safe bearer token.
- Admin abuse is limited first by unauthenticated request IP, then timing-safe bearer verification,
  then by authenticated HTTP-method and route group. Discord interaction limits are separate.
- Canary report v10 uses an independent `canaryId` and the server-recorded run start, not the number
  of rows that happened to reach D1. It generates expected Collector and Dispatcher Cron slots for a
  fixed eight-hour window. Each Worker must deliver and complete at least 99%, miss at most one slot, end completed,
  and have zero abandoned, late, unexpected, or duplicate invocations. Queue, cursor, candidate, watermark, manual
  review, workflow callback, unsent critical alert, Dispatcher smoke, and Router interaction
  invariants must also pass. One signed Router test must respond in under one second. The report also
  embeds hash-checked Workers Paid evidence from a 30-minute burn-in. Current and projected monthly
  utilization must remain below the 25% warning threshold. Monthly request and CPU totals remain
  billing-period evidence. Runtime safety and performance use Workers Observability invocation
  records filtered to the exact window and `scheduled` event type. The canary row pins each Wrangler
  `Current Version ID`; Observability version IDs and tags are checked when present. Because Cloudflare
  defines those metadata fields as optional, omitted metadata falls back to the deployment marker and
  matching D1 Cron slot with an explicit warning. Staging log head sampling is pinned to `1.0`.
  Structured marker coverage below 99% is `incomplete`, not a manufactured runtime failure.
  Cloudflare may retain a marker while omitting that invocation's runtime summary, so CPU
  distributions require at least 95% coverage and 100 samples; 95-99% is reported as a performance
  warning and exact-window GraphQL runtime totals remain the hard check for errors and CPU
  terminations. CPU-limit termination or an unsuccessful outcome is a hard failure; p99 at 80%
  or 95% of the configured limit is a warning while `exceededCpu` remains zero.
- The first v10 certificate is a `baseline_bootstrap`. Its generated candidate is an Actions artifact,
  not an automatic policy change. A later baseline can only be adopted by a separate review that adds
  `forecast-collector/runtime-baseline.json`. The retained
  `forecast-canary-baseline-bootstrap.evidence.json` is a projection wrapper: adopt the reviewed
  `.data`, not the whole wrapper, after checking `projectionHash` with the same canonical hashing
  convention and separately reviewing the certified run, SHA and canary-window provenance. The
  projection hash proves internal consistency, not authenticity; the original `sourceHash` cannot
  be recomputed from redacted data. Existing review and certification gates remain mandatory.
  With an approved baseline, CPU regression is hard only when full-window p95 and
  average both exceed their thresholds and both independent four-hour halves regress in the same
  direction. The exact eight-hour invocation query is split into bounded 30-minute windows and merged
  by hashed request identity so one oversized response cannot separate a custom marker from its
  runtime summary. Conflicting duplicates are rejected. Final telemetry is retried every five minutes
  for up to 30 minutes; persistent API or
  ingestion gaps produce `incomplete`, and the immutable window may be queried again without
  restarting the Worker canary.
  A custom marker without a sampled invocation summary is retained as identity evidence with a missing
  CPU sample rather than discarded. Marker and CPU-sample coverage are therefore reported separately.
- The 30-minute budget watchdog reads the lightweight `/admin/canary-window` endpoint. It builds
  bounded intermediate reports at two, four, and six hours; final evaluation posts the
  separately measured exact-window quota evidence after the runtime retry loop. This keeps the final
  evidence inside its freshness contract while monitoring
  traffic from dominating the Collector CPU distribution being certified.
- The statistics, Forecast, and quota-guard databases share one Workers Paid account allowance.
  Migration 0009 covering indexes must be present in both Forecast databases before preflight. The
  dedicated Usage Guard verifies the Paid subscription and billing period, aggregates every Worker
  and D1 resource in the account, and projects month-end usage using the maximum of daily p95, recent
  rate, and period average with a 2x safety factor. `Watch Forecast D1 Budget` independently repeats
  the preflight every 30 minutes. A warning is emitted at 25%; staging is disabled at 35%, production
  Forecast automation at 40%, statistics writes at 45%, and optional D1/Cron work at 50%.
- If `both` polling cannot pass, `POLL_MODE=alternating` checks one board per invocation (six minutes
  per board) and starts a fresh fixed eight-hour canary. If that also fails, the Cron trigger is removed and
  `FORECAST_DIRECT_NAVER_POLL=true` makes the thirty-minute watchdog action collect both boards.

## Local verification

```powershell
npm run forecast:types:check
npm run test:forecast-collector
npm run dispatcher:types:check
npm run test:forecast-dispatcher
npm run interactions:types:check
npm run test:forecast-interactions
npm run usage-guard:types:check
npm run test:usage-guard
npm test -- scripts/d1-budget.test.ts scripts/cloudflare-paid-quota-config.test.ts scripts/forecast-dispatcher-workflow.spec.ts
npx wrangler deploy --dry-run --env staging --config forecast-collector/wrangler.toml
npx wrangler deploy --dry-run --env staging --config forecast-dispatcher/wrangler.toml
npx wrangler deploy --dry-run --config forecast-interactions/wrangler.toml
npx wrangler deploy --dry-run --config usage-guard/wrangler.toml
```

Remote setup needs two dedicated D1 databases and `ADMIN_TOKEN`. GitHub
uses `FORECAST_COLLECTOR_ADMIN_TOKEN`; it is not a GitHub or Cloudflare write token. Deployment uses
the existing scoped `CLOUDFLARE_API_TOKEN` and account ID.

The scoped CI deployment token needs Workers Scripts edit and D1 edit access because the staging and
production deployment workflows apply idempotent schema migrations before deploying either Worker.
The one-time `Remediate Forecast D1 Indexes` workflow applies migration 0009 to production behind the
`cloudflare-production` approval, verifies both latest-query plans, and does not deploy a Worker.
Production deployment remains a separate environment-protected audited job. The post-deploy smoke
fails closed when the expected tables are absent. Do not reuse a broad local Wrangler OAuth
credential in CI.

Both deployment workflows use `scripts/apply-forecast-d1-migrations.ts`. The runner validates the
ordered incremental files and `schema_migrations`, applies only missing required versions, and
re-reads the ledger after every applied file. Unknown or gapped histories stop deployment. It does
not repair an out-of-band or partially applied schema change.

`schema.sql` is the version-21 bootstrap snapshot, not migration 0001 or the complete latest schema.
The runner uses it only after
confirming the database contains no application tables or views. Never replay it over an existing
database. Existing production histories may omit Discord-only versions 0004..0006; version 0006,
when present, still requires 0005. A fresh installation first records versions 1–21 from the snapshot,
then applies migrations 0022–0024 in order. Runtime ingestion/publication tests must load those
incremental migrations too; loading `schema.sql` alone does not install runtime publication guards.

Migration 0003 adds invocation accounting, shallow cursors, and the source queue; 0004..0006 add
Discord approval/test message identity; 0007 adds dispatch and operations ledgers; 0008 adds manual
review and interaction audit; 0009 adds covering indexes and independent canary storage; 0010 adds
the script-version identities used by the current canary contract. SQL files remain the schema
authority.

For a local-only clean installation or restart check:

```powershell
node scripts/apply-forecast-d1-migrations.ts --env staging --local
```

The runner requires an explicit environment and exactly one of `--local` or `--remote`; it never
defaults to a remote target. Remote staging applies through `Deploy Forecast Collector Staging`.
Remote production applies only through the protected `Promote Forecast Collector` job after its
canary and `cloudflare-production` approval. Existing workflow concurrency is unchanged.

Required repository variables:

```text
FORECAST_COLLECTOR_STAGING_URL
FORECAST_COLLECTOR_PRODUCTION_URL
FORECAST_COLLECTOR_URL
FORECAST_INTERACTIONS_URL
CLOUDFLARE_USAGE_GUARD_URL
FORECAST_DIRECT_NAVER_POLL (optional emergency fallback)
FORECAST_GITHUB_APP_ID
FORECAST_GITHUB_APP_INSTALLATION_ID
DISCORD_FORECAST_CHANNEL_ID
DISCORD_FORECAST_APPROVAL_CHANNEL_ID
DISCORD_FORECAST_ACTIVITY_CHANNEL_ID
DISCORD_FORECAST_ALERT_CHANNEL_ID
DISCORD_FORECAST_FALLBACK_CHANNEL_ID
DISCORD_FORECAST_GUILD_ID
DISCORD_FORECAST_APPROVER_USER_ID
DISCORD_FORECAST_APPLICATION_ID
DISCORD_FORECAST_PUBLIC_KEY
```

Required repository secrets are `FORECAST_GITHUB_APP_PRIVATE_KEY`,
`FORECAST_COLLECTOR_ADMIN_TOKEN`, `DISCORD_FORECAST_BOT_TOKEN`, the scoped
`CLOUDFLARE_API_TOKEN`, a dedicated `CLOUDFLARE_D1_ANALYTICS_TOKEN`, and a separate
`CLOUDFLARE_BILLING_READ_TOKEN` limited to `Account > Billing > Read`. Deployment credentials are
never used as an analytics or billing-token fallback. The GitHub App is installed only on this repository with `Actions: write`
and implicit `Metadata: read`; its private key belongs only to the Dispatcher deployment.

`FORECAST_COLLECTOR_URL` is an administrator-managed one-time repository variable. Set it to the
production URL only after the first production queue round-trip smoke and idempotent Solo Raid
ledger bootstrap have passed. The workflow `GITHUB_TOKEN` cannot request the repository
`Variables: write` permission, so promotion verifies the configured value instead of mutating it.
Until the variable is present, the proposal workflow skips without failing. Promotion is dispatched
manually after reviewing a v10 `passed` or `passed_with_warning` certificate and remains protected by the
`cloudflare-production` environment.

Promotion compares the canary commit with current `main` only across the collector deployment
inputs covered by the staging workflow path filter. Unrelated application, solver, or documentation
commits therefore neither restart nor invalidate a running canary; any collector-input change does.

## Renew a manual review after a Discord channel migration

This authenticated operation mutates only the selected unresolved review and its
queue generation and alert. Obtain explicit environment-specific mutation and
Discord-delivery approval first. Do not use it to override a resolved decision.
The old review is retained as expired, with the renewal request ID and reason.
The dispatcher discovers the new generation and reopens the retained alert with
a fresh delivery identity; old message bindings are cleared immediately.

```powershell
$body = @{
  environment = "staging"
  expectedGeneration = 0
  requestId = "mrq-" + [guid]::NewGuid().ToString("N")
  reason = "Renew review for isolated staging alert channel"
} | ConvertTo-Json
Invoke-RestMethod -Method Post `
  -Uri "$CollectorUrl/admin/manual-reviews/$ReviewId/renew" `
  -Headers @{ Authorization = "Bearer $AdminToken" } `
  -ContentType "application/json" -Body $body
```

Use the exact opaque review ID and current generation from inspection. For
production, explicitly select the production collector URL, credentials and
`environment = "production"`; never reuse staging targeting.
Retain the same body/request ID for retries; changed payloads with that ID fail.
No SQL or alert deletion is required. Renewal does not approve a schedule or
create a candidate. Wait for delivery before clicking the replacement message.
