# Personal-data Worker — M0 / M1 (local only)

This directory owns a separate, **disabled HTTP scaffold** and three local D1
stores. No Google OAuth, production binding, cron, publication, deployment, or
UI integration is enabled. Existing anonymous statistics remain separate and
cookie-free. Guests retain all calculator functionality. Auth-library selection
is pending the separate Better Auth 1.7.7 / maintained OIDC-library spike.
`src/auth.ts:AuthAdapter` is the integration boundary, not an OAuth implementation.

## M0 contracts

`src/contracts.ts:Api` is the TypeScript wire-contract map. All timestamps are
Unix milliseconds. Private routes require an authenticated account, origin/CSRF
validation for mutations, and `Cache-Control: no-store`; these controls must be
implemented before enabling routes. M1 responds with 501 (public statistics:
503 while fenced) and no cookies. No routes currently disclose private data.

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
prerequisite for personal functionality. Consent API plumbing is M2.

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
  deletion tombstones (identity hash, not email), restartable privacy operations.
  Never overwrite this authority with an older personal-data backup.
* `PUBLIC_AGGREGATE_DB`: identifier-free weekly payloads, disclosure history,
  monotonic fence and current pointer. Initial state is blocked. Public payload
  validation and release construction are not implemented.

Admission is an atomic SELECT-conditioned INSERT inside a **single PERSONAL_DB
batch**, with a database trigger enforcing 150 active accounts even on a bypass.
Concurrent logins for the same identity converge on the same account. Deletion
frees an active-account slot. The auth integration must check deletion tombstones
before admission/serving restored state; the internal admission primitive is
not independently a full cross-store login policy.

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
PKCE/state creation, callback validation and expiry cleanup are deferred.

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

No install or root manifest/lockfile change is needed for these local checks.
Future integration requires adding `personal-data` to root workspaces and
updating its lockfile and worker-test/typecheck scripts, with separate approval;
no `.github/workflows` changes are made here.

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
