# Cloudflare Paid usage guard

`collection-kit-usage-guard` is the account-level control plane for this repository's Cloudflare
automation. It runs every 15 minutes, verifies the Workers Paid subscription and billing period,
collects account-wide Workers and D1 analytics, stores hash-checked evidence, and publishes one
effective action through the dedicated `collection-kit-usage-guard` D1 database.

It does not claim to be a Cloudflare billing cap. Analytics ingestion can lag, manual account work
and unrelated projects are outside this repository's stop controls, and Cloudflare may still bill
overages. The repository therefore stops controlled work at 50% of each included allowance and
leaves the other half as operational reserve.

## Limits and actions

| Maximum current or projected monthly use | Effective action |
|---:|---|
| below 25% | `normal` |
| 25% | `warning` |
| 35% | `disable_staging` |
| 40% | `disable_forecast_production` |
| 45% | `disable_statistics_writes` |
| 50% | `hard_stop` |

Projection uses cumulative usage plus the largest of the longest available recent rate up to six
hours (with a 30-minute minimum), daily p95, and observed period average for the remaining billing
period, multiplied by a 2x safety factor. Workers requests,
Workers CPU milliseconds, D1 rows read, D1 rows written, and D1 storage are evaluated independently;
the strictest result wins.

Billing-period Worker request and CPU totals drive quota utilization. A separate rolling eight-hour
Worker runtime window records average, p95, p99, errors, and `exceededCpu`; the final canary refreshes
this window immediately before evaluating per-Worker CPU limits so deployments from earlier in the
billing period cannot contaminate the canary certificate.

The action is monotonic within a billing period. A new billing period must produce two consecutive
normal observations before a restrictive latch is released. Missing state fails closed. Evidence
older than 45 minutes blocks production Forecast automation; evidence older than two hours blocks all
optional guarded work. The Usage Guard itself remains available so that it can recover and record a
new measurement.

At 40% or above, the independent Actions watchdog requests `Emergency Stop Cloudflare Automation`.
Its Cron-trigger update is protected by the `cloudflare-production` environment and therefore waits
for administrator approval. The in-Worker guard is the immediate stop; the approved workflow then
removes production Forecast Cron triggers, and at `hard_stop` also removes staging Forecast and
statistics maintenance triggers. It never removes the Usage Guard Cron, which is required to observe
the next billing period and two normal recovery samples.

## Configuration

Required secrets:

```text
CLOUDFLARE_D1_ANALYTICS_TOKEN
CLOUDFLARE_BILLING_READ_TOKEN
DISCORD_BOT_TOKEN
ADMIN_TOKEN
```

`CLOUDFLARE_BILLING_READ_TOKEN` must be separate from the deployment token and limited to
`Account > Billing > Read`. `ADMIN_TOKEN` is the existing Forecast Collector administrator token and
protects `POST /admin/refresh`. `/health` exposes only the effective action, evidence timestamp,
billing period, governing utilization, and latest run status.

Subscription verification accepts only the normalized `WORKERS_PAID` rate-plan identity. A Free,
Workers AI, reseller, or enterprise subscription is rejected because its included allowances do not
match this guard contract.

Repository variable `CLOUDFLARE_USAGE_GUARD_URL` points to the Worker origin. Every statistics,
Collector, Dispatcher, and Interaction Router deployment binds the same guard D1 by ID. Tokens and
raw API responses are never stored in that database or sent to Discord.

## Verification

```powershell
npm run usage-guard:types:check
npm run test:usage-guard
npm test -- scripts/d1-budget.test.ts scripts/cloudflare-paid-quota-config.test.ts
npx wrangler deploy --dry-run --config usage-guard/wrangler.toml
```

Staging deployment applies `usage-guard/schema.sql`, deploys this Worker first, forces an
authenticated refresh, and requires `normal` before any Forecast or statistics D1 migration starts.
Production remains behind the existing `cloudflare-production` approval boundary.
