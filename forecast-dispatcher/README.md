# Forecast publication dispatcher (M4)

Cron reads validated D1 candidates and delivers durable Discord reviews/results. It never calls
GitHub, consumes source-queue work, or publishes an artifact. Historical GitHub helper modules
remain only for the existing explicitly invoked diagnostic script, not the Worker entry point.
The Router is the only signer/publisher; see `forecast-interactions/README.md`.

Both environments default to `PUBLICATION_MODE=off` and `DISPATCH_ENABLED=false`. Enable both
only with separate rollout approval. `FORECAST_DB` must match `ENVIRONMENT`; the singleton
publication row permanently binds a database to its first configured environment.
Set `DISCORD_APPROVAL_CHANNEL_ID` to the Router's approval channel; there is deliberately no
fallback channel for publication reviews. The only required secret is `DISCORD_BOT_TOKEN`.
The existing Usage Guard gates scheduled work before D1 candidate reads or Discord delivery.

Each Cron seals at most one candidate and handles five publication outbox deliveries plus five
operational alerts/manual-review messages. Operational delivery works with publication off and
never dispatches GitHub workflows. Sealed reads check canonical hashes without re-deriving profiles.
Pending publication deliveries defer new sealing until an idle pass, so a run never combines
new profile derivation with a backlog of five candidate-message hash checks.
Reviews bind immutable
candidate/hash, environment, expected pointer sequence/previous candidate. Normal approvals expire
exactly 24 hours after creation, as do emergency controls. Clicking a stale/expired
emergency control asks the Router for a fresh, explicitly confirmed review against the current
pointer, without depending on Cron or Usage Guard. Rollback targets a previously approved artifact.
Approvals are never
inferred from candidate workflow state.

Delivery uses a one-minute lease, five attempts and a persisted retry deadline (minimum five
minutes; Discord `retry_after` honored). Expired leases are reclaimable after restarts. Exhausted
or permanent failures remain `dead` with evidence; they require explicit operator recovery.
Discord nonce deduplication is bounded by Discord's retention, so delivery is **at least once**,
not exactly once. A lost response can create a duplicate visible message later; only the saved
message ID is authorized, and atomic command/review constraints prevent duplicate publication.
Tokens, private keys and interaction webhook URLs are never persisted.

Local checks: `npm run test:forecast-dispatcher`, `npm run test:forecast-interactions`.
Live delivery, token/channel permissions, Cron resource budgets and nonce behavior still need an
explicitly authorized staging check.
