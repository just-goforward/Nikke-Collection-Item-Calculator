# Stats Observer

`collection-kit-stats-observer` is a Cron-only Worker that turns bucketed terminal solver failures,
statistics contract rejections, delayed browser delivery summaries, and verified Worker runtime
errors into Discord operations alerts. It has no public route and its `fetch` handler always
returns 404.

## Privacy and ownership

- `STATS_DB` remains the source of aggregate evidence.
- `OBSERVER_DB` stores cursors, run records, alert state, and canary certificates.
- `GUARD_DB` is checked before any optional statistics read or Observer write.
- Exact stock, IP addresses, user identifiers, raw User-Agent strings, error messages, stacks, and
  submitted event bodies are never copied to the Observer database or Discord.
- The first production run records the existing counts as a baseline and sends no historical alerts.

Failure fingerprints intentionally omit stock and device buckets, so one underlying failure is not
split into many low-count alerts. Up to three bucketed contexts are shown in the message. Integrity,
runtime, contract, and deployment failures are critical on first observation. Capacity and temporary
infrastructure failures start as warnings and become critical at three events within 30 minutes.
Successful fallback remains diagnostic evidence but is not an alert.

Silence is not proof of recovery. Solver terminal alerts are not automatically resolved. A Worker
runtime alert receives a separate green recovery message only when a later independent Usage Guard
runtime window reports zero occurrences. Discord 429 responses are persisted as `next_send_at` and
retried by a later Cron; the Worker does not sleep inside an invocation.

## Deployment

1. Deploy the statistics Worker schema and compatibility release first with
   `.github/workflows/worker-deploy.yml`.
2. Run `Deploy Stats Observer` with the same trusted main SHA. It applies `schema.sql` to the
   staging Observer D1, supplies the existing Discord bot token, and deploys the `7,37 * * * *` Cron.
3. Let two healthy runs provide at least 30 minutes of burn-in.
4. Run `Verify Stats Observer Canary` with action `start`.
5. After the exact eight-hour window, run it with action `check` and the returned `soc-*` ID.
6. A pass requires all 16 expected slots, all completed, no duplicate attempts, no deployment drift,
   no unsent alerts, and no new statistics contract rejection.
7. Run `Promote Stats Observer`. Production remains protected by the `cloudflare-production`
   environment approval. Its first Cron establishes a no-backfill baseline.
8. Only after the production statistics Worker advertises recovery v2 may the client emission
   constant be changed from 1 to 2.

The Observer D1 databases are included in the account-wide Paid quota evidence. If that evidence is
45 minutes stale or the guard hard-stops, the Observer performs no optional statistics reads or
writes. Calculator and solver execution remain client-side and continue normally.

## Verification

```powershell
npm run stats-observer:types:check
npx tsc --noEmit -p stats-observer/tsconfig.json
npm run test:stats-observer
npm test -- scripts/stats-observer-workflow.spec.ts
npx wrangler deploy --dry-run --env staging --config stats-observer/wrangler.toml
```

`Audit Solver Recovery History` is read-only and requires `cloudflare-production` approval for
production. Its 30-day artifact contains aggregate buckets. A match for
`R0 / 500_plus / 300_349 / 150_199` shows only that bucket combination; it cannot prove that the
exact inventory was 720/330/195.
