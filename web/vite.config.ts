import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // xlsx ships as a plain ESM/UMD bundle; pre-bundle it so the lazy import in the
  // xlsx loader resolves consistently in dev and in the production build.
  optimizeDeps: {
    include: ['@e965/xlsx'],
  },
  server: {
    proxy: {
      // B-plan: forward /api/* to the C++ compute backend (default port 37811).
      '/api': {
        target: 'http://127.0.0.1:37811',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
});
