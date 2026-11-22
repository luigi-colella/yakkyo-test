/// <reference types="vitest/config" />
import vue from '@vitejs/plugin-vue';
import { defaultClientConditions, defineConfig } from 'vite';

// The API serves the built app from `api/public` (see `scripts/copy-frontend.mjs`).
// In development, `vite` proxies the API calls to a locally running API.
const API_URL = 'http://localhost:8080';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    // Bundle `@crawler/shared` from its TypeScript source, like the other dev tools,
    // so building the frontend never needs a build of `shared` first.
    conditions: ['@crawler/source', ...defaultClientConditions],
  },
  server: {
    proxy: { '/crawl': API_URL, '/healthz': API_URL },
  },
  test: {
    name: 'web',
    include: ['test/**/*.test.ts'],
    environment: 'jsdom',
  },
});
