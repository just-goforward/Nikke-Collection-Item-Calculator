import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { sha256 } from "../v6/history.ts";
import { readV10Evidence } from "./evidence.ts";
import { generatePublication } from "./generate.ts";
import { loadIndependentApprovedPanel } from "./panel.ts";

it("authenticates fresh evidence and rejects tampering, identity mismatch and overwrite", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "v10-auth-"));
  const generated = await generatePublication(root);
  const panel = loadIndependentApprovedPanel(root, generated.anchor, generated.engineBuildHash);
  expect(panel.cases).toHaveLength(24);
  expect(() => readV10Evidence(root)).toThrow("Unsealed");
  expect(() => readV10Evidence(root, "0".repeat(64))).toThrow("Anchor");
  expect(() => readV10Evidence(root, generated.anchor, "0".repeat(64))).toThrow("Engine");
  await expect(generatePublication(root)).rejects.toThrow("Refusing overwrite");
  for (const name of [
    "pins.json",
    "provenance.json",
    "snapshot.json",
    "panel.json",
    "independent-physical-cohorts.json",
  ]) {
    const path = resolve(root, name);
    const original = readFileSync(path);
    writeFileSync(path, Buffer.concat([original, Buffer.from(" ")]));
    expect(() => readV10Evidence(root, generated.anchor)).toThrow();
    writeFileSync(path, original);
  }
  const path = resolve(root, "provenance.json");
  const original = readFileSync(path);
  for (const field of ["cadence", "source"] as const) {
    const provenance = JSON.parse(original.toString());
    if (field === "cadence") provenance.cadenceVersion = "observed-mean-thursday-v1";
    else provenance.sources[0].base64 = Buffer.from("changed source").toString("base64");
    const changed = JSON.stringify(provenance);
    writeFileSync(path, changed);
    const pins = JSON.stringify({
      version: provenance.version,
      provenanceSha256: sha256(changed),
    });
    writeFileSync(resolve(root, "pins.json"), pins);
    expect(() => readV10Evidence(root, sha256(pins))).toThrow();
  }
}, 180_000);
