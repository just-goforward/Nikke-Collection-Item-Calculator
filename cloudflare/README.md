# Cloudflare statistics backend

This folder contains the optional backend for global user statistics.

Architecture:

```text
GitHub Pages
  -> Cloudflare Turnstile token
  -> Cloudflare Worker
  -> Cloudflare D1
```

The calculator still runs locally in the user's browser. The backend only receives validated result events for aggregate statistics.

## Setup

1. Install Wrangler:

```powershell
npm install -g wrangler
```

2. Login:

```powershell
wrangler login
```

3. Create a D1 database:

```powershell
wrangler d1 create collection-kit-stats
```

4. Copy the returned `database_id` into `wrangler.toml`:

```powershell
Copy-Item cloudflare\wrangler.toml.example cloudflare\wrangler.toml
```

5. Apply the schema:

```powershell
wrangler d1 execute collection-kit-stats --remote --file cloudflare/schema.sql
```

6. Create a Turnstile widget in the Cloudflare dashboard.

Use the site key in `index.html`:

```js
window.COLLECTION_STATS_CONFIG = {
  endpoint: "https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev",
  turnstileSiteKey: "YOUR_TURNSTILE_SITE_KEY",
};
```

Set the secret key on the Worker:

```powershell
wrangler secret put TURNSTILE_SECRET_KEY
```

Set a random rate-limit secret:

```powershell
wrangler secret put RATE_LIMIT_SECRET
```

Optionally set a private admin token to enable non-public diagnostic reads:

```powershell
wrangler secret put ADMIN_TOKEN
```

`TURNSTILE_SECRET_KEY` and `RATE_LIMIT_SECRET` are required in every deployed environment.
`ADMIN_TOKEN` is optional: when it is absent, the private diagnostics endpoint stays hidden with
`404 not_found`. If `RATE_LIMIT_SECRET` is missing, `/api/events` returns
`rate_limit_not_configured` without retrying or storing data.

7. Set `ALLOWED_ORIGINS` in `wrangler.toml`.

The production and staging Workers accept browser requests only from the canonical custom domain:

```toml
ALLOWED_ORIGINS = "https://nikkecollection.com"
```

The legacy GitHub Pages project URL redirects to the custom domain and does not need Worker CORS
access. Locale routes such as `/en/` and `/ja/` share the same origin and require no additional
entries.

8. Deploy:

```powershell
wrangler deploy --config cloudflare/wrangler.toml
```

### Automated Worker deployment

`.github/workflows/worker-deploy.yml` runs after a successful `main` push completes the
`Deploy GitHub Pages` workflow. It checks Worker types and D1 integration tests, deploys staging,
runs schema-health, public-read, CORS, and write-contract smoke tests, and then promotes the same
commit to production. The write-contract probe uses an intentionally invalid Turnstile token, so
it confirms that a valid event envelope reaches Turnstile validation without adding a statistics
aggregate. It can still increment abuse-control counters that run before Turnstile verification.
The `cloudflare-production` GitHub environment is the production approval boundary; configure a
required reviewer for that environment before enabling the workflow.

Automatic runs compare the current commit with the commit tag from the last automated production
Worker deployment. They skip deployment when Worker source, shared contracts, Worker config,
dependencies, and deployment tooling are unchanged. A manual run always deploys.
If tracked D1 SQL changed, an automatic run stops before deployment; apply the migration to staging
and production explicitly, then use `workflow_dispatch` to perform the guarded deployment.

Before each staging or production deployment, the workflow records the currently active Worker
version. If the post-deploy smoke test fails, it restores that version at 100% traffic and then
fails the job. `.github/workflows/worker-rollback.yml` applies the same safety rule when a manually
selected rollback target is incompatible. A Worker version restore does not restore D1 data or
schema, so database migrations remain a separate, forward-compatible operation.

Configure these GitHub repository settings:

