# Site runtime forecast consumer

Local implementation; deployment, key provisioning and live account checks require
separate operator approval. Production remains bundled-only.

## Build and trust configuration

`npm run build` is the production/bundled build when no staging VITE flag is supplied.
`npm run build:site-staging` compiles with the environment, key ID and raw 32-byte
Ed25519 public key from `site-worker/forecast-runtime.json`, then packages staging HTML.
The committed public-key value is deliberately an invalid placeholder: replace it
with the reviewed public key before live staging validation. No private key belongs here.
`deploy:site-staging`, including `--dry-run`, rejects the placeholder or malformed
public keys before verification or upload.
The deploy script calls this same build command; its repeated staging checks reject
a production build or a bundle compiled with a different configured key.

Vite emits `.vite/forecast-runtime.json` using its resolved environment. Production
packaging/checking rejects a runtime-enabled bundle. All `.vite` metadata is excluded
from Worker asset upload; production's existing receipt hashes it before deployment.

## Endpoint and refresh policy

Only GET `/api/forecast/version` and `/api/forecast` are exposed. The site uses direct
D1 bindings through SELECT-only consumer code and first-primary sessions, not a
database-level read-only grant. The native IP limiter is configured for 60/minute.
Validate its namespace and deployed enforcement before rollout.

Success and failure results share a non-sliding 60-second primary-read deadline per
binding/isolate. Guard stops, missing pointers and database failures cannot cause one
D1 read per public request. New guard stops and pointer decisions propagate within
that cache deadline. The public HTTP responses are `no-store`.

Browsers check on load, every five visible minutes, foreground resume and before
calculation. Expiry requests version revalidation; it does not itself discard a
verified forecast or announce failure. The artifact is reused while its signed
content hash is unchanged. Actual failures or signed `off` select bundled data and
show the localized fallback notice. A freshness-window/mismatched-pointer race gets
one retry within the same five-second request deadline.

Once a pointer signature and fields authenticate, its sequence is remembered even
if artifact admission fails. That failure blocks lower/equal sequences; a completely
admitted publication permits equal-sequence cache refreshes. Authentication and
sequence checks do not independently establish first-visit freshness.

## Certified Worker boundary and rotation

The certified Worker verifies the supplied proof and snapshot identity, not live
activation state. A fresh Worker can accept any ever-approved publication signed
by its build-pinned key; it cannot independently enforce a subsequently published
`off` or rollback. Browser primary-read/cache policy owns current-pointer freshness.
An already-running calculation retains its selected forecast and never refetches
or changes identity halfway through execution.

V1 pins one key ID/public-key pair. Rotating that pair makes pre-rotation artifacts
unusable for rollback in that build: their old-key signatures fail and the browser
uses bundled data. A multi-key trust-set/re-signing migration needs separate review;
the consumer never discovers trusted keys from the endpoint.
