// web/vite.config.js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Local dev proxy target (optional):
// 1) Create web/.env.local with: VITE_PROXY_TARGET=https://<your-api>.onrender.com
// 2) Vite auto-loads it into import.meta.env at build time
const target = process.env.VITE_PROXY_TARGET || 'https://<your-api>.onrender.com';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // All frontend requests to /api/* get forwarded to your Render API during dev
      '/api': {
        target,
        changeOrigin: true,
        // We rewrite "/api/foo" -> "/foo" for the API service
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
  preview: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
