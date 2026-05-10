import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  base: "./",
  plugins: [vue()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    minify: "esbuild",
    cssMinify: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          vue: ["vue"],
        },
      },
    },
  },
  worker: {
    format: "es",
  },
});
