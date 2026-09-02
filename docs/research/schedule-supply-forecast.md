# Schedule-based kit-supply forecast research contract

## Status

- `[confirmed]` The product still uses the fixed 28-day gain vector from
  `supply-2026-08-21-v1`.
- `[confirmed]` The schedule model and dynamic Rust/WASM gain ABI preserve existing semantics when
  given that fixed vector.
- `[unverified]` No schedule forecast becomes active before the eight-hour staging shadow, production
  smoke, renewed H/p research, and a separate adoption pull request pass.

## Model boundary

The game day changes at 05:00 KST. A profile's `expectedGain` is a Solo-day-3-pivoted supply
reference, not necessarily unclaimed future inventory.
The previous game-day profile remains active through 04:59:59; the next profile and any weekly
reset take effect exactly at 05:00:00.

- On Solo days 1 and 2, users are assumed not to have spent kits yet. The reference accumulates
  expected supply from the previous Solo day 3 through the current Solo day, inclusive.
- From Solo day 3 through the end of that round, it includes the current game day through the
  current round's end plus the next round's days 1 and 2.
- Between rounds, it includes the current game day through the next round's day 2.

Profiles can therefore increase from day 1 to day 2, switch reference windows on day 3, and then
decline. Global monotonic decrease is not an invariant. Dispatch combines the no-reroll,
one-reroll, and two-reroll cohorts equally, yielding
`8.947399682 / 2.014546824 / 0.714208160` blue/purple/yellow per game day. Co-op shop supply is
fixed at five Kit Box II rewards for every Tuesday 05:00 inside the reference window, independent
of individual Co-op Operation dates. Once an official collaboration schedule is published, only
Tuesday resets inside that confirmed period are doubled to ten. An unpublished, estimated, or
ambiguous collaboration period does not enable the multiplier.

These rules are versioned as `schedule-kit-v2`; results are not merged with the old
`schedule-kit-v1` future-only model.

Naver Lounge boards 56 and 48 are the primary automatic evidence. The Free Worker Cron stores only
shallow feed metadata every three minutes. An offset three-minute Dispatcher requests the proposal
workflow when D1 contains actionable work; the `17,47` Actions schedule is only a thirty-minute
watchdog. Actions fetches structured SmartEditor JSON and performs schedule resolution and candidate
generation. X is checked only for
an existing candidate. When `X_API_BEARER_TOKEN` is configured, the official recent-search API is
the primary discovery path, restricted to Solo Raid, collaboration, Co-op Operation, and Kit Box
keywords from `@NIKKE_kr` and at most ten results. Author expansions must verify the official
account. Solo and collaboration dates are compared automatically; Co-op and Kit Box posts are kept
only as manual-review URLs. Without the token, or after a transient
API failure, Actions extracts status IDs from the server-rendered public profile and verifies every
ID, author, body, and timestamp through X's structured `tweet-result` embed response. It then tries
profile syndication `__NEXT_DATA__` and Jina Reader. An unavailable timeline requires manual
confirmation; a verified conflicting schedule produces an isolated draft pull request.

