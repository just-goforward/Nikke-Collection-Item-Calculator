import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { localizedPagesPlugin } from "./scripts/localized-pages.ts";

export default defineConfig({
  base: "/",
  plugins: [localizedPagesPlugin(), react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    manifest: true,
    license: { fileName: "third-party-licenses.md" },
    target: "es2022",
    minify: "esbuild",
    cssMinify: true,
    sourcemap: false,
    rolldownOptions: {
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
