# Personal-data Worker — M0 / M1 / M3 / M7 / M8 (local only)

This directory owns a separate Google OIDC/session Worker and three local D1
stores. No production binding, cron, publication, deployment, or UI integration
is provisioned. Existing anonymous statistics remain separate and cookie-free.
Guests retain all calculator functionality. M3 pins `openid-client` **6.8.8**
with app-owned D1 sessions. Better Auth was rejected by the approved spike /
Advisor decision; it does not meet this application's identity/session contract.

## Beta decision and post-beta production gate

**Public statistics and population ranks are not offered during the beta.**
Keep `PUBLICATION_ENABLED = "false"`; the retained M8 code is a disabled local
prototype, not an approved beta or production publication design.
`GET /v1/statistics` and `GET /v1/self-percentile` return **404**
`{"error":"feature_unavailable"}` with no-store while disabled, without reading
publication/rank stores or requiring a session. The disabled coordinator neither
reads contributions nor computes or stores self ranks, including on its cron lane.
Consent GET remains available for historical decisions; `PUT /v1/consent` and
`PUT /api/personal/settings` return the same **404 feature_unavailable** during
beta, without session or consent-store access. The retained write implementation
is only exercised in explicitly enabled local prototype tests.
Beta-era decisions have **no publication or population-ranking effect**.
Existing privacy withdrawal/deletion safeguards remain active.

**Production gate — revisit, do not enable:** public statistics and population
ranks are deferred until **after the beta** and require a redesigned,
independently reviewed publication policy with **user-level differential privacy,
fixed taxonomy, monthly cadence, and withdrawal takedown**. The weekly k-suppressed
prototype below does not satisfy that gate. Changing the flag is not sufficient
approval to publish. Any future publication must **re-collect explicit consent
bound to the reviewed publication policy version**; beta-era decisions never
count as consent to that policy and must never be migrated into eligibility.
Additional re-enable gates remain **R2-PD-02** (the week check must be part of
atomic publisher admission), **R1-03**, **R1-04** (rank rows must not grow
without bound or count toward user quota), **R1-05**, **R1-06**, **N-PD-1**, and
**R2-PD-01** (enabled-path export). Export may then include only ranks bound to
the **currently published,
non-invalidated release**, respecting the current privacy fence; the retained
enabled prototype's export is not approved for post-beta use.

During beta, no ranks are offered, including through export: disabled export
returns `selfPercentiles: []` even for pre-existing/restored rows. Ranks are
derived data, not user content, and are excluded from measured content quota and
new-archive quota checks. PERSONAL migration `0008` deletes all prototype rank
rows as a **beta reset of derived data** (nothing is deployed yet); personal
documents, stages, archives, sessions and privacy authority are preserved.
Restore maintenance (`reapplyTombstones`, before gated reconciliation) purges restored
rank rows before service resumes. Re-running the migration ledger alone is not
enough after a restore that has already applied `0008`.

Inactivity is measured by successful **login + save only**. Consent, polling and
session touches do not refresh it. The shared-device frontend default is to keep
unsynced drafts on sign-out; frontend implementation is outside this directory.

## M0 contracts

`src/contracts.ts:Api` is the TypeScript wire-contract map. The contracts are
available as type-only imports from `@collection-kit/personal-data/contracts`.
This package entry intentionally preserves the public M0 type contract; backend
implementation helpers are not public package exports. All timestamps are
Unix milliseconds. Private routes require an authenticated account, origin/CSRF
validation for mutations, and `Cache-Control: no-store`. M3 implements these
controls; missing configuration fails closed. Disabled statistics/rank routes
return 404 feature-unavailable; enabled but privacy-fenced statistics return 503.
Private ownership is derived only from the authenticated session.

Callback failures return **303** to `/?account_error=<code>` with no-store,
`Referrer-Policy: no-referrer`, an empty body and expiry of only the pending-flow
cookie (not the current account session). The entire redirect vocabulary is
`account_switch_requires_logout`, `google_issuer_unsupported`, `admission_full`,
`rate_limited`, `login_flow_expired`, `service_unavailable`, `unknown`.
`beta_full` maps to `admission_full`; an absent/expired/consumed pending flow maps
to `login_flow_expired`; generic validation/authentication failures map to
`unknown`; unexpected storage failures map to `service_unavailable`. No provider
error text, authorization code or state is copied to the redirect. The inert GET
bridge follows the POST redirect, then navigates to the app root using only the
same allowlist so the frontend can localize the message; a bridge network failure
navigates with `service_unavailable`. Login initiation and non-callback endpoints
retain their existing JSON status/error contracts.

| Route | Request / response |
| --- | --- |
| GET `/v1/workspace` | userId, revision, lastOpId, document, measured content quota |
| PUT `/v1/workspace` | `{opId, baseRevision, document, action}`; saved/replay, revision conflict, reused-op conflict, archive-quota result |
| GET `/v1/export` | versioned personal document, stages, pending archives, historical consent; empty selfPercentiles during beta |
| GET/PUT `/v1/consent` | GET includes userId and historical nullable decision; PUT (including settings alias) returns 404 feature-unavailable during beta |
| DELETE `/v1/account` | opId; fenced privacy operation acknowledgement |
| POST `/v1/sessions/revoke-all` | opId; revoke all server sessions including current |
| GET `/v1/statistics` | 404 feature-unavailable during beta; disabled weekly prototype retained locally |
| GET `/v1/self-percentile` | 404 feature-unavailable during beta; no population ranks offered |

