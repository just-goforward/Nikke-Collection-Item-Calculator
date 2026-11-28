# Reproduce the local candidate dependency installation (macOS arm64)

In a fresh candidate checkout, run the following from its root. This installs no global tool, does not write through the inherited root symlink, and does not deploy anything. The published Node archive is checked against the official SHA256 listing over HTTPS. The initial npm is the one shipped with that Node archive; the project npm is installed separately rather than assuming the bundled version is current.

```sh
set -eu
D="$PWD/.artifacts/dependency-tools"
mkdir -p "$D/bin"
(
  cd "$D"
  archive=node-v26.13.1-darwin-arm64.tar.gz
  curl -fsSLO "https://nodejs.org/dist/v26.13.1/$archive"
  curl -fsSL https://nodejs.org/dist/v26.13.1/SHASUMS256.txt | grep "  $archive\$" | shasum -a 256 -c -
  tar -xzf "$archive"
  ln -sf ../node-v26.13.1-darwin-arm64/bin/node bin/node
)
export PATH="$D/bin:$PATH" PNPM_CONFIG_STORE_DIR="$D/store" PLAYWRIGHT_BROWSERS_PATH="$D/browsers"
node "$D/node-v26.13.1-darwin-arm64/lib/node_modules/npm/bin/npm-cli.js" install --prefix "$D" --cache "$D/cache" --ignore-scripts --no-package-lock --no-save npm@12.2.3 @pnpm/exe@12.21.0
ln -sf ../node_modules/npm/bin/npm-cli.js "$D/bin/npm"
ln -sf ../node_modules/@pnpm/exe.darwin-arm64/pnpm "$D/bin/pnpm"
test "$(node -v)/$(npm -v)/$(pnpm -v)" = v26.13.1/12.2.3/12.21.0
if test -L node_modules; then unlink node_modules; fi
pnpm install --frozen-lockfile
pnpm install --frozen-lockfile --offline
node node_modules/@playwright/test/cli.js install chromium
export CARGO_HOME="$D/cargo"
cargo +1.99.1 fetch --locked --manifest-path rust/service-h14/Cargo.toml
cargo +1.99.1 metadata --offline --locked --manifest-path rust/service-h14/Cargo.toml --format-version 1 >/dev/null
```

With Chromium installed, `node --test e2e/stock-undo.test.mjs` checks that immediate focus, typing and Calculate use the restored stock after Undo. It is an offline component regression, not a package or release qualification.

To regenerate the workspace lock after intentional manifest changes, use `pnpm install --no-frozen-lockfile` before the frozen checks. Retain the release-age gate and the exact lifecycle allowlist; do not automatically exempt freshly published versions. Production website packaging has its own identity, trust and artifact validation steps. Installing dependencies alone does not authenticate or release the site.

## Selection boundaries (2026-11-22)

- Node 26.13.1 is the current 26 LTS release (not 27 alpha); its bundled npm is 11.20.0, not the selected npm 12.2.3. The Site CI bootstrap independently checks the npm tarball and linux-x64 pnpm binary archive before exposing either on PATH. The separate budget-watch and rollback workflows explicitly check out immutable historical tooling at `37311d5e1935c24f0aca764cf17ab9069e170792`; they still consume that snapshot's npm/lock, not this workspace.
- All eight pnpm importers are installed. Stable direct npm releases are selected except `blake3-wasm@2.1.5` (3.0.0 requires unpublished `@c4312/blake3-internal@2.1.7`, registry 404), and `fast-check@4.10.2` (4.11.0 would require a release-age exception). `miniflare@5.20261119.0-beta` is the exact dependency of both Wrangler 4.166.0 and the Cloudflare Vitest plugin 1.9.0; the older v4 `latest` tag is not their runtime. `node-domexception@1.0.0` is a deprecated transitive dependency, not an ignored installation failure.
- Rust stable 1.100.0 was available. The reference certified asset stays on 1.99.0, the H14 native build and root default stay on 1.99.1. Replacing them or their Cargo locks changes the input to native provenance and is not a dependency-only refresh of the validated solver. `rust/certified` and `rust/service-h14` have the same 16 locked registry dependencies; `rust/solver-rs` has none. Compared with crates.io stable, `num-bigint` 0.4.8 vs 0.5.1 is an exact-pin/major-line constraint; `itoa` 1.0.18 vs 1.0.19 and `syn` 3.0.9 vs 3.0.10 are intentionally retained transitive pins, not known-incompatible updates. The other 13 match. A native attestation for the changed JS inputs must be regenerated using the real Rust build; never relabel prior bytes or their historical build receipt.
- Full per-importer registry/installed inventory, all Cargo locks and per-version OSV queries are in the main evidence directory `.artifacts/production-root-candidate/dependencies/inventory.json`; `audit.json` contains the pnpm advisory results. These are point-in-time scans, not guarantees of absence of vulnerabilities.

