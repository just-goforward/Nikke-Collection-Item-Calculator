# v11 seal scope

This publication seals the 24-case independent current-stock evidence panel for
`certified-daily-v5` and `observed-median-v2`, with fixed 0/1/2-reroll weights
1:2:3. The snapshot was built through the collector's v5 writer. Median cadence
governs dated predictions and game-day shifts; observed mean cadence governs
long-run recurring supply. Source bytes are archived in
`scripts/certified-staging-approved-panel/v11/provenance.json`.

The engine identity is
`b233ab5229e6f3c59acc7ed701c065c512b6ed145cf65853b1e449f519927c01`.
The trust anchor is V11_PINS_SHA in
`scripts/certified-staging-approved-panel/v11/anchor.ts`:
`1fbce4c763218e39bc9fe442198cea30fa7623b91605581b1885f9036b56e5ae`.
`scripts/certified-staging-approved-panel/v11/pins.json` authenticates the
provenance and its three data files. The five reviewed artifacts were copied
byte-for-byte, not regenerated during installation.

Minimum-wait proof: **UNVERIFIED_NOT_REGENERATED**.
Dated prediction boundaries and grant means do not establish a regenerated
global minimum-wait proof.

The archived generation inputs precede installation of the trust anchor and
coverage registration. In particular, the archived
`scripts/certified-staging-approved-panel/v11/anchor.ts` is the pre-seal copy.
Do not regenerate or overwrite this sealed publication using the post-seal
working tree, and never call `regenerateDraft` on its root. Fresh temporary
drafts use their own returned anchors; they do not replace this seal.
No engine change, forecast activation, deployment or migration is included.
