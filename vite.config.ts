import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import type { GetModuleInfo } from 'rollup';
import {defineConfig, type Plugin} from 'vite';

/**
 * THE DOCUMENT IS DOWNLOADED ON EVERY VISIT, AND 14 KB OF IT WAS COMMENTARY.
 *
 * index.html is served `no-cache` (worker/lib/securityPolicy.ts), so every
 * navigation pays its bytes again, and the shell's own explanations — why the
 * theme script is inline, why the fonts are linked, what the icons are for —
 * were 14,054 of its 18,164 bytes: 7.4 KB gzip on the wire against 1.5 KB for
 * the markup alone (docs/MERCHANT_PLATFORM_V2.md §B.1 #8). The comments are
 * for the person editing the source; the visitor gets the markup.
 *
 * Only HTML comments outside `<script>` and CSS comments inside `<style>` go,
 * plus the blank lines they leave. Nothing inside a script changes: the theme
 * boot script must stay byte-identical to `THEME_BOOT_SCRIPT`, whose sha256 is
 * the CSP's only inline allowance (tests/themeSystem.test.ts pins the built
 * document to it). Build only — the dev server keeps the source readable.
 */
export function stripDocumentComments(html: string): string {
  const parts = html.split(/(<script\b[\s\S]*?<\/script>)/i);
  const stripped = parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, open: string, css: string, close: string) => `${open}${css.replace(/\/\*[\s\S]*?\*\//g, '')}${close}`);
    })
    .join('');
  return stripped.replace(/\n(?:[ \t]*\n)+/g, '\n');
}

