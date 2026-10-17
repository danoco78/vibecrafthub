import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// En desarrollo el API corre en :3000; el proxy evita CORS y mantiene la cookie
// en el mismo origen. En producción el gateway (Caddy) hace esta función.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/bundles': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
  },
});
