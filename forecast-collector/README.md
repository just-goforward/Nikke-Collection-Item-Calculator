# Schedule forecast collector

`collection-kit-forecast-collector` is an isolated Cloudflare Worker that observes official NIKKE
schedule notices and proposes supply-forecast registry updates. It does not serve calculator
statistics and cannot modify the repository or activate a product forecast.

## Sources and cadence

- Every three minutes the Free-plan Worker reads only ten shallow feed records from Naver Lounge
  boards 56 and 48. It queues IDs, titles, timestamps, manager roles, and URLs; it does not parse or
  hash post bodies on the Cron path.
- The offset Dispatcher Worker checks the shared D1 queue at minutes 1, 4, 7, and so on. New work
  is fingerprinted and reserved with a five-minute D1 lease before a repository-scoped GitHub App
  requests `forecast-proposal.yml`. The Actions workflow fetches pending details and accepts only
  official manager posts with structured SmartEditor JSON. It performs schedule parsing, ledger
  resolution, and candidate generation outside the Worker CPU limit.
- The proposal workflow's `17,47 * * * *` schedule is a thirty-minute watchdog, not the normal
  execution path. If it finds actionable work, it records `watchdog_fallback` and processes the work
  without weakening the same approval boundaries.
- Each Naver response is parsed as a complete feed contract. Explicitly recognized ad or banner rows
  may be skipped, but one unknown row shape fails the poll with `naver_partial_schema_drift`. No queue
  insert or cursor advancement from that response is committed.
- A live contract check on 2026-08-25 found that the current board-48, board-56, and Solo Raid detail
  responses use SmartEditor HTML rather than JSON. The JSON-only boundary therefore fails closed to
  `manual_review`; automatic candidate generation remains blocked until a separately reviewed,
  structured Actions-side HTML parser is introduced.
- X is advisory only and runs in GitHub Actions only when a candidate exists. The primary discovery
  path is the official recent-search API with the optional `X_API_BEARER_TOKEN` repository secret.
  Its query is restricted to Solo Raid, collaboration, Co-op Operation, and Kit Box keywords from
  `@NIKKE_kr`, requests at most ten results, and accepts a post only when the response expansion
  verifies the official author ID and username. Solo and collaboration dates can be compared with the
  candidate; Co-op and Kit Box posts are retained only as manual-review URLs.
- Without that secret, or after a transient API failure, the workflow extracts status IDs from the
  server-rendered public profile and verifies each ID through X's structured `tweet-result` embed
  response. It then tries the profile syndication document and Jina Reader. Every structured path
  requires the returned author to be `NIKKE_kr`; Jina is a last advisory fallback, derives
  publication time from the status Snowflake ID, and can never create a conflict by itself.
