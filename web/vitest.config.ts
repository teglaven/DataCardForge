import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // Default stays `node`: almost every suite is pure logic and runs faster without a
    // DOM. Suites that must mount components opt in per file with a
    // `// @vitest-environment jsdom` docblock (see tests/ConnectionAnchors.dom.test.tsx).
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    // jsdom lacks ResizeObserver / layout APIs; DOM suites need the stub to mount.
    setupFiles: ['tests/setup.dom.ts'],
  },
});
