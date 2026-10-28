import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true, rollupOptions: { input: 'web/app.html' } },
  server: { port: 5173, proxy: { '/api': 'http://localhost:3001' } },
});
