import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ["src/**/*.spec.ts", "../scripts/forecast-naver-runtime-parity.spec.ts"],
    fileParallelism: false,
  },
});
