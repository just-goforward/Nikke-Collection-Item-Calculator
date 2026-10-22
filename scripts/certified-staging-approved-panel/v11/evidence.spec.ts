import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { CERTIFIED_ENGINE_CODE_HASH } from "../../../shared/generated/certifiedEngineBuild.ts";
import { sha256 } from "../v6/history.ts";
import { V11_PINS_SHA } from "./anchor.ts";
import { PUBLICATION_FILES, readV11Evidence } from "./evidence.ts";
import { generatePublication } from "./generate.ts";
import { loadIndependentPanel } from "./panel.ts";
import { regenerateDraft } from "./regenerate.ts";

it("authenticates sealed evidence and rejects overwrite, identity mismatch and tampering", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "v11-auth-"));
  const sealedRoot = "scripts/certified-staging-approved-panel/v11";
  for (const name of PUBLICATION_FILES)
    copyFileSync(resolve(sealedRoot, name), resolve(root, name));
  const generated = {
    anchor: V11_PINS_SHA,
    engineBuildHash: CERTIFIED_ENGINE_CODE_HASH,
  };
  const evidence = readV11Evidence(root, generated.anchor, CERTIFIED_ENGINE_CODE_HASH);
  expect(readV11Evidence(sealedRoot).panelAnchorSha256).toBe(V11_PINS_SHA);
  expect(() => readV11Evidence(root, "")).toThrow("Unsealed");
  expect(() => readV11Evidence(root, "0".repeat(64))).toThrow("Anchor");
  expect(() => readV11Evidence(root, generated.anchor, "0".repeat(64))).toThrow("Engine");
  expect(loadIndependentPanel(root, generated.anchor, generated.engineBuildHash)).toEqual(
    evidence.panel,
  );
  expect(Object.keys(evidence.panel).sort()).toEqual(["boundaries", "cases"]);
  expect(evidence.panel.cases).toHaveLength(24);
  expect(evidence.panel.boundaries.waitingProof).toBe("UNVERIFIED_NOT_REGENERATED");
  await expect(generatePublication(root)).rejects.toThrow("Refusing overwrite");
  for (const name of PUBLICATION_FILES) {
    const path = resolve(root, name);
    const original = readFileSync(path);
    writeFileSync(path, Buffer.concat([original, Buffer.from(" ")]));
    expect(() => readV11Evidence(root, generated.anchor)).toThrow();
    writeFileSync(path, original);
  }
  // Recomputed local pins do not excuse invalid source manifests or semantic changes.
  for (const mutation of ["cadence", "source", "omission", "panel"] as const) {
    const copy = mkdtempSync(resolve(tmpdir(), "v11-tamper-"));
    for (const name of PUBLICATION_FILES) copyFileSync(resolve(root, name), resolve(copy, name));
    const provenance = structuredClone(evidence.provenance);
    if (mutation === "cadence") provenance.cadenceVersion = "observed-mean-thursday-v1";
    if (mutation === "source")
      provenance.sources[0]!.base64 = Buffer.from("tampered").toString("base64");
    if (mutation === "omission") provenance.sources = [];
    if (mutation === "panel") {
      const panel = structuredClone(evidence.panel);
      panel.cases[0]!.expected.P = { numerator: "2", denominator: "1" };
      const bytes = JSON.stringify(panel);
      writeFileSync(resolve(copy, "panel.json"), bytes);
      provenance.files["panel.json"] = sha256(bytes);
    }
    const bytes = JSON.stringify(provenance);
    writeFileSync(resolve(copy, "provenance.json"), bytes);
    const pins = JSON.stringify({ version: provenance.version, provenanceSha256: sha256(bytes) });
    writeFileSync(resolve(copy, "pins.json"), pins);
    expect(() => readV11Evidence(copy, sha256(pins))).toThrow();
  }
}, 180_000);

it("regenerates only fresh drafts with their returned anchors, never the sealed root", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "v11-fresh-auth-"));
  const generated = await generatePublication(root);
  const evidence = readV11Evidence(root, generated.anchor, CERTIFIED_ENGINE_CODE_HASH);
  expect(evidence.panel.cases).toHaveLength(24);
  expect((await regenerateDraft(root, generated.anchor, generated.engineBuildHash)).anchor).toBe(
    generated.anchor,
  );
}, 180_000);
