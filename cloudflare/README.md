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

Both Worker secrets are required in every deployed environment. If `RATE_LIMIT_SECRET` is
missing, `/api/events` returns `rate_limit_not_configured` without retrying or storing data.

7. Set `ALLOWED_ORIGINS` in `wrangler.toml`.

For a project page:

```toml
ALLOWED_ORIGINS = "https://YOUR_GITHUB_ID.github.io"
```

8. Deploy:

```powershell
wrangler deploy --config cloudflare/wrangler.toml --env=""
```

For staging:

```powershell
wrangler deploy --config cloudflare/wrangler.toml --env staging
```

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
- browser, OS, device type, and referrer are stored only as private aggregates
- solver diagnostic values are stored only as private bucketed aggregates
- raw per-user inputs are not exposed by the stats endpoint

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

The public stats response retains `levelKitStats` and `successAttemptDistribution` as empty
compatibility arrays. Current UI versions do not consume these fields, but retaining them keeps
cached older frontend assets from rejecting the entire response.

## Endpoints

`POST /api/events`

Stores one validated result event.

`GET /api/stats`

Returns 30-day aggregate statistics for display on the site. This public response is cacheable for 60 seconds.

Worker/D1 write-path tests use an isolated local Miniflare D1 database:

```powershell
npm run test:worker
```

For an existing D1 database, re-apply the schema after schema changes:

```powershell
wrangler d1 execute collection-kit-stats --remote --file cloudflare/schema.sql --config cloudflare/wrangler.toml
```

Referrer/source-host aggregates are intentionally not returned by this public endpoint. Check them privately through D1, for example:

```powershell
wrangler d1 execute collection-kit-stats --remote --config cloudflare/wrangler.toml --command "SELECT date_key, source_host, events FROM referrer_aggregates ORDER BY date_key DESC, events DESC LIMIT 50"
```

Client environment aggregates are also private. Check them through D1:

```powershell
wrangler d1 execute collection-kit-stats --remote --config cloudflare/wrangler.toml --command "SELECT date_key, browser, browser_major, os, os_major, device_type, events FROM client_env_aggregates ORDER BY date_key DESC, events DESC LIMIT 50"
```

Solver diagnostic aggregates are private and bucketed. They are intended for deciding whether the supply strategy needs a Phase 2 refinement.

The `strategy` column is retained as a fixed compatibility field for the current solver mode and is not a user strategy selection statistic.

```powershell
wrangler d1 execute collection-kit-stats --remote --config cloudflare/wrangler.toml --command "SELECT date_key, solver_version, solver_phase, grade, level, strategy, probability_gap_bucket, resource_cost_bucket, legacy_supply_cost_bucket, blue_share_bucket, min_autonomy_days_bucket, events FROM solver_diagnostic_aggregates ORDER BY date_key DESC, events DESC LIMIT 50"
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
& "C:\Program Files\nodejs\npx.cmd" wrangler d1 execute collection-kit-stats-staging --remote --env staging --file cloudflare/schema.sql --config cloudflare/wrangler.toml
& "C:\Program Files\nodejs\npx.cmd" wrangler d1 execute collection-kit-stats-staging --remote --env staging --file cloudflare/staging-guard.sql --config cloudflare/wrangler.toml
```

Create a separate Invisible Turnstile widget in Cloudflare Dashboard. Allow
`just-goforward.github.io`; do not allow `localhost` unless deployed-site verification is no
longer the only intended use. Invisible mode is configured on the widget, not with a frontend
`size: "invisible"` render option.

Set staging-only secrets and deploy the staging Worker:

```powershell
& "C:\Program Files\nodejs\npx.cmd" wrangler secret put TURNSTILE_SECRET_KEY --env staging --config cloudflare/wrangler.toml
& "C:\Program Files\nodejs\npx.cmd" wrangler secret put RATE_LIMIT_SECRET --env staging --config cloudflare/wrangler.toml
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
& "C:\Program Files\nodejs\npx.cmd" wrangler d1 execute collection-kit-stats-staging --remote --env staging --file cloudflare/reset-staging.sql --config cloudflare/wrangler.toml
```

The reset file requires the marker installed by `staging-guard.sql`. If it is mistakenly run
against a database without the guard table, execution errors before deletion. If a guard table
exists without the staging marker, every `DELETE` affects zero rows. Never install the staging
marker in production.

### Manual verification

1. Open `https://just-goforward.github.io/?statsEnv=staging` and confirm the visible staging
   notice.
2. In DevTools Network, confirm `/api/stats` and `/api/events` target the staging Worker URL.
3. Run `calculate -> select fail -> automatic next calculation`.
4. Observe staging Worker logs with `wrangler tail --env staging`.
5. Query only staging D1 for accepted validation data. Exact expected deltas are meaningful
   only after a guarded reset and during an interval with no other staging writers.

Do not submit synthetic flows on the normal production URL. Production traffic means recent
production timestamps cannot prove whether a test polluted production statistics.
