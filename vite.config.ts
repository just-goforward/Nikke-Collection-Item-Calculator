import { execFileSync } from "node:child_process";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function sourceRevision() {
  const { GITHUB_SHA: ciRevisionValue } = process.env;
  const ciRevision = ciRevisionValue?.trim();
  if (ciRevision) return ciRevision;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "main";
  }
}

export default defineConfig({
  base: "./",
  define: {
    __SOURCE_REVISION__: JSON.stringify(sourceRevision()),
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    manifest: true,
    target: "es2022",
    minify: "esbuild",
    cssMinify: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replace(/\\/g, "/");
          if (normalizedId.includes("/node_modules/react")) return "react";
          return undefined;
        },
      },
    },
  },
  worker: {
    format: "es",
  },
});
