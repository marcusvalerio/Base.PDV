import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'web',
  plugins: [react(), {
    // Em desenvolvimento: /app e /central abrem o sistema (app.html), como na Vercel.
    name: 'spa-app-fallback',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url && /^\/(app|central)(\/|$|\?)/.test(req.url) && !req.url.includes('.')) req.url = '/app.html';
        next();
      });
    },
  }],
  build: { outDir: '../dist', emptyOutDir: true, rollupOptions: { input: 'web/app.html' } },
  server: { port: 5173, proxy: { '/api': 'http://localhost:3001' } },
});
