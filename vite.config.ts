import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { localizedPagesPlugin } from "./scripts/localized-pages.ts";
import { STATS_DELIVERY_HEALTH_EMIT_ENABLED } from "./shared/solverRecoveryContract.ts";

export default defineConfig({
  base: "/",
  define: {
    __APP_REVISION__: JSON.stringify(process.env["GITHUB_SHA"] ?? "local"),
    __STATS_DELIVERY_HEALTH_EMIT_ENABLED__: JSON.stringify(STATS_DELIVERY_HEALTH_EMIT_ENABLED),
  },
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
