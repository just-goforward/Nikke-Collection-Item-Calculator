# Schedule-based kit-supply forecast research contract

## Status

- `[confirmed]` The product still uses the fixed 28-day gain vector from
  `supply-2026-08-21-v1`.
- `[confirmed]` The schedule model and dynamic Rust/WASM gain ABI preserve existing semantics when
  given that fixed vector.
- `[unverified]` No schedule forecast becomes active before the 24-hour staging shadow, production
  smoke, renewed H/p research, and a separate adoption pull request pass.

## Model boundary

The game day changes at 05:00 KST. Rewards for the current game day are assumed to have already been
claimed and opened, so a profile contains only future gains from the next 05:00 boundary through
the boundary after Solo Raid day 3. Dispatch combines the no-reroll, one-reroll, and two-reroll
cohorts equally, yielding `8.947399682 / 2.014546824 / 0.714208160` blue/purple/yellow per day.
Future Tuesday resets add five Kit Box II rewards, or ten during an official collaboration period.

Naver Lounge boards 56 and 48 are the primary automatic evidence. A public Browser Run visit to X
is advisory and uses neither an API token nor unofficial RSS. An unavailable X page requires manual
confirmation; conflicting official sources block the proposal.

The collector only stores candidates. GitHub Actions revalidates the schema and hash and proposes
an inactive registry entry. The administrator's merge approves that evidence, but does not activate
the forecast.

## Renewed H/p study

The research matrix covers 21, 28, and 35 day cycles, confirmed and estimated schedules, and normal,
Solo day-1, day-2, and day-3 profiles. Every profile reruns the existing 49-point H/p grid against
`H=0.75, p=3`, using success probability, total expected uses, per-kit exhaustion, supply-debt
CVaR90, typed failures, and cold/warm latency. Candidate-specific `E[F_p]` values are not compared
directly across different p values.

Profile reports and checkpoints are isolated and resumable. Research output explicitly has no
product-adoption authority; any accepted change requires a separate adoption pull request.
