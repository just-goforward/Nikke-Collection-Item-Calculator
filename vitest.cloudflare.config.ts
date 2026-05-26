import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["cloudflare/src/**/*.test.ts"],
  },
});
