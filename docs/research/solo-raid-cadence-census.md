# Full Solo Raid Cadence Census

## Conclusion

- `[confirmed]` The official NIKKE Naver Lounge ledger contains 40 new Solo Raid rounds from the
  first round through the August 2026 round.
- `[confirmed]` Interruptions, resumptions, and extensions remain segments of their original round
  and are not counted as new starts.
- `[confirmed]` The 39 start-to-start intervals have a **28-day median**, a **30.6923-day mean**, a
  21-day minimum, and a 42-day maximum.
- `[inference]` Because the 41- and 42-day gaps pull the mean upward, 28 days is the more robust
  default estimate while the next official schedule is unknown.
- `[unverified]` The median is not a schedule guarantee. A published official date always replaces
  the estimate.

Game dates use the KST 05:00 boundary. The canonical 40-row ledger, official Naver feed IDs, and
derived statistics live in `shared/soloRaidCadence.ts`. The implementation test recomputes the round
count, interval count, distribution, mean, and median.

## Interval Distribution

| Interval | Count |
|---:|---:|
| 21 days | 2 |
| 22 days | 1 |
| 23 days | 1 |
| 26 days | 1 |
| 27 days | 1 |
| 28 days | 17 |
| 29 days | 1 |
| 34 days | 1 |
| 35 days | 9 |
| 36 days | 1 |
| 41 days | 1 |
| 42 days | 3 |

The Korean companion report lists all 40 dates and their official source links:
`docs/research/solo-raid-cadence-census.ko.md`.
