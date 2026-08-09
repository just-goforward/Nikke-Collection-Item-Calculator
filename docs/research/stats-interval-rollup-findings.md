# Statistics Interval Model and D1 Rollup Review

Reviewed: 2026-08-09

## Decision

- `[confirmed]` Keep the Wilson interval. On production aggregates, its classifications matched the heterogeneous Bernoulli score classifications for all three kits, six grade segments, and the overall aggregate.
- `[confirmed]` The standard-error width corresponding to the current Wilson range was about 3% to 12% wider than the value implied by the per-attempt probabilities. It is conservative for the current data rather than overly narrow.
- `[confirmed]` Do not add a D1 rollup table. The current row count and query latency do not justify the write, migration, and operational cost of a materialized rollup.
- `[inference]` Until data volume grows or a classification mismatch is observed, adding a more complex interval model or D1 schema has low value relative to its maintenance risk.

## Data Snapshot

The review used a read-only snapshot of the production `collection-kit-stats` D1 database.

| Item | Value |
|---|---:|
| Aggregate period | 2026-05-06 to 2026-08-09 |
| `event_aggregates` rows | 2,817 |
| Result events | 3,124 |
| Actual kit attempts | 7,060 |
| Super Successes | 400 |
| Active dates | 86 |
| D1 size | 2,801,664 bytes (about 2.67 MiB) |

Events are not unique users. One person may contribute repeated calculations and result events.

## Interval Validation

The UI applies a Wilson 95% interval to the observed rate and compares it with the theoretical rate weighted by attempts for each grade, level, and kit. The audit compared two classifications over the 61 production `grade/level/kit` groups:

1. the current Wilson interval and weighted theoretical rate;
2. a heterogeneous score using `sum(p_i(1-p_i))` for the per-attempt variance.

None of the nine displayed aggregates or the audited overall aggregate changed classification. The standard-error estimate corresponding to the current Wilson width was about 1.03 to 1.12 times the heterogeneous-variance width.

```text
sum p_i(1-p_i)
= N * p_bar * (1 - p_bar) - N * Var(p_i)
<= N * p_bar * (1 - p_bar)
```

Treating different attempt probabilities as one average binomial probability therefore increases, rather than decreases, the variance used by the display. This intentionally avoids an aggressive narrow range.

A recommended run ends as soon as a failed attempt changes the level, so all recorded attempts in one result event use the starting-level probability. Replaying 1,134 unique production event signatures found zero violations. Worker validation now enforces this contract for future events.

The `95%` label does not describe independent users or the user population. It is a conservative aid for understanding uncertainty in the observed rate at the recorded attempt count.

## D1 Query Validation

The production `/api/stats` aggregate SQL was executed sequentially nine times.

| Item | Value |
|---|---:|
| Returned groups | 61 |
| Main-query rows read | 5,634 |
| Today-query rows read | 13 |
| Total rows read | 5,647 |
| Main-query SQL p50 | 2.9613 ms |
| Main-query SQL p95 | 3.6620 ms |

The response already has a 60-second CDN cache and an ETag. Its returned group count is bounded by `2 grades × 15 levels × 3 kits = 90`. The current query is not a bottleneck.

Reopen the rollup design when any of these conditions is observed:

- `stats_query_completed.rowsRead >= 50,000` for seven consecutive days;
- seven-day rolling p95 `stats_query_completed.durationMs >= 25ms`;
- user-visible stats latency or D1 cost becomes an observed operational problem.

These thresholds leave roughly 7x to 9x headroom over the measured baseline. Traffic growth may change, so logs, rather than a projected date, determine when to revisit the decision.
