# Runtime publication Router — contract v1

Local M4 implementation only. Deployment, migrations, key provisioning and Discord endpoint
changes require separate approval. Legacy test/PR-adoption buttons remain disabled. Manual
requeue/ignore controls retain D1-only decisions, audit, approver/alert-channel authorization,
message binding and Usage Guard protection. No Router GitHub calls exist.

## Configuration

- `STAGING_PUBLICATION_MODE=enabled` opts staging in; default `off`.
- Production needs **both** `PRODUCTION_PUBLICATION_MODE=enabled` and
  `PRODUCTION_MUTATIONS_ENABLED=true`; both default off/false.
- Existing Discord signature/application/guild/channel controls remain. Exactly one **guild member**
  ID, `DISCORD_FORECAST_APPROVER_USER_ID`, can act. Set it to the existing approver's ID.
- `FORECAST_PUBLICATION_KEY_ID`: public identifier `[A-Za-z0-9_-]{1,64}`.
- User-created Router secret `FORECAST_PUBLICATION_SIGNING_KEY`: standard base64-encoded DER
  PKCS#8 Ed25519 private key, without PEM delimiters or whitespace. Never store it in D1,
  repository, logs or the dispatcher. The secret is optional at deployment; enabled publication
  fails closed before writes with a clear error if it is missing/invalid. No real keys are generated.
- The M5 consumer must pin the corresponding **raw 32-byte Ed25519 public key**, standard base64,
  and key ID in trusted deployment configuration. Do not trust a key sent by the API. V1 uses
  one pinned key; rotation/re-signing requires a separately reviewed trust-set migration.
- `STAGING_FORECAST_DB` and `PRODUCTION_FORECAST_DB` stay separate. A database's initial
  `forecast_runtime_active` singleton binds its environment permanently. Until sequence 1,
  no signed publication exists; M5 must use its bundled fallback.

### Isolated staging deployment

`forecast-interactions/staging.wrangler.toml` targets the separate Worker
`collection-kit-forecast-interactions-staging`. It binds only
`STAGING_FORECAST_DB` (`collection-kit-forecast-collector-staging`,
`49b5dc06-37ae-4245-896c-daea98562ed8`) and the existing shared `USAGE_GUARD_DB`
(`49b7f966-f4e8-4c2d-8453-279415737054`). The Router only reads Usage Guard state;
this is an application-level restriction, not a read-only D1 binding permission.
There is **no production forecast DB binding**. Production buttons cannot reach a
database or queue background work, even if production flags are accidentally enabled.
`/health` reports only the forecast databases bound to the deployment and reports
production publication/mutations disabled when its binding is absent.
The existing `forecast-interactions/wrangler.toml` and its shared-router deployment
remain unchanged.

Before any separately approved deployment, the owner must replace the staging
config's `unset` values with those for a **separate staging Discord application**:

| Variable | Owner-provided value |
| --- | --- |
| `DISCORD_PUBLIC_KEY` | Staging application's interaction verification public key |
| `DISCORD_APPLICATION_ID` | Staging application's ID |
| `DISCORD_GUILD_ID` | Guild hosting the staging application |
| `DISCORD_FORECAST_APPROVER_USER_ID` | Single authorized guild member ID |
| `DISCORD_APPROVAL_CHANNEL_ID` | Staging publication approval channel ID |
| `DISCORD_ALERT_CHANNEL_ID` | Staging manual-review alert channel ID |
| `DISCORD_ACTIVITY_CHANNEL_ID` | Staging activity channel ID |

Keep `PRODUCTION_PUBLICATION_MODE=off` and `PRODUCTION_MUTATIONS_ENABLED=false`.
`STAGING_PUBLICATION_MODE` defaults to `off`; enabling it is a separate owner decision.
`FORECAST_PUBLICATION_SIGNING_KEY` is optional until publication is enabled.
`FORECAST_PUBLICATION_KEY_ID` is the optional accompanying public key identifier,
not a private secret; its `unset` placeholder is not a provisioned signing identity.
Missing/invalid signing material fails closed. Provision any staging signing secret
against this config only, never the shared router, and never put private keys in TOML.

Optional secret `DISCORD_BOT_TOKEN` (the same bot token the dispatcher already uses; never
reset it for this) makes the public manual-review completion notice a native reply to the
review message. Without it, or if the reply is rejected, the notice is posted through the
interaction webhook instead. Set it with
`npx wrangler secret put DISCORD_BOT_TOKEN --config forecast-interactions/staging.wrangler.toml`.

Local checks (no deployment):

```sh
npm run typecheck:interactions-staging
```

This runs Wrangler type generation for the staging config into the ignored
`forecast-interactions/.wrangler/staging-worker-configuration.d.ts`, then compiles
the Router against that deployment's runtime declarations. The normal `typecheck`
script includes this check; no production declarations are used by this TS project.

Only after separate deployment authorization, `npm run deploy:forecast-interactions-staging`
uses the explicit staging config. Updating the staging application's interactions
endpoint to that Worker's `/discord/interactions` URL also requires separate approval.
Do not change the production Discord application's endpoint or credentials.
No secrets, Discord configuration, remote resources, or deployed Workers are changed
by adding this config or running the local checks.

