import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // forward /api -> your local API
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        // keep the /api prefix so routes match server.js
        // (if your server mounted at root)
      },
    },
  },
});