| Type | Name | Value |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | A scoped token that can deploy this account's Workers |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account ID |
| Variable | `STATS_ALLOWED_ORIGIN` | `https://nikkecollection.com` |
| Variable | `CLOUDFLARE_STAGING_WORKER_URL` | The public staging Worker URL |
| Variable | `CLOUDFLARE_PRODUCTION_WORKER_URL` | The public production Worker URL |

The workflow does not upload Turnstile, rate-limit, or admin secret values. Wrangler preserves
secrets already stored on each Worker. A manual `workflow_dispatch` follows the same staging,
smoke, approval, and production sequence. D1 migrations remain separate operations and are never
run implicitly by this workflow.

The deployment token should be limited to this account's Worker deployment and version-management
operations. The CI workflow deliberately does not require direct D1 API access: deployed schema
compatibility is checked through the Worker's bound database at `/api/health`.

## Abuse controls

The Worker rejects bad submissions before writing to D1:

- CORS origin allowlist
- JSON body size limit
- Turnstile verification
- IP-based minute/day rate limits
- event id deduplication
- integer/range checks
- 10-kit unit checks
- only the recommended kit may decrease
- success attempt must match stock delta
- result level/exp must match the expected transition
- successful Turnstile verification must match the submitted event action
- browser, OS, device type, and referrer are stored only as private aggregates
- solver diagnostic values are stored only as private bucketed aggregates
- raw per-user inputs are not exposed by the stats endpoint

### Event populations

The aggregate tables intentionally describe different populations. Their event counts must not be
used as interchangeable denominators.

| Event | Emission condition | Aggregate population |
| --- | --- | --- |
| `solver_diagnostic` | A calculation returns a usable recommendation, including cache hits | Calculation results, not visits or users |
| `kit_result` | The user confirms Great Success or no Great Success | Confirmed outcomes; this is the population for referrer and full client-environment aggregates |
| `solver_recovery` | A recovery rung fails, falls back, or ends without the requested backend | Recovery-affected calculations only |
| `runtime_invariant` | A named runtime invariant fails | Operational anomalies only |

`calculation_locale_aggregates` records the selected UI language when a calculation starts. It does
not record the initial landing route or a unique visitor. `referrer_aggregates` records the external
referrer host attached to a confirmed `kit_result`; it does not identify the current application
origin and is not a page-view source report. Search traffic and route-level visits belong in web
analytics rather than this Turnstile-protected calculation pipeline.

Event deduplication and its aggregate write are committed in one D1 batch. An accepted event is
either fully counted or can be retried with the same event ID after a write failure. Event IDs
are retained for 14 days, so deduplication applies within that retention window.

Events accepted before the atomic-write change may already have an event ID without matching
aggregate data if a later write failed. Raw payloads are not retained, so those historical gaps
cannot be reconstructed or repaired.

Browser submissions are sent in FIFO order. A transient browser retry keeps the same event ID
but obtains a fresh Turnstile token. A transient Worker-to-Siteverify retry reuses its original
token with the same `idempotency_key`. Any retry can consume additional pre/post rate-limit
counters, because abuse-protection accounting is intentionally kept outside the aggregate commit.

The public stats response retains `levelKitStats` for level-by-kit usage breakdowns and
`successAttemptDistribution` as an empty compatibility array. Retaining these fields keeps cached
older frontend assets from rejecting the entire response while newer UI versions can show kit usage
tooltips.

## Endpoints

`POST /api/events`

Stores one validated result event.

`GET /api/stats`

Returns all-time aggregate statistics for display on the site. This public response is cacheable for 60 seconds.

`GET /api/health`

Checks every D1 column and composite primary-key order required by the deployed Worker's inserts and
upserts. It returns `schemaContractVersion: 4` on success and fails closed with
`503 database_schema_not_ready` when the Worker code and bound database are incompatible. This
endpoint validates the current write contract, not column types, constraints, secondary indexes, or
the complete historical migration ledger.

