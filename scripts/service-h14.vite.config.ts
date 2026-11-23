import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import base from './local-service.config.mjs';
import { serviceH14Directory, serviceH14Root, serviceH14Run } from './service-h14-paths.ts';

const root = serviceH14Root(), run = serviceH14Run(root);
export default defineConfig({
  ...base,
  root, envDir: serviceH14Directory(root, resolve(run, 'empty-env')),
  cacheDir: serviceH14Directory(root, resolve(run, 'vite-cache')),
  // Same index.html/main.tsx/App; no research entry or substitute public directory.
  build: { ...base.build, outDir: resolve(run, 'dist'), emptyOutDir: false },
  server: { ...base.server, host: '127.0.0.1', port: 4330, strictPort: true },
  preview: { host: '127.0.0.1', port: 4330, strictPort: true },
});
