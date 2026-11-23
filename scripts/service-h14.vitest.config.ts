import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { serviceH14Directory, serviceH14Root, serviceH14Run } from './service-h14-paths.ts';

const root = serviceH14Root(), run = serviceH14Run(root);
export default defineConfig({
  root, cacheDir: serviceH14Directory(root, resolve(run, 'vitest-cache')),
  test: {
    include: ['src/serviceH14/**/*.spec.ts', 'src/serviceH14/**/*.test.ts', 'scripts/service-h14*.spec.ts',
      'src/certified/wasmBackend.spec.ts', 'src/certified/wasmBackend.memory.spec.ts', 'src/certified/budget.source.test.ts'],
    environment: 'node', fileParallelism: false, maxWorkers: 1, retry: 0, allowOnly: false,
    testTimeout: 30000, hookTimeout: 30000,
    reporters: ['default', 'json'], outputFile: resolve(run, 'vitest-results.json'),
  },
});
