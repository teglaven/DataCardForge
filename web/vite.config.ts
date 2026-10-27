import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  // Sub-path deployments (GitHub Pages serves at /<repo>/) need every asset URL prefixed.
  // Local dev and the systemd service keep the default '/'.
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
    // Bind every interface so the workbench is reachable from other machines on the LAN
    // (requested 2026-10-21). NOTE the standing gap: the backend has NO authentication
    // (backend-protocol-v1 "无鉴权…跨机部署前必须先补 token"), and this dev server
    // proxies /api/* straight through — so anything that can reach this port gets full
    // matrix/node API access. Keep it on a trusted network, or add a token first.
    host: '0.0.0.0',
    // Vite rejects requests whose Host header is neither localhost nor an IP (DNS-rebinding
    // guard). LAN clients hitting http://<ip>:5173 pass; a hostname needs adding here.
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
