#!/usr/bin/env bash
# Credential-free artifact construction. Run from the reviewed checkout root.
set -eu -o pipefail
: "${INCIDENT_CANARY_END:?UTC expiry required}"
out=$(cd "$1" && pwd)
cd production-incidents
cfg=$(mktemp "$PWD/.canary-XXXXXXXX")
trap 'rm -f "$cfg" "$cfg.json"' EXIT
# This expired historical canary belongs to its sealed predecessor, not today's Site enrollment.
build=$(node --input-type=module -e 'import {serviceBuild} from "./sealed-successor.ts"; process.stdout.write(serviceBuild)')
node config.mjs canary 9a516350-d7d8-4a77-9cce-45d669fd3502 419204 "$build" > "$cfg.json"
WRANGLER_SEND_METRICS=false node ../node_modules/wrangler/bin/wrangler.js deploy --dry-run --config "$cfg.json" --outdir "$out"
test -s "$out/private-canary.js"
rm -f "$cfg" "$cfg.json"
