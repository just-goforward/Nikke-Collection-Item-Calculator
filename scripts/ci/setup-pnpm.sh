#!/usr/bin/env bash
# GitHub-hosted Ubuntu x64 only. Verify the native archive before extracting it.
set -euo pipefail
[[ "$(uname -sm)" == 'Linux x86_64' ]]
root=$(mktemp -d "${RUNNER_TEMP:?}/pnpm.XXXXXXXX")
readarray -t pins < <(node --input-type=module -e 'import { PNPM_URL, PNPM_SRI, PNPM_VERSION } from "./scripts/ci/operational-policy.mjs"; console.log([PNPM_URL, Buffer.from(PNPM_SRI.slice(7), "base64").toString("hex"), PNPM_VERSION].join("\n"))')
curl --fail --silent --show-error --proto '=https' --max-time 120 --max-filesize 67108864 "${pins[0]}" -o "$root/manager.tgz"
printf '%s  %s\n' "${pins[1]}" "$root/manager.tgz" | sha512sum --check --status
tar -xzf "$root/manager.tgz" -C "$root" package/pnpm
[[ "$("$root/package/pnpm" --version)" == "${pins[2]}" ]]
# Node 26.13.1 bundles npm 11.20.0. Do not replace the runner's global npm.
npm_version=$(node -p 'require("./package.json").engines.npm')
[[ "$npm_version" == 12.2.3 ]]
curl --fail --silent --show-error --proto '=https' --max-time 120 --max-filesize 16777216 \
  "https://registry.npmjs.org/npm/-/npm-${npm_version}.tgz" -o "$root/npm.tgz"
[[ "$(openssl dgst -sha512 -binary "$root/npm.tgz" | openssl base64 -A)" == 'ovmNRRe76Jvcp1E6iOePQ6H9Zr4XMOrqgfaeGNhtRvP3XSl2Lo/a9C1N5/jRlLLrsqCem/omgGdZHpZ5a6yn1Q==' ]]
mkdir "$root/npm"
tar -xzf "$root/npm.tgz" -C "$root/npm"
ln -s "$root/npm/package/bin/npm-cli.js" "$root/package/npm"
ln -s "$root/npm/package/bin/npx-cli.js" "$root/package/npx"
[[ "$("$root/package/npm" --version)" == "$npm_version" ]]
printf '%s\n' "$root/package" >> "${GITHUB_PATH:?}"
printf 'OPERATIONAL_PNPM_FIXTURE_BINARY=%s/package/pnpm\n' "$root" >> "${GITHUB_ENV:?}"
