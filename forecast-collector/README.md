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

## Discord staging adoption approval

`Request Staging Forecast Adoption` verifies a merged inactive forecast PR and its immutable H/p
artifact before posting a Discord button. Discord sends the button interaction to the staging
collector, which verifies the Ed25519 signature and the configured application, guild, channel,
and approver user IDs. A successful click changes one `discord_staging_adoptions` row from
`pending` to `approved`.

The button gives the collector no GitHub token. `Process Staging Forecast Adoption` polls approved
rows with the existing authenticated admin boundary, validates main and the artifact digest again,
creates a non-auto-merged staging evidence PR, and deploys a separate Workers Static Assets site.
The build uses the inactive approved forecast only in its ephemeral staging registry. Production
GitHub Pages and the tracked `activeForecastId` remain unchanged. The production collector fixes
`DISCORD_APPROVAL_MODE` to `disabled`; all Discord approval routes return 404 there. Pending staging
approvals expire after 24 hours.

Create a Discord application and bot in the Discord Developer Portal, install the bot only in the
intended server with `View Channel` and `Send Messages`, and set the application's Interactions
Endpoint URL to:

```text
https://<staging-collector>/discord/interactions
```

Set these values only for the staging collector:

```text
DISCORD_PUBLIC_KEY          Discord application's public key
DISCORD_APPLICATION_ID      Discord application ID
DISCORD_APPROVER_USER_ID    only user allowed to click the approval button
DISCORD_GUILD_ID            only server allowed to deliver the interaction
DISCORD_CHANNEL_ID          only channel allowed to deliver the interaction
```

`DISCORD_PUBLIC_KEY` should be stored as a Worker secret. The numeric IDs are non-secret bindings,
but they still form part of the authorization policy and must be reviewed before deployment. GitHub
Actions additionally needs:

```text
secret: DISCORD_FORECAST_BOT_TOKEN
variable: DISCORD_FORECAST_CHANNEL_ID
```

For the first staging-only trial, storing all five Worker-side values as staging secrets avoids
adding test credentials to tracked Wrangler configuration:

```powershell
npx wrangler secret put DISCORD_PUBLIC_KEY --env staging --config forecast-collector/wrangler.toml
npx wrangler secret put DISCORD_APPLICATION_ID --env staging --config forecast-collector/wrangler.toml
npx wrangler secret put DISCORD_APPROVER_USER_ID --env staging --config forecast-collector/wrangler.toml
npx wrangler secret put DISCORD_GUILD_ID --env staging --config forecast-collector/wrangler.toml
npx wrangler secret put DISCORD_CHANNEL_ID --env staging --config forecast-collector/wrangler.toml
```

Apply migrations 0004 through 0006 to the staging D1 database and deploy the staging collector before
configuring the Discord Interactions Endpoint URL:

```powershell
npx wrangler d1 execute FORECAST_DB --remote --env=staging `
  --config forecast-collector/wrangler.toml `
  --file forecast-collector/migrations/0004_discord_approval_tests.sql
npx wrangler d1 execute FORECAST_DB --remote --env=staging `
  --config forecast-collector/wrangler.toml `
  --file forecast-collector/migrations/0005_discord_staging_adoptions.sql
npx wrangler d1 execute FORECAST_DB --remote --env=staging `
  --config forecast-collector/wrangler.toml `
  --file forecast-collector/migrations/0006_discord_staging_message_identity.sql
```

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
- `/health` exposes only source status, candidate counts, and redacted Dispatcher health: the latest
  invocation, actionable work count, oldest pending age, recent dispatch state, and open/unsent alert
  counts. Candidate payloads and canary evidence require a timing-safe bearer token.
- Authenticated endpoints share a dedicated Cloudflare rate-limit namespace per environment and
  reject more than 60 requests per minute from the admin request class.
- Canary report v4 evaluates Collector and Dispatcher independently. Each must cover at least 12
  hours and 200 scheduled invocations, complete at least 99%, finish with a completed latest
  invocation, and have zero abandoned rows. The combined report also requires zero duplicate
  dispatches, duplicate GitHub run identities, invalid dispatch states, invalid
  queue/cursor/candidate/watermark rows, and broken smoke callback/Discord links. More than 1%
  abandoned after the first two hours fails early.