Future HTTP mapping: malformed input 400, unauthenticated 401, beta full 403,
CAS/op conflict 409, new archive quota 422, accepted privacy operation 202,
disabled publication/ranks 404, enabled but unavailable/fenced public data 503.
A saved operation always reports its original
revision, even when newer saves have occurred. Clients must not overwrite their
newer document with a replay acknowledgement. Unknown/expired opIds use CAS;
there is no indefinite replay promise.

One account has exactly one workspace and one Google `(issuer, sub)` identity.
Email is neither stored nor used to link accounts. During beta consent is not
collected or editable; `null` and historical decisions remain excluded. Consent
is never a prerequisite for personal functionality. The retained local prototype
write API uses CAS and operation hashes, not policy-version-bound consent.

Stage summaries are lifetime, per-item/per-stage, editable in beta. Manual-entry
and verification flags travel with them. Pre-signup income stays personal and
must be subtracted from public contributions. Publication must validate
nonnegative values and exclude pre-signup income; M1 does not aggregate anything.
Write validation now requires nonnegative **safe integers**, at most
`Number.MAX_SAFE_INTEGER` (9,007,199,254,740,991) per item, for lifetime income,
pre-signup income and lifetime attempts/consumption. Each of these three sums
across the items of a stage must also stay at/below that exact arithmetic ceiling;
pre-signup income may not exceed lifetime income. No fractional/1e308 values
are accepted. Aggregation uses the same validator and flags/skips the entire
account/stage when restored rows are malformed, inconsistent or overflow the sum.
It neither publishes partial corrupt contributions nor throws after acquiring
the publisher merely because an input summary is invalid.
Weekly releases suppress small cells and disclose no exact extremes.
Self-percentiles are immutable per release, not a live ranking.

## M1 stores and invariants

* `PERSONAL_DB`: accounts, unique Google identities, hashed sessions, OAuth
  transactions, workspace revision/last-op/attempt nonce, `(user_id, op_id)`
  request-hash history, stage summaries, pending archives, frozen self ranks.
* `PRIVACY_CONTROL_DB`: authoritative consent decisions, durable withdrawal /
  deletion tombstones keyed by user ID, consent reservations and restartable privacy operations.
  Never overwrite this authority with an older personal-data backup.
* `PUBLIC_AGGREGATE_DB`: identifier-free weekly payloads, disclosure history,
  monotonic fence and current pointer. Initial state is blocked. Public payload
  M8 implements gated release construction; publication is disabled by default.

Admission is an atomic SELECT-conditioned INSERT inside a **single PERSONAL_DB
batch**, with a database trigger enforcing 150 active accounts even on a bypass.
Concurrent logins for the same identity converge on the same account. Deletion
frees an active-account slot. Authorization checks deletion tombstones by user ID
when serving restored state. A new post-deletion login may rejoin with a fresh
account ID; a temporary identity fence rejects only pre-deletion flows.

Save CAS and hash history commit in one PERSONAL_DB batch. An operation-success
row is inserted only if **both** resulting revision and last opId match and the
unique attempt nonce proves that invocation performed the write. A reused opId
with a different normalized request hash conflicts. JSON object order is
normalized; array order is significant. Archive/summary writes share the batch;
any constraint failure rolls back document and success record. Hash history is
kept for 30 days and pruned only after a winning save.

The beta's nominal quota is **1,500,000 logical UTF-8 content bytes**, including
workspace, stage-summary JSON and pending-archive JSON. Derived self-percentiles
are excluded, including any restored prototype rows.
These are not physical SQLite/database bytes; indexes, row metadata, identity,
sessions and op hashes are excluded. New archives are atomically rejected if
their resulting content total exceeds quota. A trigger also protects direct
archive insertion. Existing content is never evicted; ordinary edits/saves
remain possible even above the threshold. This follows the requirement that
quota blocks **only new archiving**, so it is not a hard physical disk cap.
Oversized HTTP input policy / operational disk-budget reserves need agreement
before beta launch. `newArchivingBlocked` also becomes true exactly at the limit.
An incoming archive that cannot fit is rejected even when this flag is false.

Sessions store only SHA-256 token hashes; random raw tokens belong only in a
`Secure; HttpOnly; SameSite=Lax; Path=/` host-only cookie at integration. Idle
expiry is 30 days, absolute expiry 90 days, with atomic touch refusing an expired
token. Session touches do not refresh the two-year inactivity clock. Only login
and successful saves update `last_active_at` monotonically. Scheduling deletion
after two calendar years without either uses the same fenced deletion path (M7).
OAuth transactions atomically consume once, bound to a browser hash and expiry;
M3 implements PKCE/state creation, callback validation and login-time expiry cleanup.

## Cross-store fence ordering and restore safety

D1 batches **cannot span bindings/databases**. There is no distributed
transaction here. Privacy processing uses this irreversible fail-closed order:

