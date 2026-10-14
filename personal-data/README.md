# Personal-data Worker — M0 / M1 / M3 (local only)

This directory owns a separate Google OIDC/session Worker and three local D1
stores. No production binding, cron, publication, deployment, or UI integration
is provisioned. Existing anonymous statistics remain separate and cookie-free.
Guests retain all calculator functionality. M3 pins `openid-client` **6.8.8**
with app-owned D1 sessions. Better Auth was rejected by the approved spike /
Advisor decision; it does not meet this application's identity/session contract.

## M0 contracts

`src/contracts.ts:Api` is the TypeScript wire-contract map. The contracts are
available as type-only imports from `@collection-kit/personal-data/contracts`.
This package entry intentionally preserves the public M0 type contract; backend
implementation helpers are not public package exports. All timestamps are
Unix milliseconds. Private routes require an authenticated account, origin/CSRF
validation for mutations, and `Cache-Control: no-store`. M3 implements these
controls; missing configuration fails closed. Public statistics remain 503 while
fenced. Private ownership is derived only from the authenticated session.

| Route | Request / response |
| --- | --- |
| GET `/v1/workspace` | revision, lastOpId, document, measured content quota |
| PUT `/v1/workspace` | `{opId, baseRevision, document, action}`; saved/replay, revision conflict, reused-op conflict, archive-quota result |
| GET `/v1/export` | versioned personal document, stages, pending archives, consent, frozen self-percentiles |
| GET/PUT `/v1/consent` | nullable initial decision; explicit boolean, decision-version CAS, opId |
| DELETE `/v1/account` | opId; fenced privacy operation acknowledgement |
| POST `/v1/sessions/revoke-all` | opId; revoke all server sessions including current |
| GET `/v1/statistics` | identifier-free weekly release and binned/suppressed cells |
| GET `/v1/self-percentile` | private, frozen percentile bands for a published release |

Future HTTP mapping: malformed input 400, unauthenticated 401, beta full 403,
CAS/op conflict 409, new archive quota 422, accepted privacy operation 202,
unavailable/fenced public data 503. A saved operation always reports its original
revision, even when newer saves have occurred. Clients must not overwrite their
newer document with a replay acknowledgement. Unknown/expired opIds use CAS;
there is no indefinite replay promise.

One account has exactly one workspace and one Google `(issuer, sub)` identity.
Email is neither stored nor used to link accounts. Consent is asked once at first
login (`null` = not decided, default exclusion), editable in settings, never a
prerequisite for personal functionality. Consent API uses CAS and operation hashes.

Stage summaries are lifetime, per-item/per-stage, editable in beta. Manual-entry
and verification flags travel with them. Pre-signup income stays personal and
must be subtracted from public contributions. Publication must validate
nonnegative values and exclude pre-signup income; M1 does not aggregate anything.
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
  validation and release construction are not implemented.

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
workspace, stage-summary JSON, pending-archive JSON and self-percentile JSON.
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
after two calendar years without either is deferred; use the same fenced deletion path.
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

M1 deliberately offers no unblock/publisher. The next milestone needs a reviewed,
serialized coordinator/maintenance gate that proves all pending privacy changes
and restored tombstones are applied, rebuilds eligible aggregates and publishes
under the same generation. Checking two databases then unblocking is unsafe
(TOCTOU). Public reads must validate pointer/release/current fence atomically.
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
retained but do not override a newer authoritative opt-in. Public publication
still has no unblock path, and frozen ranks are served only for eligible,
unfenced releases.

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
quota budgets, inactivity scheduler, release/unblocking coordinator, and
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

The prepared scheduled handler independently drains at most five oldest-ready
deletion jobs and five stale consent reservations per tick, in addition to expiry
cleanup. Each failed job is isolated. Indexed retry-due/creation ordering and a
one-minute scheduled retry delay prevent a stuck prefix from monopolizing later
jobs; matching consent requests do not wait for that scheduled backoff. Cron and
request retries acquire the same attempt lease. Pending deletion finishes without
a new login, deletes that user's records and frees the beta slot. HTTP paths stay
user-scoped. On callback, the existing account's deletion tombstone is applied
before provisioning so a restored old user ID cannot trap a fresh rejoin.

Archive ID reuse with a new opId is an atomic 409 `archive_id_conflict`, not
a raw UNIQUE-error 503. Export reads a single PERSONAL snapshot containing the
workspace, every stage/archive/self-percentile row counted toward logical quota,
and account `createdAt`/`lastActiveAt`, regardless of consent or publication.
The separate self-percentile display endpoint still filters unavailable releases.
Multibyte quota tests use CJK, accented text and supplementary Unicode.

## Pre-release migration and recovery policy (R2-03)

**Chosen: keep numbered migrations, do not squash.** `0001` is the M1 baseline;
`0002` adds auth/consent; `0003` replaces permanent identity bans with expiring
flow-generation fences and adds scoped consent reservations; `0004` adds bounded
job retry indexes and resumable consent attempt leases. Upgrade tests seed
populated M1 and populated `0002` records, apply later migrations using
the migration ledger, and compare all protected fields before/after. Identities,
active and expired hashed sessions with their original idle/absolute deadlines,
workspace revision/document/last-op, operation hashes, stages, archives, ranks,
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

M7 implements inactivity deletion in five-account cron batches, using the same
fenced deletion/outbox/rejoin path. Eligibility is exactly two UTC calendar years
after `last_active_at`; February 29 clips to February 28 in a non-leap anniversary
year. Login and winning saves refresh activity; polling, session touches and
consent decisions do not. The deletion batch rechecks the selected activity
timestamp, so a concurrent login/save wins before account blocking. Writes after
blocking are refused. No pre-deletion warning was required by the agreed contract
and none is implemented. M7 is local-tested, not deployed.
Publication/unblocking, real Google
legacy-issuer support and browser integration remain separate launch gates.