- If `both` polling cannot pass, `POLL_MODE=alternating` checks one board per invocation (six minutes
  per board) and starts a fresh 12-hour canary. If that also fails, the Cron trigger is removed and
  `FORECAST_DIRECT_NAVER_POLL=true` makes the thirty-minute watchdog action collect both boards.

## Local verification

```powershell
npm run forecast:types:check
npm run test:forecast-collector
npm run dispatcher:types:check
npm run test:forecast-dispatcher
npx wrangler deploy --dry-run --env staging --config forecast-collector/wrangler.toml
npx wrangler deploy --dry-run --env staging --config forecast-dispatcher/wrangler.toml
```

Remote setup needs two dedicated D1 databases and `ADMIN_TOKEN`. GitHub
uses `FORECAST_COLLECTOR_ADMIN_TOKEN`; it is not a GitHub or Cloudflare write token. Deployment uses
the existing scoped `CLOUDFLARE_API_TOKEN` and account ID.

The scoped CI deployment token needs Workers Scripts edit and D1 edit access because the staging and
production deployment workflows apply idempotent schema migrations before deploying either Worker.
Production migration and deployment remain one environment-protected audited job behind the
`cloudflare-production` approval. The post-deploy smoke fails closed when the expected tables are
absent. Do not reuse a broad local Wrangler OAuth credential in CI.

```powershell
npx wrangler d1 execute FORECAST_DB --remote --env=staging `
  --config forecast-collector/wrangler.toml --file forecast-collector/schema.sql
npx wrangler d1 execute FORECAST_DB --remote --env="" `
  --config forecast-collector/wrangler.toml --file forecast-collector/schema.sql
```

For an existing database, apply the incremental migrations instead of replaying the bootstrap
schema. Migration 0003 adds invocation accounting, shallow cursors, and the source queue. Migration
0004 adds the isolated Discord approval test ledger, migration 0005 adds the staging adoption ledger,
migration 0006 makes staging approval message identity durable, and migration 0007 adds Dispatcher
invocation, workflow-dispatch, and grouped operations-alert ledgers:

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
```

Migrations 0004 through 0006 are not required in production while Discord approval mode remains
disabled. Migration 0007 is required in both environments.

Required repository variables:

```text
FORECAST_COLLECTOR_STAGING_URL
FORECAST_COLLECTOR_PRODUCTION_URL
FORECAST_COLLECTOR_URL
FORECAST_DIRECT_NAVER_POLL (optional emergency fallback)
FORECAST_GITHUB_APP_ID
FORECAST_GITHUB_APP_INSTALLATION_ID
DISCORD_FORECAST_CHANNEL_ID
```

Required repository secrets are `FORECAST_GITHUB_APP_PRIVATE_KEY`,
`FORECAST_COLLECTOR_ADMIN_TOKEN`, `DISCORD_FORECAST_BOT_TOKEN`, and the existing scoped
`CLOUDFLARE_API_TOKEN`. The GitHub App is installed only on this repository with `Actions: write`
and implicit `Metadata: read`; its private key belongs only to the Dispatcher deployment.

`FORECAST_COLLECTOR_URL` is an administrator-managed one-time repository variable. Set it to the
production URL only after the first production queue round-trip smoke and idempotent Solo Raid
ledger bootstrap have passed. The workflow `GITHUB_TOKEN` cannot request the repository
`Variables: write` permission, so promotion verifies the configured value instead of mutating it.
Until the variable is present, the proposal workflow skips without failing. Promotion is dispatched
manually after reviewing the completed 12-hour canary report and remains protected by the
`cloudflare-production` environment.

Promotion compares the canary commit with current `main` only across the collector deployment
inputs covered by the staging workflow path filter. Unrelated application, solver, or documentation
commits therefore neither restart nor invalidate a running canary; any collector-input change does.
