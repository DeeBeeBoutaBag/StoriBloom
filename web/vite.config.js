import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        // strip the /api prefix when proxying to the API
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
