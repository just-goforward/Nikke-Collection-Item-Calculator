import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { sha256 } from "../v6/history.ts";
import { PUBLICATION_FILES, readV11Evidence } from "./evidence.ts";
import { generatePublication } from "./generate.ts";

/** Review-time replay requires the authenticated generation source tree, before anchor
 * installation. Historical reading remains independent of the current source files. */
export async function regenerateDraft(
  root: string,
  trustedAnchor: string,
  engineBuildHash: string,
) {
  const evidence = readV11Evidence(root, trustedAnchor, engineBuildHash);
  for (const source of evidence.provenance.sources)
    assert.equal(
      sha256(readFileSync(source.path)),
      source.sha256,
      `Regeneration source drift: ${source.path}`,
    );
  const replay = await generatePublication(mkdtempSync(resolve(tmpdir(), "v11-regeneration-")));
  assert.equal(replay.anchor, trustedAnchor, "Regenerated anchor mismatch");
  for (const name of PUBLICATION_FILES)
    assert.deepEqual(
      readFileSync(resolve(replay.root, name)),
      readFileSync(resolve(root, name)),
      `Regenerated ${name}`,
    );
  return replay;
}