1. PUBLIC batch: increment fence generation, block publication, clear pointer,
   invalidate disclosure history and delete all retrievable release payloads.
   Identifier-free releases cannot be accurately subtracted by user; all are
   invalidated rather than retaining withdrawn contributions.
2. PRIVACY batch: write tombstone, participation=false and pending operation.
3. Reapply tombstones to PERSONAL: withdrawal clears participation/self ranks
   but **does not delete personal records**; deletion cascades all account rows.
4. Mark the privacy operation complete. **Do not unblock publication.**

A crash at any boundary leaves publication blocked. A crash before step 2 may
not have accepted the privacy request; retry is safe and advances the fence
again. Tombstones are re-applied after every personal restore, before serving
private requests or preparing releases. Restoring PUBLIC requires a maintenance
gate and generation reconciliation with privacy tombstones; never restore its
old fence/current pointer directly into service. An out-of-band database restore
cannot be made monotonic by a SQL trigger alone.

M1 deliberately offered no unblock/publisher. M8 adds a serialized coordinator
with durable PUBLIC admission markers/versioning before any cross-store privacy
write (described below). Checking two databases then unblocking alone is unsafe
(TOCTOU). Public reads validate pointer/release/current fence atomically.
Disclosure history retains only release policy metadata, no user IDs. Privacy
tombstones persist; re-opt-in semantics after withdrawal require a new authorized
decision generation, not tombstone removal.

## Local verification and tooling

Matches `stats-observer/` tooling: installed `@cloudflare/vitest-plugin` 1.4.1,
Vitest 5.0.4, Wrangler 4.150.0, TypeScript 7.0.2, compatibility 2026-08-22.
Tests run actual local Miniflare/workerd D1 bindings, not SQLite mocks.
Test files serialize their storage lanes. Each test explicitly drops the exact
local fixture tables (children first) and migration ledger, then applies real
migrations with `applyD1Migrations`; fixture reset is idempotent and does not rely
on the flaky generic `reset()` storage lifecycle. Race cases use concurrent HTTP
requests inside one isolated fixture.
The existing plugin brings Miniflare `5.20261006.2-beta` transitively; this is
existing project tooling, not a new direct prerelease selection.

From the project root, with existing dependencies:

```powershell
npm --prefix personal-data run test
npm --prefix personal-data run typecheck
```

Local Wrangler migration commands (not remote):

```powershell
npx --no-install wrangler d1 migrations apply PERSONAL_DB --local --config personal-data/wrangler.toml
npx --no-install wrangler d1 migrations apply PRIVACY_CONTROL_DB --local --config personal-data/wrangler.toml
npx --no-install wrangler d1 migrations apply PUBLIC_AGGREGATE_DB --local --config personal-data/wrangler.toml
```

M3 registers `personal-data` as a root npm workspace, adds `test:personal-data`
to `test:workers` and adds its typecheck to the root typecheck chain. Its exact
dependency and workspace records are in the root lockfile. No workflow changes.

## Documentation evidence

Read-only official Cloudflare documentation retrieved for M1 on 2026-10-14 UTC:

* <https://developers.cloudflare.com/d1/worker-api/d1-database/#batch>:
  batch statements execute sequentially; a failing statement aborts/rolls back
  the entire sequence; one database binding owns each batch. This supports CAS,
  atomic admission and save-plus-operation persistence; it does not support
  treating batches in three databases as one transaction.
* <https://developers.cloudflare.com/d1/best-practices/local-development/>:
  Miniflare uses the same underlying runtime, exposes local D1 via bindings,
  and supports programmatic D1 queries.
* <https://developers.cloudflare.com/workers/wrangler/configuration/#d1-databases>:
  separate binding names and migration directories identify each database.
* Context7 `/cloudflare/workers-sdk`, current repository docs:
  `cloudflareTest` plugin configuration and `cloudflare:test` reset, with local
  `cloudflare:workers` bindings. Not a version-specific documentation snapshot;
  installed 1.4.1 manifests and local tests establish compatibility.
  The installed plugin's declaration additionally documents `readD1Migrations`,
  used to parse the real three migration directories for these tests.

No account metadata, remote SQL, secrets or Cloudflare account APIs were read.

## M3 HTTP, trust boundaries and activity

New auth contracts: POST `/auth/login/google` with `{}` returns
`{authorizationUrl}` and an HttpOnly flow cookie. The caller navigates to that
fixed Google URL. GET `/auth/callback/google` returns an **inert database-wise**
nonce-CSP HTML bridge; it removes the query from browser history and POSTs
`{parameters: originalQueryString}` to the same path. Only the same-origin POST
consumes the flow and returns `{redirect:"/"}` plus the session cookie. This
deliberately avoids a state-changing cross-site GET: **every mutating endpoint,
including callback POST, checks exact Origin and rejects Sec-Fetch-Site values
other than absent or same-origin**. All callback responses are no-store and
no-referrer. The bridge has no externally hosted scripts, raw-query interpolation
or logging. Browser/UI verification remains a separate integration stage.

GET `/v1/account` returns authenticated account ID and consent; POST
`/auth/logout` revokes the current session. Existing site allowlist aliases are
supported unchanged: GET `/api/auth/session`, DELETE `/api/auth/session`
(current-session logout, **not account deletion**), POST `/api/auth/logout`,
GET/PUT `/api/personal/settings` (consent contract). M0 workspace/export/consent/
DELETE account/revoke-all/public/self-percentile paths are implemented as above.