## Local production-policy diagnosis (not release admission)

On a fresh checkout with the frozen dependencies above, `pnpm run build:operations` builds `dist-service-bundled/` with bundled forecast, empty trust keys and no root capability. It will not overwrite an existing output. It records each step in a private `local-service-profile-*` directory under the OS temp directory. Only this local command uses `scripts/formal-local-service.config.mjs`; the preview, private root and production packaging targets keep their own guards. The diagnostic receipt reports the actual H14 policy, not the legacy solver's policy.

Vite success is **not** a successful package. The final command still invokes the original production packager and its content check. At the `ca290405` baseline the source shell has no statistics bootstrap and this command stops at the packager's exactly-one-script guard. Do not add a fake bootstrap, copy a production receipt, or treat an unsealed directory as a candidate.

To reproduce the **diagnosis only** after that failure, in the disposable checkout with no `dist`, link `dist` to `dist-service-bundled` (the unchanged Miniflare server reads `dist`). Set `OPERATIONAL_PRIVATE_RESULTS_DIR` to a fresh, absolute, non-symlinked directory outside the checkout. Run each original reporter once:

```sh
node node_modules/vitest/vitest.mjs run --config vitest.operational-ci.config.ts
node node_modules/@playwright/test/cli.js test --config playwright.operational-ci.config.ts
node node_modules/@playwright/test/cli.js test --config playwright.analytics-ci.config.ts
```

`P001`–`P008` are still the approved historical cases; they are not a Hybrid B oracle. The cases that require `certified-staging`, its WASM, and its exact-rational wire cannot be satisfied by relabeling a `service-fused-h14-v1` result. Independent B enrollment needs a distinct suite/IDs bound to the exact reviewed consumer, Worker graph, WASM, signed forecast and policy. Retain the three locales, storage/network isolation, genuine result and stock transitions, fail-closed WASM failure and analytics controls. Separately authorize the statistics policy, numerical reference and protected-main source; a local report changes none of those gates.

## Protected root-pair preparation (not a publication command)

`site-source-verify.yml` always runs the common type, operations and publication-guard checks. No enrolled source record means the original K1R2 build, content validation and verification artifact. For a tracked prospective record, `root-source-profile.mjs` checks the production-only target/key and all three identities against `assertServiceH14Build()`. A PR can complete the **review-only** isolated root build and formal source checks without a future main SHA or publication grant. Only a protected-main push with independent exact-source approval can select `root`; malformed or unapproved main enrollment fails, not a legacy fallback. Both root source lanes build only isolated, nondeployable assets. `prepare-root-pair` checks the successful **push to main**, both required successful jobs, source SHA and exact run attempt. A PR check, producer signature or private comparison alone is insufficient.

The non-secret repository source pin `ROOT_PAIR_SOURCE_APPROVAL_SHA256` binds SHA-256 of UTF-8 `JSON.stringify(["production-root-source-review-v1",repository,protectedMainSHA,sha256(originalEnrollmentContractBytes)])`. The owner must explicitly approve the actual merged source after an independently recorded technical review; archive that record before setting the pin. This is source verification only. Rerun its exact main **push** check, not the PR or promotion workflow. Neither source verification nor the pin grants publication.