## Exact signed format

`shared/forecastPublication.ts` is the pure producer/consumer contract. Canonical JSON recursively
sorts object keys by JavaScript UTF-16 code-unit order, retains array order, serializes JSON
primitives with `JSON.stringify`, rejects non-JSON/nonfinite values, and adds no whitespace.
All hashes/signatures operate on UTF-8 bytes. Hash: SHA-256, lowercase hex.
Stored candidate JSON may retain the collector's original key order; admission and verification
canonicalize the parsed value for hashing without rewriting sealed bytes.

D1 storage and Worker test fixtures live separately in `shared/forecast-publication/`.
The architecture checker forbids browser and pure shared modules from importing this backend root.

Artifact body = complete validated payloadVersion 4 / schedule-kit-v3 candidate with mandatory
validated certified-daily-v3 snapshot. Unknown top-level/schema fields, conflicting source status,
unsupported rules and altered deployed laws are rejected.

Artifact Ed25519 statement (canonicalized before signing):

```json
{"domain":"nikke.forecast.artifact.v1","environment":"staging","keyId":"configured-id","candidateId":"forecast-…","contentHash":"64-lowercase-hex"}
```

Pointer statement:

```json
{"domain":"nikke.forecast.pointer.v1","environment":"staging","keyId":"configured-id","sequence":1,"mode":"active","candidateId":"forecast-…","contentHash":"64-lowercase-hex","operationId":"Discord-interaction-id","issuedAt":1788231600000}
```

These examples show field sets, not serialized key order. A signed value is exactly
`{"statement": statement, "signature": standard-base64-64-byte-Ed25519-signature}`.
`issuedAt` is integer Unix milliseconds. Sequence is a positive safe integer, increments for
every approve/rollback/off, and is independent of forecast revision. Off uses `mode:"off"` and
**both** candidateId/contentHash null; it is signed like any other pointer.

Public envelope:
`{pointer: Signed<PointerStatement>, artifact: {authorization: Signed<ArtifactStatement>, candidate} | null}`.
Artifact is null iff off. Verification pins environment/key, recomputes the complete artifact
hash, validates rules/ledger and checks both signatures. A lower-than-highest-seen sequence is
rejected, even if otherwise valid. Equal sequence permits a cached refresh. Authenticity/sequence
do not prove freshness on a first visit; M5 must separately enforce its primary-read/cache deadline.

## D1 and failure semantics

0022 adds immutable `forecast_runtime_versions` metadata, sealing the existing candidate JSON.
0023 adds immutable reviews, approvals and activation history, a singleton active pointer,
retryable command records and a durable outbox. Triggers reject immutable UPDATE/DELETE and
replacement collisions across every unique key. Approved candidate/provenance rows are protected.

Approval signs both artifact and pointer **before** a transactional batch. History insertion
checks the exact expected sequence/previous candidate, review identity/hash/expiry, environment,
command/actor and approved target. A **new approval** also requires the candidate's current state
to be `crosschecked`, `x_unavailable`, or `proposed` inside that same transaction. A previously
delivered review cannot activate a subsequently superseded/terminal candidate. A seal protects
content, not eligibility; rollback continues to use previously approved artifacts.
The activation trigger changes exactly one pointer row and one command
row, then inserts the result outbox. Any trigger/signature/SQL failure leaves no approval,
activation or result notification; the failure command remains retryable. Direct pointer writes
and activation of unapproved targets are rejected. A duplicate successful command returns its
original sequence without reactivating an old artifact. Different request bytes for the same
interaction ID are rejected.

Router acknowledges publication interactions with a **non-ephemeral** deferred response in the
authenticated approval channel, then edits that durable message. After each active result
(first approval included, and rollback), it includes explicit **off** confirmation plus rollback
when a previous approved artifact exists. Each control is bound in D1 to the message/channel,
activation operation, exact sequence, and target/hash. These messages survive client reloads and
do not require Cron. Off results offer rollback rather than a redundant off button.
Original review buttons survive failures. Database commit is not undone on Discord response
failure: the durable result outbox and duplicate-command lookup recover the outcome after restart.

Normal approval requires Usage Guard authorization. **User policy decision:** emergency
**rollback and off are allowed during Usage Guard stop** and deliberately do not query Usage Guard,
so hard-stop/missing/stale state cannot prevent them. **Rollback after off reactivates the last
approved artifact that was active before off**, with its exact previously approved hash and a new
monotonic sequence; it is not a new approval. Normal approve reviews
expire exactly 24 hours after creation, as do emergency controls. A click on a stale/expired emergency
control does not publish anything: the Router sends a fresh durable review bound to the current
sequence and the exact prior target/hash. A second explicit click is required. Its message identity
is persisted with a delivery lease. This human-triggered renewal works even when Cron is stopped.
All identity, environment, signature, expiry, target-hash and sequence checks still apply.

Staging checks still needed: D1 trigger/batch behavior on deployed engine, real signed interactions,
one-approver/channel permissions, competing clicks, webhook failure after commit, lease recovery,
stop-state emergency controls, rollback/off adoption, signature verification in supported browsers,
and measured CPU/D1 usage within existing limits. No local test establishes deployed behavior.