[Defuddle](https://github.com/kepano/defuddle) can normalize a known URL or accessible DOM to
Markdown, but it cannot reliably retain current status URLs from a profile; its optional X fallback
also uses FxTwitter. In a 2026-08-28 live check it read a known status and displayed profile text,
but the known-status output included adjacent timeline content and its profile Markdown omitted all
five status URLs present in the source. It is therefore not part of discovery or machine verification
and is not added as a second lossy representation of text already returned structurally by X API or
X embed data. [Jina
Reader](https://jina.ai/reader/) remains the last third-party advisory fallback. Status Snowflake
time is checked, a Jina match still requires manual source verification, and Jina alone cannot
create a conflict.

The documented primary discovery path requires the `X_API_BEARER_TOKEN` GitHub repository secret.
The X Developer Console app should be read-only, prepaid with a small spending limit and alert, and
must not receive post-write, DM, or account-management permissions. Missing credentials do not stop
the verified public-profile path, but rate limits or format changes in undocumented fallbacks
downgrade the result to the Discord/PR manual check. `npm run probe:forecast-x` prints only redacted
provider diagnostics.

- `[confirmed]` A 2026-08-28 live probe extracted five status IDs from the public profile HTML and
  verified all five `NIKKE_kr` authors, bodies, and timestamps through `tweet-result`. Timeline
  syndication and Jina were rate-limited during the same probe. The credential-free path therefore
  prioritizes profile IDs plus per-status structured verification and treats the other sources as
  isolated fallbacks.

- `[confirmed]` A live contract check on 2026-08-25 found that the latest manager posts on boards 48
  and 56, including the Solo Raid notice, return SmartEditor HTML rather than SmartEditor JSON. The
  current JSON-only boundary safely routes these posts to `manual_review`, but automatic Naver
  candidate generation cannot be enabled until a reviewed structured Actions-side parser exists.

The collector stores invocation evidence, cursor and queue metadata, and validated schedule and
candidate records. GitHub Actions revalidates the schema and hash and proposes an inactive registry
entry. Canary v6 uses an independent `canaryId` and generates expected Collector and Dispatcher Cron slots from a server-recorded start
over a fresh eight-hour window. Both Workers require at least 99% delivery and completion, at most
one missing slot, a completed latest invocation, no abandoned, late, unexpected, or duplicate work, consistent queue,
cursor, candidate, watermark, and manual-review state, and successful Dispatcher and signed Router
smoke evidence. A 30-minute burn-in and a 30-minute runtime watchdog aggregate every D1 database in
the Cloudflare account and preserve both the Forecast staging allowance and a statistics-production
reserve. The administrator's merge approves the evidence but does not activate the forecast.

After the canary passes, staging replays the official schedule ledger and creates an inactive
forecast pull request. The H/p workflow does not check out or execute pull-request code. It verifies
that the PR is a non-draft GitHub Actions bot proposal changing only the two registry files, then
extracts `shared/supplyForecasts.json` by immutable commit SHA. Exact interactive and H/p research
can therefore run before the administrator merges the proposal. After the exact-gate certificate
is complete, the Discord button records a staging-only approval. A separate workflow verifies the
certificate again and creates a staging adoption PR without merging it or changing the product
`activeForecastId`. After the administrator merges that PR and the Pages deployment completes,
registry v3 updates `stagingForecastId` and its compact runtime module. Requests to the same static
site with `?statsEnv=staging` then use the approved temporary forecast, while requests without that
query continue to use `activeForecastId`. No separate forecast staging Worker is operated.

## Renewed H/p study

The research matrix covers 21, 28, and 35 day cycles, confirmed and estimated schedules, and normal,
Solo day-1, day-2, and day-3 profiles. Every profile reruns the existing 49-point H/p grid against
`H=0.75, p=3`, using success probability, total expected uses, per-kit exhaustion, supply-debt
CVaR90, typed failures, and cold/warm latency. Candidate-specific `E[F_p]` values are not compared
directly across different p values.

Profile reports and checkpoints are isolated and resumable. Incomplete profiles continue for at
most 24 bounded workflow generations by default (generation 0 through 23), and the final aggregate
summary is emitted only after every exact gate completes. Reaching the configured limit first emits
a bounded-incomplete diagnostic certificate and then fails closed. Research output explicitly has
no product-adoption authority; any accepted change requires a separate adoption pull request.

Identical `blue/purple/yellow expectedGain` vectors are grouped by a SHA-256 identity and evaluated
once. Profiles that differ only by date, schedule status, or forecast profile ID remain in the
certificate as evidence aliases, while candidate aggregation counts the unique vector once. If
previous duplicate-profile results disagree, certificate generation fails instead of hiding the
conflict. The final exact-gate artifact records the solver WASM, rules version, candidate-grid,
screening/exact scenario-set, and per-gain result hashes and retains the certificate for 90 days.
The artifact also includes the profile matrix and one full canonical profile report per unique gain
vector. This preserves every date-level evidence alias without retaining duplicate result files and
keeps the decision inputs referenced by the summary hashes available for the same retention period.

The research matrix uses all 20 standard hosted-runner concurrency slots available on GitHub Free.
That allowance is account-wide, so unrelated CI or deployment jobs can remain queued until a slot is
released. Continuations already created by the legacy workflow finish without changing their
checkpoint set; new generation-0 campaigns enable `gain-vector-v1` deduplication.