Config is server-owned: HTTPS `SITE_ORIGIN`, `GOOGLE_CLIENT_ID`, separately
supplied `GOOGLE_CLIENT_SECRET`; redirect is exactly
`SITE_ORIGIN + "/auth/callback/google"`. No request can choose provider, issuer,
client, redirect, scope, account or workspace ID. Discovery, authorization,
token and JWKS endpoints are exact allowlisted Google URLs; outgoing redirects
are forbidden. Scope is only `openid`; no userinfo/refresh request is made and
no ID/access/refresh token is persisted.

Issuer compatibility fallback remains **fail-closed** for the pinned public
discovery/authorizationCodeGrant flow. HTTPS issuer tokens are fully validated;
bare `accounts.google.com` tokens return `google_issuer_unsupported`, never a
second account and never rewritten claims. The review correctly identifies both
forms as valid Google issuers. Version-specific evidence: oauth4webapi 3.8.8
`node_modules/oauth4webapi/build/index.js:1321` compares the token issuer exactly
to server metadata; `:1393` requires issuer/audience/expiry/subject before that
comparison. openid-client 6.8.8 `node_modules/openid-client/build/index.js:492`
clones/freezes metadata and installs the private issuer override only for Entra
ID; its public authorizationCodeGrant API has no Google alias override.
`node_modules/openid-client/build/index.js:139` wraps that comparison error.
The app recognizes only the known bare-issuer compatibility failure. This reason
is not a claim that the rejected token's signature was verified: the library
rejects its issuer before non-repudiation checks. Signature/issuer checks are
never bypassed. Tests cover HTTPS, bare and wrong issuers and same-sub absence
of duplicate accounts. Supporting both in a new validation flow remains a
separate reviewed library/API decision.

Versioned API evidence:
<https://github.com/panva/openid-client/blob/v6.8.8/docs/functions/authorizationCodeGrant.md>
and `enableNonRepudiationChecks.md` (Context7 `/panva/openid-client/v6.8.8`).
Retrieving <https://developers.google.com/identity/openid-connect> returned HTTP
404 in this session; that is not evidence against the review's Google contract.

`enableNonRepudiationChecks` is mandatory; library checks require signature,
iss, aud, exp, iat and nonce. App additionally rejects unexpected azp even for
a single audience. JWT clock tolerance is explicitly **30 seconds**; session
idle/absolute deadlines use strict `>` with **zero tolerance**. Only successful
user PUT saves/consent decisions refresh session idle expiry and cookie; GETs,
background polling and failed mutations never do. Login and winning saves update
the separate account inactivity timestamp; session activity does not postpone
the two-calendar-year login/save policy.

Flow TTL is 10 minutes. Expired flows and sessions are cleaned at login; callbacks
DELETE…RETURNING state/verifier/nonce/epoch atomically **before** exchange.
Any exchange/validation failure requires a fresh login. Limits are 10 login
attempts/minute/hashed trusted ingress IP, 100/minute globally, and 300 pending
flows; missing ingress IP shares one bucket. Rate buckets expire at the next
minute cleanup; no raw IP is stored. Ingress must preserve trusted CF headers
and direct public access must remain disabled. POST/PUT/DELETE JSON body limit
is 2,000,000 streamed bytes, IDs are ASCII 1–128 characters, workspace JSON
nesting is at most 32, and duplicate stage keys/unknown ownership fields fail.
This is a security request envelope, not a replacement for archive quota.
Fixed per-request outbound timeout is 5 seconds. Configuration discovery is
single-flight per isolate and reused; its library JWKS cache is reused, with
in-flight discovery/JWKS GET coalescing. oauth4webapi 3.8.8 refreshes cached keys
after 300 seconds and an unknown kid after a 60-second cooldown. During that
cooldown a legitimate newly rotated kid may fail closed and require restart.
There is no unbounded retry or global cache/lock spanning isolates.

Revocation guarantee: a PERSONAL_DB batch advances a monotonic global login
epoch, writes that epoch to the account and deletes all its sessions. Each flow
captures the global epoch when created (even anonymous flows). Callback's
atomic provisioning/session batch requires account epoch <= flow start epoch.
Thus either callback commits first and revoke deletes it, or revoke commits
first and callback cannot mint the session. Other accounts are unaffected.
Future authorization checks see revocation immediately on primary D1.
Requests authorized before revocation may complete; revoke-all does not retract
already returned data or cancel an already authorized save/consent operation.

DELETE account first commits the PUBLIC fence, then blocks the old account and
invalidates sessions in PERSONAL, then commits the PRIVACY user-ID tombstone.
A local deletion outbox survives a crash. A callback for that identity retries
at most its one affected job; unrelated requests never drain or depend on the
outbox. Explicit maintenance can retry a specified user. The temporary identity
hash fence lasts the 10-minute flow TTL: older flow epochs cannot recreate a
deleted account, while a fresh login creates a new account ID. Identity hashes
are no longer kept in privacy tombstones or deletion jobs. Expired temporary
fences, flows and sessions are cleaned at login and by the prepared 10-minute
cron for expiry cleanup and bounded privacy recovery (not deployed).
Physical cleanup depends on cron execution;
missed cleanup must be monitored before production. Restored old user IDs stay
denied/re-deleted by durable user-ID tombstones; fresh rejoin IDs are unaffected.
Consent re-opt-in uses a later fence generation; old withdrawal tombstones are
retained but do not override a newer authoritative opt-in. M8 publication
is disabled by default; no frozen ranks are served during beta. Future rank
serving requires the reviewed export/current-release gates stated above.

