import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const BACKEND_URL = process.env.VITE_BACKEND_URL || 'https://levonis-iq.com';

export default defineConfig({
  resolve: {
    alias: [
      { find: '@levonis/pricing/availability', replacement: '/app/applet/packages/pricing/src/availability.ts' },
      { find: '@levonis/pricing', replacement: '/app/applet/packages/pricing/src' },
    ],
  },
  plugins: [
    react(),
    tailwindcss(),
  ],
  server: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: BACKEND_URL,
        changeOrigin: true,
        secure: false,
      },
      '/files': {
        target: BACKEND_URL,
        changeOrigin: true,
        secure: false,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 3000,
    proxy: {
      '/api': {
        target: BACKEND_URL,
        changeOrigin: true,
        secure: false,
      },
      '/files': {
        target: BACKEND_URL,
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
