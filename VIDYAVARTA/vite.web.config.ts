// VidyaVarta web app: the live-only campus office as a static SPA.
// The vite plugin runs the campus bridge (loopback) alongside the dev server.
import { defineConfig, loadEnv } from 'vite';
// Server-only configuration. No secrets use the VITE_ prefix or enter browser bundles.
Object.assign(process.env, loadEnv(process.env.NODE_ENV || 'development', __dirname, ''));
import react from '@vitejs/plugin-react';
import { campusPlugin } from './src/campus/vite-plugin';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react(), campusPlugin()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, cors: false, allowedHosts: ['localhost', '127.0.0.1'] },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src')
    }
  },
  build: {
    outDir: resolve(__dirname, 'dist-web'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000
  }
});

