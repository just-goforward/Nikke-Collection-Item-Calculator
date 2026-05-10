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

7. Set `ALLOWED_ORIGINS` in `wrangler.toml`.

For a project page:

```toml
ALLOWED_ORIGINS = "https://YOUR_GITHUB_ID.github.io"
```

8. Deploy:

```powershell
wrangler deploy --config cloudflare/wrangler.toml
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
- raw per-user inputs are not exposed by the stats endpoint

## Endpoints

`POST /api/events`

Stores one validated result event.

`GET /api/stats`

Returns 30-day aggregate statistics for display on the site. This public response is cacheable for 60 seconds.

For an existing D1 database, re-apply the schema after schema changes:

```powershell
wrangler d1 execute collection-kit-stats --remote --file cloudflare/schema.sql --config cloudflare/wrangler.toml
```

Referrer/source-host aggregates are intentionally not returned by this public endpoint. Check them privately through D1, for example:

```powershell
wrangler d1 execute collection-kit-stats --remote --command "SELECT date_key, source_host, events FROM referrer_aggregates ORDER BY date_key DESC, events DESC LIMIT 50"
```
