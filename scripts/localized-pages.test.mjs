import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "vite";
import { localizedPagesPlugin } from "./localized-pages.ts";

test("a failed render retains its original error without localizing unwritten output", async () => {
  const root = await mkdtemp(join(tmpdir(), "localized-render-failure-"));
  try {
    await writeFile(join(root, "entry.js"), "export const value = 1;\n");
    await assert.rejects(build({
      configFile: false,
      root,
      logLevel: "silent",
      plugins: [
        localizedPagesPlugin(),
        {
          name: "original-render-failure",
          generateBundle() {
            throw new Error("ORIGINAL_RENDER_FAILURE");
          },
        },
      ],
      build: { lib: { entry: join(root, "entry.js"), formats: ["es"] } },
    }), /ORIGINAL_RENDER_FAILURE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