### Evidence, integration and remaining launch gates

Context7 `/panva/openid-client/v6.8.8`: discovery customFetch/timeout,
authorizationCodeGrant nonce/state/PKCE checks, enableNonRepudiationChecks and
clockTolerance. Installed dependency source confirms mandatory iss/aud/exp/iat,
the azp single-audience gap (closed by the app), and JWKS refresh/cooldown behavior.
Installed transitive versions: oauth4webapi 3.8.8, jose 6.2.12.
Cloudflare read-only docs:
<https://developers.cloudflare.com/d1/best-practices/read-replication/> states
that without the Sessions API all queries go to primary. Authorization uses
direct binding queries, never withSession; first-primary alone would not keep
subsequent queries on primary. Observability and invocation logs remain disabled,
with no console/error/request logging; responses contain only allowlisted codes.

DevOps owns `site-worker/`. Its existing three exact allowlist paths work with
this Worker, but new routes require these explicit additions (no wildcard):
POST `/auth/login/google`; GET/POST `/auth/callback/google`; POST `/auth/logout`;
GET/DELETE `/v1/account`; GET/PUT `/v1/workspace`; GET `/v1/export`;
GET/PUT `/v1/consent`; POST `/v1/sessions/revoke-all`;
GET `/v1/statistics`; GET `/v1/self-percentile`.
Provision the service binding/config/credential only under separate deployment
approval. No site-worker edits or remote actions are included here.

Remaining gates: independent Security review, browser bridge/UI tests, Google
real-provider acceptance including canonical issuer policy, operational rate/
quota budgets, M7 production review, post-beta publication/rank redesign review
(user-level differential privacy, fixed taxonomy, monthly cadence, withdrawal
takedown; revisit, not enable), and
maintenance gating/reconciliation for any database restore. D1 tests simulate
personal restore; they do not establish correctness of a live multi-database
restore. Cross-store privacy is deliberately fail-closed, not transactional.

## Review fixes: bounded work, account context and export

