import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectRustWasmLicenses,
  LICENSE_TEXT_FILE,
  RUST_WASM_CRATE_DIRS,
  readRustWasmLicenses,
} from "./rust-wasm-licenses";

async function lockedThirdPartyCrates() {
  const ids = new Set<string>();
  for (const dir of RUST_WASM_CRATE_DIRS) {
    const lock = await readFile(resolve(dir, "Cargo.lock"), "utf8");
    for (const match of lock.matchAll(
      /\[\[package\]\]\r?\nname = "([^"]+)"\r?\nversion = "([^"]+)"\r?\n(source = )?/g,
    )) {
      // Workspace crates have no registry source.
      if (match[3]) ids.add(`${match[1]}@${match[2]}`);
    }
  }
  return [...ids].sort();
}

const cargoAvailable = spawnSync("cargo", ["--version"]).status === 0;

describe("Rust WASM license manifest", () => {
  it("accounts for exactly the locked third-party crates", async () => {
    const manifest = await readRustWasmLicenses();
    const listed = [...manifest.crates, ...manifest.buildOnly]
      .map((crate) => `${crate.name}@${crate.version}`)
      .sort();
    expect(listed).toEqual(await lockedThirdPartyCrates());
    for (const crate of manifest.crates) expect(crate.license).not.toBe("");
  });

  it("captures a license text for every SPDX license each shipped crate offers", async () => {
    const fileFor: Record<string, RegExp> = {
      MIT: /^LICENSE-MIT$/,
      "Apache-2.0": /^LICENSE-APACHE$/,
      Unlicense: /^UNLICENSE$/,
    };
    for (const crate of (await readRustWasmLicenses()).crates) {
      const files = crate.texts.map((entry) => entry.file);
      for (const file of files) expect(file).toMatch(LICENSE_TEXT_FILE);
      for (const entry of crate.texts) expect(entry.text.trim()).not.toBe("");
      for (const spdx of crate.license.split(/\s+OR\s+/)) {
        expect(fileFor[spdx], `${crate.name}: unmapped ${spdx}`).toBeDefined();
        expect(
          files.some((file) => fileFor[spdx]?.test(file)),
          `${crate.name}: ${spdx} text`,
        ).toBe(true);
      }
    }
  });

  it.runIf(cargoAvailable)("matches cargo tree output", async () => {
    expect(collectRustWasmLicenses()).toEqual(await readRustWasmLicenses());
  });
});