- [Defuddle](https://github.com/kepano/defuddle) is not used for discovery because it converts an
  already known URL or accessible DOM to clean content. Its async X extractor also calls FxTwitter.
  It can read a known status after discovery, but the live result also included adjacent timeline
  content and its profile Markdown did not retain current status URLs. It would therefore add a
  second lossy representation of text already returned structurally by X API or X embed data.
- An unavailable X page leaves a manual checklist on a normal PR. A matching post adds its status
  link. A conflicting schedule creates a draft `[X 일정 충돌 검토]` PR that cannot be merged until
  a person reviews it.

Configure `X_API_BEARER_TOKEN` as a GitHub Actions repository secret to enable the deterministic
primary path. The token needs read-only access to recent post search; it must not receive post-write,
DM, account-management, or repository permissions. X currently bills the API per resource and has no
monthly minimum, so configure a small prepaid balance and spending alert in the X Developer Console.
The workflow does not fail when the secret is absent, but URL discovery then depends on rate-limited,
undocumented public fallbacks and may require the Discord/PR manual check. Run the redacted source
diagnostic with:

```powershell
$env:X_API_BEARER_TOKEN = "<temporary local token>"
npm run probe:forecast-x
Remove-Item Env:X_API_BEARER_TOKEN
```

The diagnostic prints only source, result count, reason, first status URL, and publication time. It
never prints the token or response bodies.

`[confirmed]` A 2026-08-28 live probe found five exact status IDs in the public profile HTML and
verified all five through `tweet-result`, including author, text, and publication time. During the
same probe, the timeline syndication document and Jina were rate-limited. Defuddle 0.18.1 could read
a known status and display profile text, but the known-status output included adjacent timeline
content and its profile Markdown omitted the five status URLs. This is why raw profile ID discovery
plus structured per-status verification precedes those fallbacks.

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
X/Jina unavailability remains advisory and does not create an independent operations incident.

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
- Canary report v6 uses an independent `canaryId` and the server-recorded run start, not the number
  of rows that happened to reach D1. It generates expected Collector and Dispatcher Cron slots from that start through
  the next D1 daily reset at 00:00 UTC (09:00 KST). Each Worker must deliver and complete at least 99%, miss at most one slot, end completed,
  and have zero abandoned, late, unexpected, or duplicate invocations. Queue, cursor, candidate, watermark, manual
  review, workflow callback, unsent critical alert, Dispatcher smoke, and Router interaction
  invariants must also pass. One signed Router test must respond in under one second. The report also
  embeds hash-checked account-wide D1 evidence from a 30-minute burn-in. The projected account use,
  staging canary allowance, and statistics-production reserve must all pass.
- The four statistics/Forecast production/staging D1 databases share the same Free account limits.
  Migration 0009 covering indexes must be present in both Forecast databases before preflight. The
  preflight uses current Forecast usage plus a bounded allowance instead of carrying forward stale
  p95 values caused by the old unindexed scans. The 30-minute burn-in then projects the measured
  production and staging Forecast rates through that D1 reset with a 2x safety factor.
  `Watch Forecast D1 Budget` repeats that current-rate projection every 30 minutes and disables only
  the staging Collector and Dispatcher when the budget or statistics-production read probe fails.
- If `both` polling cannot pass, `POLL_MODE=alternating` checks one board per invocation (six minutes
  per board) and starts a fresh reset-boundary canary. If that also fails, the Cron trigger is removed and
  `FORECAST_DIRECT_NAVER_POLL=true` makes the thirty-minute watchdog action collect both boards.

## Local verification

```powershell
npm run forecast:types:check
npm run test:forecast-collector
npm run dispatcher:types:check
npm run test:forecast-dispatcher
npm run interactions:types:check
npm run test:forecast-interactions
npm test -- scripts/d1-budget.test.ts scripts/forecast-dispatcher-workflow.spec.ts
npx wrangler deploy --dry-run --env staging --config forecast-collector/wrangler.toml
npx wrangler deploy --dry-run --env staging --config forecast-dispatcher/wrangler.toml
npx wrangler deploy --dry-run --config forecast-interactions/wrangler.toml
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

```powershell
npx wrangler d1 execute FORECAST_DB --remote --env=staging `
  --config forecast-collector/wrangler.toml --file forecast-collector/schema.sql
npx wrangler d1 execute FORECAST_DB --remote --env="" `
  --config forecast-collector/wrangler.toml --file forecast-collector/schema.sql
```

For an existing database, apply the incremental migrations instead of replaying the bootstrap
schema. Migration 0003 adds invocation accounting, shallow cursors, and the source queue. Migration
0004 adds the isolated Discord approval test ledger, migration 0005 adds the staging adoption ledger,
migration 0006 makes staging approval message identity durable, migration 0007 adds Dispatcher
invocation, workflow-dispatch, and grouped operations-alert ledgers, migration 0008 adds manual
review decisions, Discord interaction audit, and legacy v5 deployment evidence, and migration 0009
adds latest-invocation covering indexes plus independent v6 canary runs with D1 quota evidence:

```powershell
npx wrangler d1 execute FORECAST_DB --remote --env=staging `
  --config forecast-collector/wrangler.toml `
  --file forecast-collector/migrations/0002_collector_deployment_sha.sql
npx wrangler d1 execute FORECAST_DB --remote --env="" `
  --config forecast-collector/wrangler.toml `
  --file forecast-collector/migrations/0002_collector_deployment_sha.sql
npx wrangler d1 execute FORECAST_DB --remote --env=staging `
  --config forecast-collector/wrangler.toml `
  --file forecast-collector/migrations/0003_lightweight_source_queue.sql
npx wrangler d1 execute FORECAST_DB --remote --env="" `
  --config forecast-collector/wrangler.toml `
  --file forecast-collector/migrations/0003_lightweight_source_queue.sql
npx wrangler d1 execute FORECAST_DB --remote --env=staging `
  --config forecast-collector/wrangler.toml `
  --file forecast-collector/migrations/0004_discord_approval_tests.sql
npx wrangler d1 execute FORECAST_DB --remote --env=staging `
  --config forecast-collector/wrangler.toml `
  --file forecast-collector/migrations/0005_discord_staging_adoptions.sql
npx wrangler d1 execute FORECAST_DB --remote --env=staging `
  --config forecast-collector/wrangler.toml `
  --file forecast-collector/migrations/0006_discord_staging_message_identity.sql
npx wrangler d1 execute FORECAST_DB --remote --env=staging `
  --config forecast-collector/wrangler.toml `
  --file forecast-collector/migrations/0007_workflow_dispatch_ops.sql
npx wrangler d1 execute FORECAST_DB --remote --env="" `
  --config forecast-collector/wrangler.toml `
  --file forecast-collector/migrations/0007_workflow_dispatch_ops.sql
npx wrangler d1 execute FORECAST_DB --remote --env=staging `
  --config forecast-collector/wrangler.toml `
  --file forecast-collector/migrations/0008_manual_reviews_interactions_canary.sql
npx wrangler d1 execute FORECAST_DB --remote --env="" `
  --config forecast-collector/wrangler.toml `
  --file forecast-collector/migrations/0008_manual_reviews_interactions_canary.sql
npx wrangler d1 execute FORECAST_DB --remote --env=staging `
  --config forecast-collector/wrangler.toml `
  --file forecast-collector/migrations/0009_d1_budget_canary_v6.sql
npx wrangler d1 execute FORECAST_DB --remote --env="" `
  --config forecast-collector/wrangler.toml `
  --file forecast-collector/migrations/0009_d1_budget_canary_v6.sql
```

Migrations 0004 through 0006 are not required in production while Discord approval mode remains
disabled. Migrations 0007 through 0009 are required in both environments.

Required repository variables:

```text
FORECAST_COLLECTOR_STAGING_URL
FORECAST_COLLECTOR_PRODUCTION_URL
FORECAST_COLLECTOR_URL
FORECAST_INTERACTIONS_URL
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
`FORECAST_COLLECTOR_ADMIN_TOKEN`, `DISCORD_FORECAST_BOT_TOKEN`, and the existing scoped
`CLOUDFLARE_API_TOKEN`. A separate `CLOUDFLARE_D1_ANALYTICS_TOKEN` with account analytics read access
is recommended; workflows fall back to the scoped deployment token only when it already has that
permission. The GitHub App is installed only on this repository with `Actions: write`
and implicit `Metadata: read`; its private key belongs only to the Dispatcher deployment.

`FORECAST_COLLECTOR_URL` is an administrator-managed one-time repository variable. Set it to the
production URL only after the first production queue round-trip smoke and idempotent Solo Raid
ledger bootstrap have passed. The workflow `GITHUB_TOKEN` cannot request the repository
`Variables: write` permission, so promotion verifies the configured value instead of mutating it.
Until the variable is present, the proposal workflow skips without failing. Promotion is dispatched
manually after reviewing the completed reset-boundary canary report and remains protected by the
`cloudflare-production` environment.

Promotion compares the canary commit with current `main` only across the collector deployment
inputs covered by the staging workflow path filter. Unrelated application, solver, or documentation
commits therefore neither restart nor invalidate a running canary; any collector-input change does.
