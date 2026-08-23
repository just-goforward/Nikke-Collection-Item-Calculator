# Schedule forecast collector

`collection-kit-forecast-collector` is an isolated Cloudflare Worker that observes official NIKKE
schedule notices and proposes supply-forecast registry updates. It does not serve calculator
statistics and cannot modify the repository or activate a product forecast.

## Sources and cadence

- Naver Game Lounge boards 56 and 48 are fetched every three minutes through the public Lounge
  feed endpoint. Only relevant official manager posts with structured SmartEditor contents can
  support an automatic candidate.
- X is advisory only. Browser Run opens the public `x.com/NIKKE_kr` timeline at most every 30
  minutes and at most 54 times per UTC day. No X API token, unofficial RSS feed, or login session is
  used.
- An unreadable or blocked X page becomes `x_unavailable`; the proposal may proceed but requires a
  manual X checklist. A conflicting public X schedule becomes `conflict` and blocks proposal.

The Naver fetch always overlaps the current feed window. Source items and payload hashes make this
replay idempotent. A source watermark is updated in the same D1 batch as the corresponding source
items and parsed events, so a failed batch cannot advance it.

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
- Empty feeds, malformed JSON, schema drift, unofficial posts, ambiguous schedule changes, inverted
  periods, non-finite gains, non-monotone profiles, and out-of-range cadence never delete or
  activate a forecast.
- `/health` exposes only source status and candidate counts. Candidate payloads and canary evidence
  require a timing-safe bearer token.
- Authenticated endpoints share a dedicated Cloudflare rate-limit namespace per environment and
  reject more than 60 requests per minute from the admin request class.
- X automation is disabled at production promotion when the 24-hour staging success rate is below
  90%. Naver collection and the last approved product forecast remain available.

## Local verification

```powershell
npm run forecast:types:check
npm run test:forecast-collector
npx wrangler deploy --dry-run --env staging --config forecast-collector/wrangler.toml
```

Remote setup needs two dedicated D1 databases, the Browser Run binding, and `ADMIN_TOKEN`. GitHub
uses `FORECAST_COLLECTOR_ADMIN_TOKEN`; it is not a GitHub or Cloudflare write token. Deployment uses
the existing scoped `CLOUDFLARE_API_TOKEN` and account ID.

The deployment token intentionally has no D1 write permission. Apply schema changes as a separate,
operator-audited migration before deploying either environment. The post-deploy smoke fails closed
when the expected tables are absent.

```powershell
npx wrangler d1 execute collection-kit-forecast-collector-staging --remote --env=staging `
  --config forecast-collector/wrangler.toml --file forecast-collector/schema.sql
npx wrangler d1 execute collection-kit-forecast-collector --remote --env="" `
  --config forecast-collector/wrangler.toml --file forecast-collector/schema.sql
```

Required repository variables:

```text
FORECAST_COLLECTOR_STAGING_URL
FORECAST_COLLECTOR_PRODUCTION_URL
FORECAST_COLLECTOR_URL
```

`FORECAST_COLLECTOR_URL` is set to production only after the 24-hour staging canary and production
round-trip smoke pass. Until then the proposal workflow skips without failing.