Callback refuses to replace a valid session belonging to a different identity:
409 `account_switch_requires_logout`, with no new account/session and no
replacement session cookie. The callback bridge tells the user to log out first.
Same-identity login can refresh normally. GET account also returns
`account.generation` (the account's revocation epoch). Frontends retain the
displayed `account.userId` and MUST send `If-Account-Match: "<userId>"` on every
workspace PUT, consent PUT (including the settings alias), account DELETE and
revoke-all POST. Missing context is 428 `account_context_required`; different,
weak or wildcard context is 409 `account_context_stale`. This header is a
precondition only, never an ownership selector. The session remains authoritative.
After a context mismatch, discard/refetch account/workspace state before saving.
All authenticated account-sensitive GETs also honor `If-Account-Match`:
account (including `/api/auth/session`), workspace, export, consent (including
`/api/personal/settings`) and self-percentile. A supplied header must exactly
match the quoted session user ID; mismatched, empty, unquoted, weak, wildcard
or multiple contexts return 409 with only `{"error":"account_context_stale"}`,
never personal response data. An absent header preserves compatibility (no 428).
Every successful private read identifies its session owner: `userId` on workspace,
consent and self-percentile, and `account.userId` on account and export (the exported
workspace also includes `userId`). Clients MUST bind subsequent private reads
to the displayed account with this header and verify the returned identity before
using any data; on mismatch discard the response and refresh account context.
Public statistics remain identifier-free and do not use this precondition.
Logout deliberately remains unconditional with respect to account context:
it only revokes the session cookie currently presented and still requires the
same-origin mutation checks. DELETE `/api/auth/session` is current-session logout,
not account deletion, and follows that choice.

Privacy HTTP paths reapply only the affected user's at-most-two tombstones.
Full `reapplyTombstones` is restore/maintenance-only, paged by 150 user IDs:
O(T) historical tombstones, not request-time work. `resumeDeletion` retries
one specified job and isolates its failure. No all-job retry precedes routes.

Consent preflight hashes/CAS plus an atomic per-user reservation happen before
any PUBLIC mutation. Reservation does not change participation. Only its owner
fences PUBLIC, then commits decision/history/tombstone and removes the reservation
atomically in PRIVACY. Stale requests, changed-op collisions and completed
replays never bump the fence. Concurrent contenders cannot both reserve.
An unfinished reservation with the same opId and matching request hash resumes
idempotently; changed hashes return 409 `op_id_conflict`. A different pending op
or a live attempt lease returns 409 `consent_change_pending`. Attempt leases last
60 seconds, release immediately on an observed failure, and guard every private
decision write. They do not change JWT/session deadlines. Recovery reuses a saved
PUBLIC fence; a crash between PUBLIC commit and saving its generation can safely
re-block/increment it again, never unblock it. Completed replays never increment
the fence. Deletion clears that old account's reservation.

The prepared scheduled handler drains at most one oldest-ready deletion OR one
stale consent reservation in its corresponding lane, in addition to expiry
cleanup. Each failed job is isolated. Indexed retry-due/creation ordering and a
one-minute scheduled retry delay prevent a stuck prefix from monopolizing later
jobs; matching consent requests do not wait for that scheduled backoff. Cron and
request retries acquire the same attempt lease. Pending deletion finishes without
a new login, deletes that user's records and frees the beta slot. HTTP paths stay
user-scoped. On callback, the existing account's deletion tombstone is applied
before provisioning so a restored old user ID cannot trap a fresh rejoin.

Archive ID reuse with a new opId is an atomic 409 `archive_id_conflict`, not
a raw UNIQUE-error 503. Export reads a single PERSONAL snapshot containing the
workspace and every stage/archive row counted toward logical quota,
and account `createdAt`/`lastActiveAt`, regardless of consent or publication.
The separate self-percentile display endpoint still filters unavailable releases.
Multibyte quota tests use CJK, accented text and supplementary Unicode.

## Pre-release migration and recovery policy (R2-03)

**Chosen: keep numbered migrations, do not squash.** `0001` is the M1 baseline;
PERSONAL/PRIVACY `0002` add auth/consent; `0003` replaces permanent identity bans with expiring
flow-generation fences and adds scoped consent reservations; `0004` adds bounded
job retry indexes and resumable consent attempt leases. PERSONAL `0005` adds
the inactivity index; PERSONAL `0007` adds a default-zero per-candidate inactivity
retry timestamp and replaces that index without changing existing account data.
PERSONAL `0008` resets derived ranks for beta, deliberately preserving no
prototype self-percentiles; ranks are no longer user-content quota.
PUBLIC `0002` adds publication intents, staging and
conditional-activation triggers without discarding existing releases. Upgrade tests seed
populated M1 and populated `0002` records, apply later migrations using
the migration ledger, and compare all protected fields before/after. Identities,
active and expired hashed sessions with their original idle/absolute deadlines,
workspace revision/document/last-op, operation hashes, stages, archives,
account timestamps, consent, tombstones, public fence/pointer/releases and
disclosure history are preserved. Old pending/consumed OAuth transactions are
deliberately discarded: those browser flows must restart. `0003` also discards
pre-change ephemeral flows so none can bypass the new deletion semantics.
Identity-hash removal from privacy tombstones is intentional, not data loss of
their authoritative user-ID deletion/withdrawal decisions.

For a future separately approved upgrade:

1. Close login/mutation/restore-serving gates and keep PUBLIC publication blocked;
   preserve a recovery copy of PERSONAL and migration metadata. Do not reset or
   roll back the current privacy authority or monotonic public generation.
2. Apply PRIVACY forward migrations first (preserving decisions/tombstones),
   then PERSONAL, then PUBLIC if it has new migrations. Batches cannot span DBs;
   interrupted stages stay gated and restart from their migration ledgers.
3. Deploy only code compatible with the forward schema. Reapply all current
   user-ID tombstones to any recovered/restored PERSONAL data, reconcile pending
   per-user operations, and reconcile the public fence under the maintenance gate.
   Restart expired/discarded OAuth flows; revoke recovered sessions if their
   revocation/deletion epoch cannot be proven current.
4. Prefer **forward-fix** migrations/code. No downgrade to M1/M3 code expecting
   `consumed_at`, permanent identity bans or identity-hash tombstones is supported.
   A PERSONAL-only recovery copy must be forward-migrated and reconciled before
   service resumes. Never restore an older PRIVACY_CONTROL_DB as recovery, and
   never restore an old PUBLIC fence/pointer into service. Migration tests are
   local preservation evidence, not proof of a live distributed restore.

M7 implements inactivity deletion in one-account cron batches, using the same
fenced deletion/outbox/rejoin path. Eligibility is exactly two UTC calendar years
after `last_active_at`; February 29 clips to February 28 in a non-leap anniversary
year. Login and winning saves refresh activity; polling, session touches and
consent decisions do not. The deletion batch rechecks the selected activity
timestamp, so a concurrent login/save wins before account blocking. Writes after
blocking are refused. The PUBLIC intent hides public reads before the guarded
PERSONAL claim. Only a winning claim creates an unready deletion outbox; its
finisher then invalidates PUBLIC and saves the generation before PRIVACY changes.
A lost activity race releases its intent without changing generation, pointer or
release payload. Legacy jobs default to already fenced. No pre-deletion warning was required by the agreed contract
and none is implemented. M7 is local-tested, not deployed.
Post-beta publication/rank redesign review, real Google legacy-issuer support and
browser integration remain separate production gates; publication stays disabled.

## M8 weekly publication prototype (local only; disabled throughout beta)

`PUBLICATION_ENABLED = "false"` in `wrangler.toml` gates both the coordinator
and public/rank display. Only the exact string `"true"` enables it; no HTTP
endpoint enables publication. The following describes only the retained prototype,
not the approved post-beta design. When enabled in local tests, its cron lane attempts a UTC Monday
weekly build only when that week's release is absent/invalidated. Two publishers
cannot acquire the same durable PUBLIC publisher slot. Withdrawal/deletion
invalidates every retrievable release immediately, then an enabled later cron
rebuilds within the same week from current authoritative consent. History records
policy/version, release/week/fence and invalidation timestamps, without identities.

The prototype metric is **post-signup lifetime income**, summed across an account's
items per stage (`lifetimeIncome - preSignupIncome`). One account contributes
once per stage/cohort, not once per item. Opt-in is read from PRIVACY at build
time, never inferred from the PERSONAL participation mirror. Deleted/blocked
accounts are excluded. Manual flags combine with OR; verification flags with AND.
Cohorts label verification as **self-reported**, not a server attestation; manual
and unverified observations never enter another cohort. Nonparticipants retain
private ranks and all other personal functionality but never add to public counts.

**k = 10 distinct accounts** per disclosed stage/cohort and per nonzero band:
conservative for the 150-account beta and more protective than single-digit
cells, but not a differential-privacy/anonymity proof. Ten fixed 100-income bands
cover [0,1000]; income at/above 1000 is clamped into the final band. Counts round
down to multiples of 10; counts below 10 are zero, and cells without any disclosed
band are suppressed (no ranks). No exact sample total, minimum, maximum, user ID,
subject, account metadata, item ID or raw income is published. Top/bottom bands
are censored tails, not assertions that the actual extremes are 0/1000.
Private percentile intervals use only this rounded published distribution, not
hidden exact ranks, and are immutable for each release even after a personal edit.
Prototype rank rows are derived, not quota-counted user content; beta reset and
restore maintenance delete them. Only new archiving is quota-blocked.
Stage names follow the M0 stage identifier contract; a reviewed public stage
taxonomy and disclosure/differencing analysis remain production review concerns.

### Ordering argument and crash recovery

Cloudflare D1 docs, retrieved read-only for M8:
<https://developers.cloudflare.com/d1/worker-api/d1-database/> states that a batch
executes sequentially as a transaction and rolls back the sequence on failure;
without Sessions API queries stay on primary. The three stores are separate
bindings: **no batch spans them**. Local tests use Wrangler 4.150.0 / workerd via
`@cloudflare/vitest-plugin` 1.4.1; no account API or remote query was used.

1. Every privacy writer first increments PUBLIC `pending_intents` and monotonic
   `intent_version`. Public display requires zero pending intents. This admission
   barrier precedes consent reservations/deletion account-blocking, closing the
   gap between a private preflight and its PUBLIC fence write. Stale/replayed
   consent requests do not increment `generation` or invalidate a release.
2. Accepted changes retain the PUBLIC-first generation block/payload invalidation,
   then PRIVACY decision/tombstone, PERSONAL application and completion. Only a
   known successful completion, controlled 4xx rejection or exception before
   attempting a durable write releases its intent. Ambiguous write failures and
   process death retain an individually identified, ten-minute lease even if a
   retry later completes the private job. Expiry alone never deletes that lease.
3. Publisher atomically acquires a token and blocks PUBLIC at `(generation,
   intent_version)` with no pending intents. It reads authoritative consent and
   pending queues, then one PERSONAL batch for summaries/blocked accounts/jobs.
   The PRIVACY pending-reservation/operation and PERSONAL deletion-job counts
   must all be zero. Later privacy admission changes the captured version even
   when the change completes before the publisher next checks.
4. Stage the identifier-free release under that exact token/version/generation;
   insert private frozen ranks while PUBLIC remains blocked. Then a **single
   PUBLIC batch** conditionally clears the block, marks the release published,
   updates the current pointer and inserts disclosure history only when token,
   generation, intent version and zero pending intents still match. Triggers
   additionally enforce release/pointer eligibility. Activation is the publication
   linearization point: a privacy admission after it blocks public reads first.
5. A known invalidated attempt removes only its own staged release/ranks and
   releases its slot **without clearing the block**. An unknown exception/crash
   retains block/token/intent. The default cron never clears orphan markers.
   Recovery requires the existing quiescent maintenance gate: stop all privacy
   writers/publishers, reconcile jobs/reservations and current tombstones against
   PERSONAL, advance/invalidate the PUBLIC fence, remove unpublished projections
   and reconcile orphan markers under that gate, then permit a fresh build.
   Never restore an older privacy authority or PUBLIC generation/pointer.

Thus a privacy change is either before activation (version/pending checks prevent
activation), or after it (admission immediately blocks reads). A crash cannot
perform an unproven unblock. This prioritizes privacy over availability: orphan
markers require explicitly authorized maintenance rather than guessing expiry.
Let S be stored stage summaries, P distinct account/stage points (P <= S),
A accounts (at most 150), and C fixed-width stage/cohort cells. In-memory build
work is O(S + A + C log C + P*C): rank construction looks up a cell per point;
SQL also orders S rows. Heap storage is O(S + A + C). This is static reasoning,
not a remote cost, wall-time measurement or production benchmark.

## Review round 1: gated intent recovery and invocation budgets

PUBLIC `0003` adds identified intent leases and an admission gate, preserving
legacy `pending_intents` for reconciliation. PERSONAL `0006` gives existing
deletion jobs `fence_ready = 1`; new guarded claims start at zero. A crash after
a winning claim but before PUBLIC invalidation leaves both an intent and an
unready job. Recovery finishes the fence before recording the privacy authority.
The populated PUBLIC `0001` → `0002` fixture additionally asserts
`state = 'published'`, `intent_version = 0`, zero pending/version counters, null
publisher/activation tokens, preserved pointer/history and rejection by the new
release, pointer and monotonic-version triggers.

### Explicit recovery entry and required quiescence

`PRIVACY_RECONCILE_QUIESCENT = "false"` by default. To enter the prepared
maintenance mode under separate operational authorization:

1. Disable publication and stop/drain ordinary invocations of every deployed
   version, including outstanding D1 writes. Only then assert this flag as
   `"true"`. The flag is an **operator assertion**, not a distributed proof
   that older isolates/ambiguous D1 writes have stopped. All HTTP requests in
   this mode refuse work; only the bounded cron recovery lanes run.
2. The dedicated reconciliation lane calls `reconcilePrivacyIntents`; the
   publication lane refuses to publish in maintenance mode.
   It closes PUBLIC admission and keeps publication blocked, checks that all
   PERSONAL deletion jobs and PRIVACY reservations/pending operations are gone,
   and refuses to reconcile while any intent has an unexpired ten-minute lease.
   Failures/outages leave the gate/block and retry on a later lane invocation.
3. Under that quiescence, one PUBLIC transaction deletes expired orphan leases
   and recomputes `pending_intents` from remaining lease rows. It requires the
   same captured `intent_version`, so a concurrent recovery admission invalidates
   the decision. It then reopens admission, **never clears `blocked`**, never
   resets generation, and never removes a publisher token or unfinished privacy
   record. Unknown publisher recovery remains deferred to the publication review.
4. Verify current tombstone replay/restore gates and completed jobs. Before
   turning `PRIVACY_RECONCILE_QUIESCENT` off, confirm **`reconciliation_gate = 0`**
   on the PUBLIC database for the exact authorized environment:
   `SELECT reconciliation_gate, pending_intents, blocked FROM privacy_fence WHERE singleton = 1;`.
   In a local scaffold, use
   `npx wrangler d1 execute public-aggregate-local --local --config personal-data/wrangler.toml --command "SELECT reconciliation_gate, pending_intents, blocked FROM privacy_fence WHERE singleton = 1;"`.
   A deployed check requires separate operational authorization and the actual
   environment/database, never the local placeholder or a guessed target.
   Missing rows, errors or `reconciliation_gate = 1` are **not** permission to exit:
   keep maintenance on, finish recovery and recheck. Successful recovery leaves
   `pending_intents = 0` and `blocked = 1`. Only then exit maintenance mode.
   Enabling publication is a separate explicit decision.

A failure before any durable write attempt releases its lease immediately,
regardless of exception type. Preparation failures are distinguishable from an
ambiguous D1 write/transport failure: the latter retains a lease even if a later
read currently sees no row, since an outstanding write might still commit.
A PUBLIC failure during lease release also leaves an orphan for this gate.
This is intentional fail-closed uncertainty, not an inferred rollback.
Inactivity remains measured by successful **login + save only**; neither consent,
polling, recovery, session touches nor publication changes `last_active_at`.

### One local cron trigger, six isolated lanes

The single `*/10 * * * *` trigger selects
`floor(UTC minute of scheduledTime / 10) % 6`, not wall-clock delivery time or
the cron string. Each invocation performs expiry cleanup (three statements) and
only the selected lane; no failed lane dispatches another. Every lane runs once
per hour. Slot zero is cleanup only. Publication and reconciliation are separate;
reconciliation is inert without the explicit maintenance flag.

| UTC minute / slot | Lane | Conservative maximum application statements including cleanup |
| --- | --- | --- |
| 00 / 0 | Cleanup only | 3 |
| 10 / 1 | One oldest ready deletion job | 24 |
| 20 / 2 | One stale consent reservation | 27 |
| 30 / 3 | One inactivity candidate | 27 |
| 40 / 4 | Publication (disabled during beta) | 19 |
| 50 / 5 | Gated reconciliation | 8 |

The ceilings include known failure cleanup/backoff paths and count **each batch
statement**, not just one D1 round-trip. There is no recursive drain in an
invocation. Local metered tests assert these per-lane ceilings for ready work
and failure/backoff paths. Before an inactivity candidate is blocked, failures
set that candidate's retry timestamp one minute ahead. Due candidates are ordered
by retry timestamp then activity/user ID, so fresh candidates precede a failing
prefix even at the next hourly invocation. After blocking, deletion-job recovery
owns retries. These are bounded call/query counts, not a guarantee about rows
scanned, CPU, billing or repeated platform invocations. One cron is prepared
locally only; deployment still requires separate authorization.

Official docs retrieved read-only for this review:
<https://developers.cloudflare.com/workers/platform/limits/#subrequests> defines
D1 service calls as subrequests. Workers Free allows 50 external and 1,000
internal-service subrequests; Paid defaults to 10,000.
<https://developers.cloudflare.com/d1/platform/limits/> separately lists **50
D1 queries per invocation on Free / 1,000 on Paid**. Use the stricter D1 query
budget, conservatively treating every submitted batch statement as a query;
batching does not justify treating many statements as free.