**External prerequisites; none are created here.** Under the [single-operator policy](root-rum-witness.md#single-operator-review-record-signature-and-rehearsal), the actual owner is the only human release approver. Protected main/environment, no admin bypass, independent technical records and protected administration of every pin remain mandatory. Never set a repository/organization fallback for an environment-only variable. The owner must independently verify the original input bytes before provisioning ROOT_PAIR_REVIEW_RUN_ID, ROOT_PAIR_REVIEW_ARTIFACT_ID and ROOT_PAIR_REVIEW_SHA256. Dispatch cannot supply these values.

The independent input artifact must contain these files (no signing secrets or deploy credentials). The five-report inventory below describes the **historical 6635d225 profile**; the successor keeps the same recovery inputs, public direction receipts and source/run gates but requires the [separate hybrid-B evidence contract](hybrid-b-release.md).

* `archive/{capture.json,validated.json,recovery/**}`: original v14 closure; `v14-site-production.json`, `v14-manifest.json`, `v14-forecast-runtime.json`: original `.vite` files from the corresponding v14 build. The capture pins the first receipt; that receipt pins the other two. `enrollment` is the unmodified enrollment evidence named by the protected source's `site-worker/production-root-release-v1.json`. The runner reads its own fresh signed API response.
* `v14-worker/{worker,v14}/`: the exact frozen 130-file carrier (`210a964323e9483f123600c52ed95fca9d15de8d9758cce89135aeeb34af4da5`). `worker/worker.js` is the authenticated version's original `17190d4c…` module, not a rebuild or a new upload authorization. The matching metafile was independently reproduced from `0b08fd58e53b6ae9b581eb076d2576903e2a2b04` using Node 26.13.0, npm 12.2.1 `ci --ignore-scripts`, Wrangler 4.156.1 `--dry-run` (config `site-worker/production.wrangler.toml`, outdir `.artifacts/v14-bundle`, metafile `.artifacts/v14-meta.json`). Its bundle was byte-identical. This is not a claim to have recovered the expired GitHub release archive. Both new root seals bind the original capture, reproduction metadata, exact old npm lock and physical dependency closure, plus the new source SHA and public asset review. Root seal/restore/verify rerun the original pinned dependency validator; no current pnpm metadata is attributed to the historical module. The current Site Worker source tree and config must equal v14. Version 2 cannot be consumed by the legacy version 1 publication path.
* `numerical-boundary.json`, `production-policy.json`, `analytics-policy.json`: actual complete, first-attempt formal reports. `root-numerical.json`, `root-product.json`: separately adjudicated original evidence for this exact production-key build, product behavior and all three locales. The script checks these latter two **digests**, not the human judgments. The authority must compare them to the reviewed source and exact served trees; a history run is not the substitute.
* `public-review.json`: exact keys `profile` (`production-root-pair-release-v1`), `repository`, `source` (full main SHA), `sourceRun`, `sourceAttempt` (positive decimal strings), `origin`, `siteWorker`, `enrollmentContractSha256`, `expiresAt` (epoch milliseconds), `headersSha256`, `evidence` (five report base names above, mapped to SHA-256), `directions`. `directions` contains `rollback` and `forward`, each with `servedSha256`, `operationalSha256`, `serviceSha256`. `servedSha256` is SHA-256 of UTF-8 `JSON.stringify(sortedURLs.map(url => [url, files[url].bytes, files[url].sha256]))` over the role's previously independently reviewed private comparison. The separate headers pin binds the serving policy.
* Each direction has its own `ROLE/local-operational-profile.json` and `ROLE/service-h14.json`: original, independently authorized **public** receipts, with keys `profile`, `role`, `source`, `servedSha256` plus the two respective authority fields checked by `publicMetadata` in `scripts/ci/prepare-root-pair.mjs`. The preparer verifies their exact digests and does not issue, edit, sign or reinterpret a private receipt. Never use this document or an example as an approval.

Success retains two separately sealed Site artifacts, plus `root-pair-receipt-*` only **after both** ID-selected downloads pass the sealed checks. The receipt binds both archive hashes, manifest hashes, IDs, SHA, run, attempt and canary; an orphaned/expired artifact or just one valid direction is not a release pair. The source of the canary JSON contains runner-local paths; rechecking the served inventories against the seals does not require those paths.

### Hybrid B browser evidence

On the successor, the BP9/BA12 harness must be checked into the product's **same exact** reviewed protected SHA. The private Ubuntu builder and verifier are separate workflows; neither a private runner checkout nor its own green result authorizes the public job. [Admission and custody](hybrid-b-release.md) specifies owner-precommitted service observations, advisory technical review, the 52-obligation crosswalk, the source transition and the stopping point. Do not open another campaign for a failed package.

### Direction-specific public promotion

The enrolled Site cannot be published by `publish-existing` or any local legacy/off/rebuild production Site selector. `publish-root-pair` in the serialized protected workflow calls `deploy-site.ts production-root-sealed`. Preparation never starts it. Each direction requires its own signed decision and a completed bidirectional rehearsal:

1. `root-install-bridge` starts only at the reviewed single-version v14 deployment and publishes the rollback seal (old documents, both asset trees). Only a public byte/header sweep, real ko/en/ja pages, Korean calculation with the actual Worker/WASM, and final control-plane and producer readbacks produce `BRIDGE_READY`.
2. `root-activate-forward` requires an ID-selected, successful bridge artifact for the **same handoff**. Its version/deployment must still serve 100%, have the rollback seal marker, and serve the bridge bytes. No bridge receipt, no forward write.
3. `root-restore-rollback` requires the bridge receipt, observed active forward deployment and forward seal marker, plus the [full switch-time proof](root-rum-witness.md). It restores the dual-asset rollback seal, never raw v14. A failed forward postcheck is not a receipt. The separately signed restore requires exact forward control ownership and fresh protected previews, not a working forward calculation. The restored rollback must pass the full browser proof.
4. `root-abandon-bridge` is a separate **read-only** exit for an installed bridge that never became forward. It binds the authenticated BRIDGE_READY version/deployment to the grant FROM (or, if bridge health failed, the original bridge write checkpoint as described below), verifies current four-route control, serves the exact rollback seal and runs full rollback regional/producer/config checks. Its terminal state is `BRIDGE_ABANDONED` with unchanged IDs, not a manufactured restoration or a second upload.

The site transition never installs an incident route or adjudicates DM receipt. The zone must already contain exactly the existing three route IDs (preview, calendar, joint supply) and the separately canary-approved, fail-closed `nikkecollection.com/api/recalculation-incident` route to `collection-kit-production-incidents`. No wildcard replacement, extra endpoint or concurrent withdrawal is accepted. Control checks also compare the actual version's `_headers` module digest before and after each direction.

The environment owner, **not the dispatcher**, supplies `ROOT_SITE_TRANSITION` as JSON with `profile=production-root-transition-v1`, exact `repository`, `source`, `operation`, `worker`, `hostname`, exclusive-window `expiresAt` (epoch ms), `minimumProducerSequence`, `fromDeployment`, `fromVersion`, `controlSha256`, `prepareRun`, `prepareAttempt`, `receiptId`, `receiptArchiveSha256`, `handoffSha256` and `bridge`. IDs/attempts are positive decimal strings. `bridge` is null only for initial installation; otherwise it contains `run`, `attempt`, `artifactId`, `archiveSha256`, `stateSha256` (original successful installation's `state.json`). GitHub metadata and the independent content pins are both checked. Do not set a less-trusted same-name fallback variable. No granted transition or operational credential is included here.

Hold a real exclusive window including **non-Actions** writers. The separate `CLOUDFLARE_ROOT_CONTROL_READ_TOKEN` environment secret needs Worker scripts/versions/settings/schedules, domain and zone route **read**. `observeSite` in `scripts/ci/root-promotion-live.mjs` produces the control fingerprint and current IDs from authenticated GETs; independently examine the actual controls before pinning. The existing write token goes only to the guarded publication step and Wrangler. No verification child, Chromium or public-origin request gets provider credentials. The workflow compares the producer version and fresh signed joint/calendar/legacy responses, target bindings/config/routes and immutable active module, then uploads only the restored assets and sealed entry. Wrangler does not offer atomic compare-and-swap against a prior deployment; workflow concurrency does not exclude outside writers.

Missing evidence, changed main, mixed traffic, expiry, drift or failed readback stops the sequence. **After a failed post-write check traffic may already have changed.** Never mark it READY manually. The operator must verify protection, independent technical custody, authenticated read scopes, artifact retention and a real exclusive window. Offline contract tests do not dispatch or measure a live Site switch.

### After an acknowledged write

The writer records Wrangler's structured version-ID ACK and preflight in `root-write-*` **before** any post-write health check. This artifact is not READY. The next step has no Site write token. GET transport gets at most three attempts for connection failures/408/429/selected 5xx (0/250/1000 ms waits; 12 s per request). Only the exact still-visible prior deployment can be retried as propagation; invalid bytes or an unrelated deployment fail immediately. Completion requires the written version at 100% with its exact predecessor, complete target health and unchanged controls. Do not rerun the write if a check fails.

For a later attempt dispatch `root-reconcile` only under a fresh protected owner decision **for that read-only operation/run/attempt**. The grant's `operation` remains the original direction. Retain its original FROM, handoff, config, browser and preview pins and include `reconcile={run,attempt,artifactId,archiveSha256,checkpointSha256,deployment}` identifying the original acknowledged write and the independently observed post-write deployment. The original run must have completed and its exact checkpoint-upload step succeeded. Even on a failed original run, re-download by verified ID/digest, check the member hash, ACK version, actual immediately preceding deployment and full target health; only then issue terminal evidence under the confirmation run. No checkpoint/ambiguous write, supersession, lost egress identity or expired pair review => no confirmation, no replay. An unhealthy acknowledged forward can instead undergo the separately authorized restore; neither operation is automatic.

If installation was acknowledged but never became BRIDGE_READY (including a vendor rotation), do not reconcile it as forward-ready under a changed pin. For a signed `root-abandon-bridge` grant only, set `bridge:null` and `bridgeWrite` to the same checkpoint-reference shape, with `deployment=fromDeployment`. This identifies the original `root-install-bridge` ACK. The consumer checks the exact original handoff/rollback seal, acknowledged FROM version, authenticated predecessor (approved v14), unchanged controls, original egress/config/preview and full **current** rollback health under the independently reviewed restore tag. A missing ACK is not a bridge. Never request both bridge proofs.

Keep pair seals, review inputs, checkpoints and terminal receipts in independent custody. Root workflow archives request 90 days (verify repository retention and review expiry before entering). A separate provider-credential-free `attest-root-state` job authenticates the terminal state; preserve the original bytes and bundle as described in the incident runbook. This allows later incident closure without treating an expired Actions download or an unsigned local file as authority. It does not extend a release window or authorize a future Site deployment.
