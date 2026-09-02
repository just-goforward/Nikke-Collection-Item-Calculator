# Forecast workflow dispatcher

`collection-kit-forecast-dispatcher` is a Cron-only Cloudflare Worker. It watches the shared
Forecast D1 queue and asks one fixed GitHub Actions workflow to process actionable work. It has no
public HTTP API, cannot edit repository contents itself, and cannot activate a Forecast.

## Trust boundary

- Repository, workflow, and ref are hard-coded to
  `just-goforward/Nikke-Collection-Item-Calculator`, `forecast-proposal.yml`, and `main`.
- A repository-scoped GitHub App has only `Actions: write` and implicit `Metadata: read`. Each
  installation token request narrows access again to this repository and `Actions: write`.
- The App private key and Discord bot token are Worker secrets and are never written to D1, logs,
  workflow inputs, or Discord.
- Queue titles and URLs can appear only in a bounded Discord notification. They cannot select a
  repository, workflow, ref, branch, shell argument, or path.

## Scheduling and idempotency

The Dispatcher runs at `1-59/3 * * * *`, offset from the Collector's three-minute Cron. It hashes
the ordered pending source-item and candidate IDs into a work fingerprint. A deterministic
`environment + fingerprint + three-minute slot` ID and D1 unique constraints prevent concurrent
Cron invocations from reserving the same dispatch. An accepted or running fingerprint is suppressed
for 20 minutes; a stale five-minute lease or failed attempt can be reacquired.

GitHub's dispatch endpoint has no end-to-end idempotency key. API version `2026-03-10` normally
returns HTTP 200 with the created run identity, which the Dispatcher records immediately; the 204
compatibility response leaves identity ownership to the callback. If a network failure occurs after
GitHub accepts a request, a retry can still create another run. The callback contract therefore
permits only one GitHub run identity to own a dispatch ID; a second run receives HTTP 409 and skips
all queue and repository mutations.

## Operations alerts

Discord messages disable all mentions. Accepted dispatches go to the activity channel and are
described as requests, not completed work, with at most three sanitized Naver titles and links.
Warnings, critical errors, and their recovery messages go to the alert channel. Immediate authorization,
invariant, callback, workflow-failure, and cancellation errors are recorded as critical alerts.
Retryable GitHub/Discord failures alert after three occurrences. Pending age, stale dispatches,
manual review, Collector circuit state, and the thirty-minute watchdog are monitored from D1.

Manual-review alerts include only a validated Naver link, opaque review ID, requeue/ignore buttons,
and a link to the structured GitHub workflow for a date-bearing manual event. The Discord
interaction Router owns button verification and D1 mutation; the Dispatcher owns only message
delivery.

The same alert fingerprint is grouped for 30 minutes. Discord rate limits do not sleep inside the
Worker: a validated `retry_after` of up to one hour is stored as `next_send_at`, and a later Cron
retries the same durable alert. Final send failures remain visible in `/health`. Resolution produces
one green recovery message. X/Jina unavailability remains advisory and is not an operations
incident.

## Workers Paid quota guard

The Dispatcher checks the shared `USAGE_GUARD_DB` before reading actionable work or dispatching a
workflow. A dedicated 15-minute Usage Guard verifies the Workers Paid subscription and billing
period, aggregates all Workers and D1 databases in the account, and conservatively projects every
monthly metric from the longest available recent window up to six hours. The project uses 50% of
each included allowance as its software hard cap. A 25%
warning does not stop work; staging stops at 35%, production Forecast automation at 40%, statistics
writes at 45%, and optional D1/Cron work at 50%. Missing state is fail-closed, 45-minute-old evidence
blocks production Forecast automation, and two-hour-old evidence hard-stops optional work.

Before a staging canary starts, GitHub Actions records a baseline, runs Collector and Dispatcher for
30 minutes, and requires both current and projected month-end utilization below 25%. `Watch Forecast
D1 Budget` independently repeats account preflight and Guard health checks every 30 minutes. At the
35% stage or above, it redeploys staging with both `DISPATCH_ENABLED=false` and
`COLLECT_ENABLED=false`; the in-Worker guard enforces higher stages without waiting for a deployment.

## Local verification

```powershell
npm run dispatcher:types:check
npm run test:forecast-dispatcher
npx wrangler deploy --dry-run --env staging --config forecast-dispatcher/wrangler.toml
```

`DISPATCH_ENABLED=false` is the deployment-safe default. Staging and production workflows deploy the
Dispatcher disabled, migrate and deploy the Collector, then enable dispatch only after Collector
readiness succeeds. Production remains protected by the `cloudflare-production` environment.

Required bindings and secrets:

```text
GITHUB_APP_ID
GITHUB_APP_INSTALLATION_ID
GITHUB_APP_PRIVATE_KEY (secret, full PEM)
DISCORD_ACTIVITY_CHANNEL_ID
DISCORD_ALERT_CHANNEL_ID
DISCORD_FALLBACK_CHANNEL_ID
DISCORD_CHANNEL_ID (legacy fallback during migration)
DISCORD_BOT_TOKEN (secret)
FORECAST_DB
USAGE_GUARD_DB
ENVIRONMENT
DEPLOY_SHA
DISPATCH_ENABLED
```