`GET /api/admin/solver-diagnostics`

Returns private solver diagnostic aggregates grouped by `forecastId`, `forecastProfileId`,
`solverVersion`, and `solverPhase`. The response includes `supplyForecastRegistry`, so the two IDs
resolve to the exact blue, purple, and yellow gain vector used by that calculation. The D1 aggregate
rows deliberately store IDs rather than three duplicate gain values. Historical registry entries
and profiles in `shared/supplyForecasts.json` are append-only and must not be edited or removed.
This endpoint is not used by the public site. When `ADMIN_TOKEN` is configured, it requires an
`Authorization: Bearer <ADMIN_TOKEN>` header; without the secret, the endpoint returns 404.
Optional query parameter: `days=30` (1-365). The response also includes recent
`nodeCounts` buckets for observing Rust min-E[f] state-space pressure and fallback risk, plus
`calculationLocales` for the language selected when each calculation started.

Worker/D1 write-path tests use an isolated D1 database in the Cloudflare Vitest pool:

```powershell
npm run test:worker
```

On Windows, run this command from an ASCII-only checkout path until the upstream
[`cloudflare:test-internal` non-ASCII path issue](https://github.com/cloudflare/workers-sdk/issues/14655)
is fixed. CI/Linux is not affected.

Use `schema.sql` for a new database. Existing databases must apply the versioned migrations instead
of re-running `CREATE TABLE IF NOT EXISTS`, which cannot change an existing primary key.

After initializing or migrating a database, the same critical schema contract can be checked
manually. Remote checks require a Wrangler login or API token with D1 read access; a Worker-only
deployment token is intentionally insufficient.

```powershell
# Local development database
npm run check:d1-schema -- collection-kit-stats local

# Remote production and staging databases
npm run check:d1-schema -- collection-kit-stats
npm run check:d1-schema -- collection-kit-stats-staging staging
```

Historical SQL files in this directory predate a Wrangler migration ledger and were applied
explicitly. Do not retroactively mark them as applied without first reconciling the real staging
and production schemas. For new schema changes, use an additive SQL file, apply it to staging,
verify `/api/health` and the smoke flow, then apply the same file to production before deploying
code that requires it. Cloudflare's D1 migration ledger is suitable for a future controlled
baseline, but adopting it requires a separate bootstrap procedure for the existing databases.

```powershell
wrangler d1 execute collection-kit-stats --remote --file cloudflare/schema.sql --config cloudflare/wrangler.toml
```

For the Rust min-E[f] version-name migration and node-count aggregate table:

```powershell
wrangler d1 execute collection-kit-stats --remote --file cloudflare/migrate-min-ef-version-and-node-count.sql --config cloudflare/wrangler.toml
```

For solver runtime backend/fallback/latency aggregates:

```powershell
wrangler d1 execute collection-kit-stats --remote --file cloudflare/add-solver-runtime-aggregates.sql --config cloudflare/wrangler.toml
```

For diagnostic v5 attempted-node buckets, cleanup indexes, and the runtime aggregate primary key:

```powershell
npx wrangler d1 execute collection-kit-stats --remote --file cloudflare/migrate-runtime-v5.sql --config cloudflare/wrangler.toml
```

For diagnostic v6 cache execution aggregates, apply the migration to both databases explicitly:

```powershell
npx wrangler d1 execute collection-kit-stats --remote --file cloudflare/add-solver-cache-aggregates.sql --config cloudflare/wrangler.toml --env=""
npx wrangler d1 execute collection-kit-stats-staging --remote --file cloudflare/add-solver-cache-aggregates.sql --config cloudflare/wrangler.toml
```

For the `ladder_v1` recovery rung and terminal aggregates:

```powershell
npx wrangler d1 execute collection-kit-stats --remote --file cloudflare/add-solver-recovery-aggregates.sql --config cloudflare/wrangler.toml --env=""
npx wrangler d1 execute collection-kit-stats-staging --remote --file cloudflare/add-solver-recovery-aggregates.sql --config cloudflare/wrangler.toml
```

For calculation-time language aggregates, apply the additive migration to both databases before
deploying the Worker change. Missing locale values from older clients remain valid and are excluded
from this table instead of being guessed.

```powershell
npx wrangler d1 execute collection-kit-stats --remote --file cloudflare/add-calculation-locale-aggregates.sql --config cloudflare/wrangler.toml --env=""
npx wrangler d1 execute collection-kit-stats-staging --remote --file cloudflare/add-calculation-locale-aggregates.sql --config cloudflare/wrangler.toml --env=staging
```

For low-cardinality runtime invariant diagnostics, apply the additive migration to both databases
before deploying the Worker change:

```powershell
npx wrangler d1 execute collection-kit-stats --remote --file cloudflare/add-runtime-invariant-aggregates.sql --config cloudflare/wrangler.toml --env=""
npx wrangler d1 execute collection-kit-stats-staging --remote --file cloudflare/add-runtime-invariant-aggregates.sql --config cloudflare/wrangler.toml --env=staging
```

For diagnostic v7 supply-forecast identities, apply the primary-key migration to staging first,
verify `/api/health`, then apply it to production before deploying the Worker. Existing rows are
preserved under `legacy-unversioned`; they cannot be assigned a newer forecast retroactively.

```powershell
npx wrangler d1 execute collection-kit-stats-staging --remote --file cloudflare/migrate-supply-forecast-v7.sql --config cloudflare/wrangler.toml --env=staging
npm run check:d1-schema -- collection-kit-stats-staging staging

npx wrangler d1 execute collection-kit-stats --remote --file cloudflare/migrate-supply-forecast-v7.sql --config cloudflare/wrangler.toml --env=""
npm run check:d1-schema -- collection-kit-stats
```

To change the administrator-managed forecast, append a new immutable record to
`shared/supplyForecasts.json`, set `activeForecastId` to the new ID, and regenerate the TypeScript
and Rust constants. Never reuse an ID for different gain values: aggregate interpretation and
solver cache identity depend on that mapping remaining stable.

```powershell
npm run generate:supply-forecast
npm run check:supply-forecast
npm run build:solver-wasm
```

Diagnostic versions before v6 can contain repeated cache-hit timing and node-count values. Treat
that runtime data as a usage-weighted historical snapshot, not as an execution distribution.
The protected admin endpoint filters runtime, latency, fallback, and node-count distributions to
diagnostic v6 and later. Its `solveMs` buckets represent end-to-end recovery wall time, including
failed ladder rungs before the terminal result.

The legacy `solver_node_count_aggregates` table is retained in existing databases for historical
queries, but new events no longer write to it. Current node pressure is derived from
`solver_runtime_aggregates`.

Referrer/source-host aggregates are intentionally not returned by this public endpoint. They count
confirmed result events rather than visits, and `source_host` describes the document referrer rather
than the current application origin. Check them privately through D1, for example:

```powershell
wrangler d1 execute collection-kit-stats --remote --config cloudflare/wrangler.toml --command "SELECT date_key, source_host, events FROM referrer_aggregates ORDER BY date_key DESC, events DESC LIMIT 50"
```

Client environment aggregates are also private. Check them through D1:

```powershell
wrangler d1 execute collection-kit-stats --remote --config cloudflare/wrangler.toml --command "SELECT date_key, browser, browser_major, os, os_major, device_type, events FROM client_env_aggregates ORDER BY date_key DESC, events DESC LIMIT 50"
```

Solver diagnostic aggregates are private and bucketed. They are intended for deciding whether the supply strategy needs a Phase 2 refinement.

The `strategy` column is retained as a fixed compatibility field for the current solver mode and is not a user strategy selection statistic.

Diagnostic v6 also retains fixed legacy comparison fields for schema compatibility. Do not create a
destructive migration solely to remove them while the database is small. If another diagnostic
contract change is required, introduce a separately reviewed v7 aggregate layout that removes fixed
dimensions and preserves historical v1-v6 rows.

```powershell
wrangler d1 execute collection-kit-stats --remote --config cloudflare/wrangler.toml --command "SELECT date_key, forecast_id, solver_version, solver_phase, grade, level, strategy, probability_gap_bucket, resource_cost_bucket, legacy_supply_cost_bucket, blue_share_bucket, min_autonomy_days_bucket, events FROM solver_diagnostic_aggregates ORDER BY date_key DESC, events DESC LIMIT 50"
```

Current real-service solver event counts:

```powershell
wrangler d1 execute collection-kit-stats --remote --config cloudflare/wrangler.toml --command "SELECT forecast_id, solver_version, solver_phase, SUM(events) AS events FROM solver_diagnostic_aggregates GROUP BY forecast_id, solver_version, solver_phase ORDER BY events DESC"
```

Rust min-E[f] fallback rate and reason buckets:

```powershell
npx wrangler d1 execute collection-kit-stats --remote --config cloudflare/wrangler.toml --env="" --command "SELECT CASE WHEN fallback_from != 'none' THEN fallback_from ELSE solver_backend END AS attempted_backend, SUM(events) AS attempts, SUM(CASE WHEN fallback_reason != 'none' THEN events ELSE 0 END) AS fallback_events, 1.0 * SUM(CASE WHEN fallback_reason != 'none' THEN events ELSE 0 END) / SUM(events) AS fallback_rate FROM solver_runtime_aggregates WHERE diagnostic_version >= 6 GROUP BY attempted_backend ORDER BY attempts DESC"
```

Rust min-E[f] fallback contexts for future kernel tuning:

```powershell
npx wrangler d1 execute collection-kit-stats --remote --config cloudflare/wrangler.toml --env="" --command "SELECT grade, level, exp_bucket, stock_bucket_blue, stock_bucket_purple, stock_bucket_yellow, attempted_node_count_bucket, fallback_reason, SUM(events) AS events FROM solver_runtime_aggregates WHERE diagnostic_version >= 6 AND fallback_reason != 'none' GROUP BY grade, level, exp_bucket, stock_bucket_blue, stock_bucket_purple, stock_bucket_yellow, attempted_node_count_bucket, fallback_reason ORDER BY events DESC LIMIT 50"
```

Node-count bucket pressure:

```powershell
npx wrangler d1 execute collection-kit-stats --remote --config cloudflare/wrangler.toml --env="" --command "SELECT CASE WHEN fallback_from != 'none' THEN fallback_from ELSE solver_backend END AS attempted_backend, attempted_node_count_bucket, SUM(events) AS events FROM solver_runtime_aggregates WHERE diagnostic_version >= 6 GROUP BY attempted_backend, attempted_node_count_bucket ORDER BY attempted_backend, events DESC"
```

Approximate solve latency distribution by bucket:

```powershell
npx wrangler d1 execute collection-kit-stats --remote --config cloudflare/wrangler.toml --env="" --command "SELECT solver_backend, solve_ms_bucket, SUM(events) AS events FROM solver_runtime_aggregates WHERE diagnostic_version >= 6 GROUP BY solver_backend, solve_ms_bucket ORDER BY solver_backend ASC, events DESC"
```

Observed solve-cache execution and hit counts (diagnostic v6 and later):

```powershell
npx wrangler d1 execute collection-kit-stats --remote --config cloudflare/wrangler.toml --env="" --command "SELECT diagnostic_version, requested_backend, terminal_backend, execution_kind, SUM(events) AS events FROM solver_cache_aggregates WHERE diagnostic_version >= 6 GROUP BY diagnostic_version, requested_backend, terminal_backend, execution_kind ORDER BY diagnostic_version, requested_backend, execution_kind"
```

Calculation-time language selection, split by actual execution and cache hits:

```powershell
npx wrangler d1 execute collection-kit-stats --remote --config cloudflare/wrangler.toml --env="" --command "SELECT locale, requested_backend, terminal_backend, execution_kind, SUM(events) AS events FROM calculation_locale_aggregates GROUP BY locale, requested_backend, terminal_backend, execution_kind ORDER BY events DESC"
```

Recovery rung and terminal counts are independent operational aggregates. Do not divide one table
by the other as a success rate: Turnstile, the in-memory submission queue, and page exits can affect
which observations reach D1. The data also cannot observe work lost when the page exits before an
event is queued.

```powershell
npx wrangler d1 execute collection-kit-stats --remote --config cloudflare/wrangler.toml --env="" --command "SELECT policy_version, requested_backend, rung_backend, rung_exit, device_type, SUM(events) AS events FROM solver_recovery_rung_aggregates GROUP BY policy_version, requested_backend, rung_backend, rung_exit, device_type ORDER BY events DESC"
npx wrangler d1 execute collection-kit-stats --remote --config cloudflare/wrangler.toml --env="" --command "SELECT policy_version, requested_backend, terminal_backend, terminal_outcome, SUM(events) AS events FROM solver_recovery_terminal_aggregates GROUP BY policy_version, requested_backend, terminal_backend, terminal_outcome ORDER BY events DESC"
```

Runtime invariant diagnostics contain only enumerated codes, component/lane dimensions, device
type, and counts. Raw errors, inputs, stock, and timings are not stored.

```powershell
npx wrangler d1 execute collection-kit-stats --remote --config cloudflare/wrangler.toml --env="" --command "SELECT invariant_version, invariant_code, component, lane, device_type, SUM(events) AS events FROM runtime_invariant_aggregates GROUP BY invariant_version, invariant_code, component, lane, device_type ORDER BY events DESC"
```

Or query the protected admin endpoint:

```powershell
Invoke-RestMethod -Headers @{ Authorization = "Bearer $env:ADMIN_TOKEN" } "https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/api/admin/solver-diagnostics?days=30"
```

To delete private aggregate rows for a specific KST date:

```powershell
wrangler d1 execute collection-kit-stats --remote --config cloudflare/wrangler.toml --command "DELETE FROM referrer_aggregates WHERE date_key = '2026-05-18'"
wrangler d1 execute collection-kit-stats --remote --config cloudflare/wrangler.toml --command "DELETE FROM client_env_aggregates WHERE date_key = '2026-05-18'"
wrangler d1 execute collection-kit-stats --remote --config cloudflare/wrangler.toml --command "DELETE FROM solver_diagnostic_aggregates WHERE date_key = '2026-05-18'"
```

## Staging submission verification

Production statistics must not be used for synthetic browser verification. Use a separate
staging Worker, D1 database, and Turnstile widget. The deployed GitHub Pages app selects that
backend only when opened with `?statsEnv=staging`.

This mode validates a frontend version that is already public on GitHub Pages. It is not a
pre-release frontend preview. Add a separate static staging deployment later if a frontend
release must be tested before it becomes public.

Runtime modes:

| URL | Display source | Event submissions |
| --- | --- | --- |
| normal URL | production API | production API |
| `?statsEnv=staging` | staging API | staging API |
| `?demoStats=1` | generated demo data | disabled |
| `?demoStats=1&statsEnv=staging` | generated demo data | disabled |
| `?statsEnv=disabled` | no stats backend | disabled |

If staging is requested but no complete staging frontend configuration is present, the app
shows an error notice and performs neither stats reads nor event submissions. It never falls
back to production.

### Initial staging setup

Create a physically separate D1 database:

```powershell
& "C:\Program Files\nodejs\npx.cmd" wrangler d1 create collection-kit-stats-staging
```

Add the returned database ID to the `[env.staging]` block in `cloudflare/wrangler.toml`, based
on `cloudflare/wrangler.toml.example`. Apply the regular schema, then the staging-only reset
guard:

```powershell
& "C:\Program Files\nodejs\npx.cmd" wrangler d1 execute collection-kit-stats-staging --remote --file cloudflare/schema.sql --config cloudflare/wrangler.toml
& "C:\Program Files\nodejs\npx.cmd" wrangler d1 execute collection-kit-stats-staging --remote --file cloudflare/staging-guard.sql --config cloudflare/wrangler.toml
```

Create a separate Invisible Turnstile widget in Cloudflare Dashboard. Allow
`nikkecollection.com`; do not allow `localhost` unless deployed-site verification is no
longer the only intended use. Invisible mode is configured on the widget, not with a frontend
`size: "invisible"` render option.

Set the required staging secrets, optionally enable private diagnostics, and deploy the staging
Worker:

```powershell
& "C:\Program Files\nodejs\npx.cmd" wrangler secret put TURNSTILE_SECRET_KEY --env staging --config cloudflare/wrangler.toml
& "C:\Program Files\nodejs\npx.cmd" wrangler secret put RATE_LIMIT_SECRET --env staging --config cloudflare/wrangler.toml
# Optional: enables /api/admin/solver-diagnostics in staging.
& "C:\Program Files\nodejs\npx.cmd" wrangler secret put ADMIN_TOKEN --env staging --config cloudflare/wrangler.toml
& "C:\Program Files\nodejs\npx.cmd" wrangler deploy --env staging --config cloudflare/wrangler.toml
```

After deployment, add the public staging Worker URL and staging widget site key to
`window.COLLECTION_STATS_CONFIG` in `index.html`:

```js
window.COLLECTION_STATS_CONFIG = {
  endpoint: "https://YOUR_PRODUCTION_WORKER.workers.dev",
  turnstileSiteKey: "YOUR_PRODUCTION_SITE_KEY",
  staging: {
    endpoint: "https://YOUR_STAGING_WORKER.workers.dev",
    turnstileSiteKey: "YOUR_STAGING_SITE_KEY",
  },
};
```

The site key and Worker URL are public configuration. Secret keys stay only in the
corresponding Cloudflare Worker environment.

### Staging operation

Deploy or inspect only the staging environment with explicit environment flags:

```powershell
& "C:\Program Files\nodejs\npx.cmd" wrangler deploy --env staging --config cloudflare/wrangler.toml
& "C:\Program Files\nodejs\npx.cmd" wrangler tail --env staging --config cloudflare/wrangler.toml
```

When `cloudflare/schema.sql` changes, apply it to staging first, validate staging behavior, and
only then apply the production migration. The staging guard is not part of the common schema
and must never be executed on production.

Reset only disposable staging records with the guarded reset file:

```powershell
& "C:\Program Files\nodejs\npx.cmd" wrangler d1 execute collection-kit-stats-staging --remote --file cloudflare/reset-staging.sql --config cloudflare/wrangler.toml
```

The reset file requires the marker installed by `staging-guard.sql`. If it is mistakenly run
against a database without the guard table, execution errors before deletion. If a guard table
exists without the staging marker, every `DELETE` affects zero rows. Never install the staging
marker in production.

### Manual verification

1. Open `https://nikkecollection.com/?statsEnv=staging` and confirm the visible staging
   notice.
2. In DevTools Network, confirm `/api/stats` and `/api/events` target the staging Worker URL.
3. Run `calculate -> select fail -> automatic next calculation`.
4. Observe staging Worker logs with `wrangler tail --env staging`.
5. Query only staging D1 for accepted validation data. Exact expected deltas are meaningful
   only after a guarded reset and during an interval with no other staging writers.

Do not submit synthetic flows on the normal production URL. Production traffic means recent
production timestamps cannot prove whether a test polluted production statistics.