function documentComments(): Plugin {
  return {
    name: 'levonis:strip-document-comments',
    apply: 'build',
    transformIndexHtml: { order: 'post', handler: (html) => stripDocumentComments(html) },
  };
}

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
 *
 * TWO LATER SPLITS (docs/MERCHANT_PLATFORM_V2.md §B.1 #6, P1b):
 *
 *   vendor-motion is now TWO chunks. The library is half a value animator
 *   (`m`, `animate`, motion values, AnimatePresence) and half features (the
 *   projection tree, drag and pan, layout, viewport). The eager primitives
 *   render `m.*` under a `LazyMotion` (src/lib/motionFeatures.tsx), so the
 *   entry needs only the first half before paint: `vendor-motion-core`. The
 *   feature modules — matched by path, see MOTION_FEATURES — stay in
 *   `vendor-motion`, reached by the lazy features bundle and by every page
 *   that still renders the full `motion.*` proxy. Measured at the split:
 *   45.9 KB gzip in the initial payload → the core alone; the rest arrives
 *   from idle or with the first window. tests/motionLazy.test.ts holds it.
 *
 *   vendor-icons: lucide icons that two or more LAZY modules share. Rollup
 *   gave each such icon a chunk of its own — 112 files under 1 KB, 39 KB
 *   gzip of headers and repeated helper code, one request each. Icons the
 *   first paint uses stay inlined in the entry (moving them would ADD the
 *   whole set to every first visit: all 269 icons are 23 KB gzip together,
 *   the 50 the entry uses 5 KB); an icon used by one lazy module stays inside
 *   that module's chunk, as before. Which module uses which icon is read from
 *   the import lists (`iconUsers`) because every icon is imported through the
 *   package index, so the module graph alone cannot tell them apart.
 */
const MOTION_FEATURES = new RegExp(
  '[\\\\/]node_modules[\\\\/](?:' +
    // The `motion` package itself: `motion/react` declares `const motion = fm.motion`
    // in the same module as `const m = fm.m`, so wherever that module lives the
    // full proxy lives too. The eager primitives take `m` from `motion/react-m`
    // (pure re-exports) and everything else resolves through `export *` to the
    // defining modules, so this module can sit with the features.
    'motion[\\\\/]dist[\\\\/]' +
    '|framer-motion[\\\\/]dist[\\\\/]es[\\\\/](?:projection|gestures|components[\\\\/]Reorder|render[\\\\/]dom[\\\\/]features-|render[\\\\/]components[\\\\/]motion|motion[\\\\/]features[\\\\/](?:animation|drag|gestures|layout|viewport|animations\\.mjs|drag\\.mjs|gestures\\.mjs|layout\\.mjs))' +
    // motion-dom: the gesture recognisers, the projection tree and the layout
    // animator. NOT `gestures/utils` (the pointer helpers the value animator
    // shares), `projection/geometry|utils|styles` (box maths every visual
    // element uses) or `render/*`: the DOM renderers stay in the core because
    // `animate(element, …)` builds one for any element it is handed.
    '|motion-dom[\\\\/]dist[\\\\/]es[\\\\/](?:gestures[\\\\/](?:drag|hover|press)|layout|projection[\\\\/](?:node|animation|shared))' +
    ')'
);

const ICON_MODULE = /[\\/]node_modules[\\/]lucide-react[\\/]dist[\\/]esm[\\/]icons[\\/][^\\/]+\.js$/;

interface ChunkMeta {
  getModuleIds: () => IterableIterator<string>;
  getModuleInfo: GetModuleInfo;
}

interface IconGraph {
  /** Every module the entry reaches through STATIC imports. */
  entryClosure: Set<string>;
  /** Application module id → the lucide names its import list carries. */
  imports: Map<string, Set<string>>;
  /** Icon file name (`triangle-alert.js`) → every name the package index exports it under (`TriangleAlert`, `AlertTriangle`, …). */
  aliases: Map<string, Set<string>>;
}

let iconGraph: IconGraph | null = null;

/** Built once per build, on the first icon: the static closure of the entry, each module's lucide import list, and the index's alias table. */
function iconGraphOf(meta: ChunkMeta): IconGraph {
  if (iconGraph) return iconGraph;
  const entries: string[] = [];
  const imports = new Map<string, Set<string>>();
  const aliases = new Map<string, Set<string>>();
  for (const id of meta.getModuleIds()) {
    const info = meta.getModuleInfo(id);
    if (!info || info.isExternal) continue;
    if (info.isEntry) entries.push(id);
    if (/[\\/]node_modules[\\/]lucide-react[\\/]dist[\\/]esm[\\/]lucide-react\.js$/.test(id) && info.code) {
      // `export { default as AlertTriangle, default as TriangleAlert, … } from './icons/triangle-alert.js';`
      for (const m of info.code.matchAll(/export\s*\{([^}]*)\}\s*from\s*["']\.\/icons\/([^"']+)["']/g)) {
        const names = aliases.get(m[2]) ?? new Set<string>();
        for (const spec of m[1].split(',')) {
          const name = spec.trim().split(/\s+as\s+/)[1]?.trim();
          if (name) names.add(name);
        }
        aliases.set(m[2], names);
      }
      continue;
    }
    if (id.includes('node_modules') || !info.code) continue;
    const names = new Set<string>();
    for (const m of info.code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']lucide-react["']/g)) {
      for (const spec of m[1].split(',')) {
        const name = spec.trim().split(/\s+as\s+/)[0]?.trim();
        if (name) names.add(name);
      }
    }
    if (names.size) imports.set(id, names);
  }
  const entryClosure = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const id = queue.pop()!;
    if (entryClosure.has(id)) continue;
    entryClosure.add(id);
    const info = meta.getModuleInfo(id);
    if (!info) continue;
    for (const dep of info.importedIds) if (!entryClosure.has(dep)) queue.push(dep);
  }
  return (iconGraph = { entryClosure, imports, aliases });
}

