import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Tests run against the shared TypeScript source, like typecheck and lint
    // (see the `@crawler/source` export condition), so no build is needed.
    alias: {
      '@crawler/shared': fileURLToPath(new URL('./shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['{shared,api,worker,web}/test/**/*.test.ts'],
  },
});
