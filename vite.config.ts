import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

/**
 * MANUAL CHUNKS (`docs/architecture/01-TARGET.md` §10, plan slice 1.8).
 *
 * Route-level `React.lazy` (src/App.tsx, src/pages/Admin.tsx) is what moves
 * PAGES out of the entry chunk. It does not move the libraries a page happens
 * to be the only user of: Rollup will happily inline `recharts` into the one
 * lazy chunk that imports it, and a library shared by two lazy routes lands in
 * a shared chunk with an unstable name that changes whenever either route does.
 *
 * These four groups fix that, and every one of them is a library that is large,
 * rarely needed, and cached far longer than the application code around it:
 *
 *   vendor-react   react + react-dom + the router — the only group EVERY page
 *                  needs, split out so an application change does not
 *                  re-download the framework.
 *   vendor-motion  gsap and motion — animation, used from the first screen.
 *   vendor-webgl   ogl, and ONLY ogl. §10 groups it with the animation
 *                  libraries; measuring says not to. `ogl` is imported by the
 *                  model viewer alone, which is a lazy route, while `motion`
 *                  is on the home page — so putting them in one chunk makes
 *                  the WebGL renderer a static dependency of the entry and
 *                  adds ~22 KB gzip to the first byte of every visit. That is
 *                  the exact cost §10 exists to remove, so the grouping is by
 *                  WHEN the code is needed rather than by what it does.
 *   vendor-charts  recharts — one import, in the investor page, and one of the
 *                  largest dependencies in the tree.
 *   vendor-phone   libphonenumber-js — one import, in the phone field, and it
 *                  carries a metadata table far bigger than the component.
 *   vendor-qr      jsqr — the scanner, reached from one admin panel.
 *   vendor-i18n    src/translations.ts — every string of the interface in
 *                  three languages. It is 31 KB of data that changes on a
 *                  different schedule from the code that reads it.
 *
 * WHY NOT "everything in node_modules into one vendor chunk": that is the
 * classic version of this configuration and it is worse here — it would put
 * recharts and the phone metadata back into a chunk every visitor downloads,
 * which is exactly the 817 KB entry this slice exists to remove.
 *
 * `tests/bundleBudget.test.ts` holds the result: 350 KB gzip for the entry and
 * 250 KB for any single chunk, the numbers §10 sets.
 */
function manualChunks(id: string): string | undefined {
  if (id.includes('/src/translations.ts')) return 'vendor-i18n';
  if (!id.includes('node_modules')) return undefined;
  // Match the package directory, so a nested dependency of a grouped package
  // (scheduler under react-dom, for instance) is grouped with it rather than
  // left behind in the entry.
  if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) return 'vendor-react';
  if (/[\\/]node_modules[\\/]ogl[\\/]/.test(id)) return 'vendor-webgl';
  if (/[\\/]node_modules[\\/](gsap|motion|motion-dom|motion-utils|framer-motion)[\\/]/.test(id)) return 'vendor-motion';
  if (/[\\/]node_modules[\\/]recharts[\\/]/.test(id)) return 'vendor-charts';
  if (/[\\/]node_modules[\\/](d3-[a-z]+|victory-vendor|decimal\.js-light|internmap)[\\/]/.test(id)) return 'vendor-charts';
  if (/[\\/]node_modules[\\/]libphonenumber-js[\\/]/.test(id)) return 'vendor-phone';
  if (/[\\/]node_modules[\\/]jsqr[\\/]/.test(id)) return 'vendor-qr';
  return undefined;
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      rollupOptions: {
        output: { manualChunks },
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