/** 'vendor-icons' for an icon shared by lazy modules only; undefined leaves it where Rollup puts it. */
function iconChunk(id: string, meta: ChunkMeta): string | undefined {
  const file = /[^\\/]+$/.exec(id)?.[0] ?? '';
  const { entryClosure, imports, aliases } = iconGraphOf(meta);
  const names = aliases.get(file);
  // An icon the index does not name is left to Rollup — never guessed.
  if (!names) return undefined;
  let lazyUsers = 0;
  for (const [moduleId, imported] of imports) {
    let uses = false;
    for (const n of imported) if (names.has(n)) { uses = true; break; }
    if (!uses) continue;
    if (entryClosure.has(moduleId)) return undefined;
    lazyUsers += 1;
  }
  return lazyUsers >= 2 ? 'vendor-icons' : undefined;
}

function manualChunks(id: string, meta: ChunkMeta): string | undefined {
  if (id.includes('/src/translations.ts')) return 'vendor-i18n';
  // THE STORE LAYOUT'S TABLES AS ONE FILE (review 2026-09-30): the package's
  // three leaf tables (tokens, refs, blocks — no runtime imports of their own)
  // and the storefront's token → class lookups (theme.ts, which imports only
  // tokens). Every store page needs all four; the merchant's lazy screens
  // import them piecemeal (the announcement sheet, the preview QR, the speed
  // tab, the workshop settings, the product files, the accent sample), so left
  // to Rollup they split by importer set into three chunks — 287 B more gzip
  // and two more requests on every store visit (tests/bundleBudget.test.ts).
  // One group costs those merchant screens the rest of the 4.6 KB once, on
  // first open, and it is the file the builder and the store pages share.
  if (/[\\/]packages[\\/]storeLayout[\\/]src[\\/](?:tokens|refs|blocks)\.ts$/.test(id) || /[\\/]src[\\/]components[\\/]storefront[\\/]theme\.ts$/.test(id)) return 'store-layout';
  if (!id.includes('node_modules')) return undefined;
  // Match the package directory, so a nested dependency of a grouped package
  // (scheduler under react-dom, for instance) is grouped with it rather than
  // left behind in the entry.
  if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) return 'vendor-react';
  if (/[\\/]node_modules[\\/]ogl[\\/]/.test(id)) return 'vendor-webgl';
  if (/[\\/]node_modules[\\/]gsap[\\/]/.test(id)) return 'vendor-motion';
  if (/[\\/]node_modules[\\/](motion|motion-dom|motion-utils|framer-motion)[\\/]/.test(id)) return MOTION_FEATURES.test(id) ? 'vendor-motion' : 'vendor-motion-core';
  if (ICON_MODULE.test(id)) return iconChunk(id, meta);
  // The icon factory (`createLucideIcon`, the base `Icon`, the default
  // attributes) rides with React: every screen needs it, and a manual chunk
  // swallows the unassigned dependencies of its modules (Rollup), which
  // would pull the factory out of the entry into vendor-icons and make the
  // first paint wait for the icon chunk.
  // (Only the factory: the package index re-exports every icon, and assigning
  // it would drag all 269 of them along.)
  if (/[\\/]node_modules[\\/]lucide-react[\\/]dist[\\/]esm[\\/](?:createLucideIcon|Icon|defaultAttributes|shared[\\/].*)\.js$/.test(id)) return 'vendor-react';
  if (/[\\/]node_modules[\\/]recharts[\\/]/.test(id)) return 'vendor-charts';
  if (/[\\/]node_modules[\\/](d3-[a-z]+|victory-vendor|decimal\.js-light|internmap)[\\/]/.test(id)) return 'vendor-charts';
  if (/[\\/]node_modules[\\/]libphonenumber-js[\\/]/.test(id)) return 'vendor-phone';
  if (/[\\/]node_modules[\\/]jsqr[\\/]/.test(id)) return 'vendor-qr';
  return undefined;
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), documentComments()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      // `.vite/manifest.json` ships with the assets so the Worker can name a
      // route's chunk in a `<link rel="modulepreload">` before the entry has
      // even run (worker/index.ts `assetWithPreview`, plan §B.1 #3). It is a
      // map of file names, nothing the browser downloads.
      manifest: true,
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
