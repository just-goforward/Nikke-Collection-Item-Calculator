# Schedule-based kit-supply forecast research contract

## Status

- `[confirmed]` The product still uses the fixed 28-day gain vector from
  `supply-2026-08-21-v1`.
- `[confirmed]` The schedule model and dynamic Rust/WASM gain ABI preserve existing semantics when
  given that fixed vector.
- `[unverified]` No schedule forecast becomes active before the 12-hour staging shadow, production
  smoke, renewed H/p research, and a separate adoption pull request pass.

## Model boundary

The game day changes at 05:00 KST. Rewards for the current game day are assumed to have already been
claimed and opened, so a profile contains only future gains from the next 05:00 boundary through
the boundary after Solo Raid day 3. Dispatch combines the no-reroll, one-reroll, and two-reroll
cohorts equally, yielding `8.947399682 / 2.014546824 / 0.714208160` blue/purple/yellow per day.
Future Tuesday resets add five Kit Box II rewards, or ten during an official collaboration period.

Naver Lounge boards 56 and 48 are the primary automatic evidence. The Free Worker Cron stores only
shallow feed metadata every three minutes. A five-minute GitHub Actions job fetches structured
SmartEditor JSON and performs schedule resolution and candidate generation. X is checked only for
an existing candidate: Actions tries the official embed, public profile, and Jina Reader once,
without an API, RSS bridge, login cookie, or private syndication endpoint. An unavailable timeline
requires manual confirmation; a conflicting schedule produces an isolated draft pull request.

[Defuddle](https://github.com/kepano/defuddle) is not adopted because it cleans an already
accessible DOM and its optional X fallback uses FxTwitter. [Jina Reader](https://jina.ai/reader/)
passed a live public-profile preflight, but it introduces a third-party fetch/cache intermediary
and is not accepted as authoritative schedule evidence. It runs only as the last advisory fallback;
a Jina match still requires manual source verification and Jina alone cannot create a conflict.

- `[confirmed]` A live contract check on 2026-08-25 found that the latest manager posts on boards 48
  and 56, including the Solo Raid notice, return SmartEditor HTML rather than SmartEditor JSON. The
  current JSON-only boundary safely routes these posts to `manual_review`, but automatic Naver
  candidate generation cannot be enabled until a reviewed structured Actions-side parser exists.

The collector stores invocation evidence, cursor and queue metadata, and validated schedule and
candidate records. GitHub Actions revalidates the schema and hash and proposes an inactive registry
entry. Canary v3 requires a 12-hour window, at least 200 invocations, at least 99% completion, zero
abandoned invocations, and consistent queues, cursors, candidates, and watermarks. The
administrator's merge approves the evidence but does not activate the forecast.

## Renewed H/p study

The research matrix covers 21, 28, and 35 day cycles, confirmed and estimated schedules, and normal,
Solo day-1, day-2, and day-3 profiles. Every profile reruns the existing 49-point H/p grid against
`H=0.75, p=3`, using success probability, total expected uses, per-kit exhaustion, supply-debt
CVaR90, typed failures, and cold/warm latency. Candidate-specific `E[F_p]` values are not compared
directly across different p values.

Profile reports and checkpoints are isolated and resumable. Research output explicitly has no
product-adoption authority; any accepted change requires a separate adoption pull request.
