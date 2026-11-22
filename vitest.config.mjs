import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        resolve: {
          // Tests run against the shared TypeScript source, like typecheck and lint
          // (see the `@crawler/source` export condition), so no build is needed.
          alias: {
            '@crawler/shared': fileURLToPath(new URL('./shared/src/index.ts', import.meta.url)),
          },
        },
        test: {
          name: 'services',
          include: ['{shared,api,worker}/test/**/*.test.ts'],
        },
      },
      // The frontend uses its own Vite config: Vue plugin, source condition and jsdom.
      'web/vite.config.ts',
    ],
  },
});
