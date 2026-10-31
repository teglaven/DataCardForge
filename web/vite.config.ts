import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// The C++ compute backend port. `scripts/dev.sh <port>` exports this, so the /api proxy
// follows the port the backend was actually started on instead of assuming the default.
const backendPort = process.env.DC_BACKEND_PORT ?? '37811';

export default defineConfig({
  // Sub-path deployments (GitHub Pages serves at /<repo>/) need every asset URL prefixed.
  // Local dev and a persistent deployment keep the default '/'.
  base: process.env.VITE_BASE ?? '/',
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
    // Loopback by default. The backend has NO authentication (backend-protocol-v1:
    // "无鉴权…跨机部署前必须先补 token") and this dev server proxies /api/* straight
    // through, so binding every interface would hand the full matrix/node API to anything
    // that can reach the port. Opt in deliberately when you want LAN access:
    //   VITE_HOST=0.0.0.0 ./scripts/dev.sh      (or `npx vite --host 0.0.0.0`)
    host: process.env.VITE_HOST ?? '127.0.0.1',
    // Vite rejects requests whose Host header is neither localhost nor an IP (DNS-rebinding
    // guard). LAN clients hitting http://<ip>:5173 pass; a hostname needs adding here.
    proxy: {
      // B-plan: forward /api/* to the C++ compute backend (DC_BACKEND_PORT, default 37811).
      '/api': {
        target: `http://127.0.0.1:${backendPort}`,
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
