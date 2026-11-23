#!/usr/bin/env bash
set -euo pipefail

# Host build scripts and proc macros affect Cargo's target crate identities.
# Root source verification and protected preparation must use the same host.
toolchain=1.99.1-x86_64-unknown-linux-gnu
target=wasm32-unknown-unknown
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]]
rustup toolchain install "$toolchain" --profile minimal --target "$target"
rustc=$(rustup which --toolchain "$toolchain" rustc)
cargo=$(rustup which --toolchain "$toolchain" cargo)
# The native generator resolves these via the short toolchain name.
[[ $(rustup which --toolchain 1.99.1 rustc) == "$rustc" && $(rustup which --toolchain 1.99.1 cargo) == "$cargo" ]]
sysroot=$("$rustc" --print sysroot)
printf '%s  %s\n' \
  b53b780f77f952062f8ca8a3b70aef2390b1e45ad91939be94afdc9543026853 "$rustc" \
  a670e02cfa39ac2e53f77a2d911ca1fc9e2c479b0603ec956625be1daf24e3af "$cargo" \
  9b6f51f983a8184f5d47d224e336cdb35171ad5b138981bc62a22e6d65e7b214 "$sysroot/lib/rustlib/x86_64-unknown-linux-gnu/bin/rust-lld" | sha256sum --strict --check
node --input-type=module - "$sysroot/lib/rustlib/$target/lib" <<'JS'
import assert from 'node:assert/strict';
import { hash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.argv[2];
const digests = readdirSync(dir).sort().map(name => hash('sha256', readFileSync(join(dir, name))));
assert.equal(hash('sha256', digests.join('\n')), 'e92e352f73a0c82324a59651b39ded674841f21218dbe4a471a4740bc2afe35d');
JS
cargo +"$toolchain" fetch --locked --manifest-path rust/service-h14/Cargo.toml
