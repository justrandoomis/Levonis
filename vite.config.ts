import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // `npm run dev:web` proxies API calls to the local Worker
      // (`npm run dev`, which serves on 8787 by default).
      proxy: {
        '/api': 'http://127.0.0.1:8787',
        '/files': 'http://127.0.0.1:8787',
      },
    },
  };
});
