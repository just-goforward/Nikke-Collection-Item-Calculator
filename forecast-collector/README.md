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
- X is advisory only and runs in GitHub Actions only when a candidate exists. The workflow tries the
  official embedded profile, the public profile, and then Jina Reader once. It uses no X API, RSS
  bridge, login session, cookie, Nitter instance, or private syndication endpoint.
- [Defuddle](https://github.com/kepano/defuddle) is not used because it extracts content from an
  already accessible DOM and its optional async X fallback uses FxTwitter. [Jina
  Reader](https://jina.ai/reader/) successfully returned the public profile in a live
  preflight, but it is an external fetch/cache intermediary and is not accepted as authoritative
  schedule evidence. A Jina match always leaves manual X verification unchecked, and a transformed
  Jina response can never create a conflict by itself.
- An unavailable X page leaves a manual checklist on a normal PR. A matching post adds its status
  link. A conflicting schedule creates a draft `[X 일정 충돌 검토]` PR that cannot be merged until
  a person reviews it.

The Naver cursor walks one overlapping page per invocation when more than ten posts arrived between
polls. Queue insertion and cursor advancement share one D1 batch, and `(source, itemId)` is unique.
The evidence watermark advances only after GitHub Actions has parsed and validated the post; a
failed action therefore cannot skip evidence.

## Forecast contract

The game day changes at 05:00 KST. The current game day's rewards are assumed to have already been
received and opened; profiles contain only future rewards through the next Solo Raid day-3 cutoff.
Confirmed new-round cadence is measured between 05:00 KST game-day starts. When no official future
schedule exists, the median of the latest six valid 21-35 day intervals is used.

The rules are versioned as `schedule-kit-v1` and `dispatch-policy-v1`. Dispatch mixes no-reroll,
one-reroll, and two-reroll cohorts equally. Its independently enumerated daily expectation is:

```text
blue   8.947399682
purple 2.014546824
yellow 0.714208160
```

Each candidate records source IDs, URLs, excerpts, hashes, schedule status, cadence, collaboration
periods, and the complete sequence of gain profiles. Full source bodies are not retained.

## State and approval boundary

Candidate states are restricted to:

```text
observed -> parsed -> crosschecked | x_unavailable | conflict
                         -> proposed -> approved | rejected | superseded
```

The Worker only exposes pending candidates through an authenticated read endpoint. The proposal
workflow validates the schema, payload hash, URL allowlist, dates, rules version, and profile
monotonicity again before creating an `automation/supply-forecast/<candidateId>` pull request.
Merging that PR sets `approvedForecastId` but leaves `activeForecastId` unchanged.

After a verified production collector and an approved inactive forecast exist, the dynamic H/p
workflow starts isolated, resumable research slices. It records `productAdoptionAuthorized: false`.
Only a later, manually reviewed adoption PR may activate the forecast or change H/p.

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
  periods, non-finite gains, non-monotone profiles, and out-of-range cadence never delete or
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

The scoped deployment token needs Workers Scripts edit access and D1 edit access limited to this
account's dedicated forecast databases. Staging migration 0003 runs before the staging deployment;
production migration and deployment remain behind the `cloudflare-production` environment
approval. The post-deploy smoke fails closed when the expected tables are absent.

```powershell
npx wrangler d1 execute FORECAST_DB --remote --env=staging `
  --config forecast-collector/wrangler.toml --file forecast-collector/schema.sql
npx wrangler d1 execute FORECAST_DB --remote --env="" `
  --config forecast-collector/wrangler.toml --file forecast-collector/schema.sql
```

For an existing database, apply the incremental migrations instead of replaying the bootstrap
schema. Migration 0003 adds invocation accounting, shallow cursors, and the source queue:

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
```

Required repository variables:

```text
FORECAST_COLLECTOR_STAGING_URL
FORECAST_COLLECTOR_PRODUCTION_URL
FORECAST_COLLECTOR_URL
FORECAST_DIRECT_NAVER_POLL (optional emergency fallback)
```

The promotion workflow sets `FORECAST_COLLECTOR_URL` to production only after the 12-hour staging
canary, production queue round-trip smoke, and idempotent Solo Raid ledger bootstrap pass. Until
then the proposal workflow skips without failing.

Promotion compares the canary commit with current `main` only across the collector deployment
inputs covered by the staging workflow path filter. Unrelated application, solver, or documentation
commits therefore neither restart nor invalidate a running canary; any collector-input change does.
