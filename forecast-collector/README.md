# Schedule forecast collector

`collection-kit-forecast-collector` is an isolated Cloudflare Worker that observes official NIKKE
schedule notices and proposes supply-forecast registry updates. It does not serve calculator
statistics and cannot modify the repository or activate a product forecast.

## Sources and cadence

- Every three minutes the Free-plan Worker reads only ten shallow feed records from Naver Lounge
  boards 56 and 48. It queues IDs, titles, timestamps, manager roles, and URLs; it does not parse or
  hash post bodies on the Cron path.
- The five-minute proposal workflow fetches pending details and accepts only official manager posts
  with structured SmartEditor JSON. It performs schedule parsing, ledger resolution, and candidate
  generation outside the Worker CPU limit.
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

After a verified production collector and an approved inactive forecast exist, the dynamic H/p
workflow starts isolated, resumable research slices. It records `productAdoptionAuthorized: false`.
Only a later, manually reviewed adoption PR may activate the forecast or change H/p.

## Discord approval button test

The optional Discord integration is deliberately test-only. A manually dispatched GitHub Actions
workflow posts a bot message with a `테스트 승인` button. Discord sends the button interaction to
the staging collector, which verifies the Ed25519 signature and the configured application, guild,
channel, and approver user IDs. A successful click changes only a row in
`discord_approval_tests` from `pending` to `test_approved`.

It does **not** change a forecast candidate state, approve or merge a pull request, update
`approvedForecastId`, activate a forecast, or start H/p research. The production Wrangler
environment fixes `DISCORD_APPROVAL_MODE` to `disabled`; both the registration and interaction
routes return 404 in production. Test records expire after 30 minutes.

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

Apply migration 0004 to the staging D1 database and deploy the staging collector before configuring
the Discord Interactions Endpoint URL:

```powershell
npx wrangler d1 execute FORECAST_DB --remote --env=staging `
  --config forecast-collector/wrangler.toml `
  --file forecast-collector/migrations/0004_discord_approval_tests.sql
```

Then run `Test Discord Forecast Approval` manually with an existing pull request number. The
workflow checks out trusted `main`, resolves the immutable PR URL and head SHA with a read-only
`GITHUB_TOKEN`, and validates the machine-readable review metadata embedded by the forecast
proposal renderer. The Discord card contains only the X status/profile link, the Solo Raid and
collaboration periods to compare, and a short confirmation instruction. It registers the test
record with the staging collector before posting the button through the Discord bot API. The test
cannot be used as a production approval signal.

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
- `/health` exposes only source status and candidate counts. Candidate payloads and canary evidence
  require a timing-safe bearer token.
- Authenticated endpoints share a dedicated Cloudflare rate-limit namespace per environment and
  reject more than 60 requests per minute from the admin request class.
- Canary report v3 requires at least 12 hours, 200 scheduled invocations, 99% completed, a completed
  latest invocation, zero abandoned rows, and zero invalid queue/cursor/candidate/watermark rows.
  More than 1% abandoned after the first two hours fails early.
- If `both` polling cannot pass, `POLL_MODE=alternating` checks one board per invocation (six minutes
  per board) and starts a fresh 12-hour canary. If that also fails, the Cron trigger is removed and
  `FORECAST_DIRECT_NAVER_POLL=true` makes the five-minute proposal action collect both boards.

## Local verification

```powershell
npm run forecast:types:check
npm run test:forecast-collector
npx wrangler deploy --dry-run --env staging --config forecast-collector/wrangler.toml
```

Remote setup needs two dedicated D1 databases and `ADMIN_TOKEN`. GitHub
uses `FORECAST_COLLECTOR_ADMIN_TOKEN`; it is not a GitHub or Cloudflare write token. Deployment uses
the existing scoped `CLOUDFLARE_API_TOKEN` and account ID.

The scoped CI deployment token needs Workers Scripts edit access but intentionally does not receive
D1 write access. Apply migrations separately with an operator-authenticated Wrangler session before
dispatching a deployment. Production migration and deployment remain separate audited operations;
the deployment stays behind the `cloudflare-production` environment approval. The post-deploy smoke
fails closed when the expected tables are absent.

```powershell
npx wrangler d1 execute FORECAST_DB --remote --env=staging `
  --config forecast-collector/wrangler.toml --file forecast-collector/schema.sql
npx wrangler d1 execute FORECAST_DB --remote --env="" `
  --config forecast-collector/wrangler.toml --file forecast-collector/schema.sql
```

For an existing database, apply the incremental migrations instead of replaying the bootstrap
schema. Migration 0003 adds invocation accounting, shallow cursors, and the source queue. Migration
0004 adds the isolated Discord approval test ledger:

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
```

Migration 0004 is not required in production while Discord approval mode remains disabled.

Required repository variables:

```text
FORECAST_COLLECTOR_STAGING_URL
FORECAST_COLLECTOR_PRODUCTION_URL
FORECAST_COLLECTOR_URL
FORECAST_DIRECT_NAVER_POLL (optional emergency fallback)
```

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
