/**
 * The store page rendered for real, in Node: the renderer the storefront uses
 * (src/components/storefront/StoreRenderer.tsx) under the language provider,
 * a router and the INERT preview runtime — so nothing a test renders can act.
 *
 * `prerender` (react-dom/static) waits for every lazy chunk, so the blocks
 * outside the classic page's chunk render too, not their fallback.
 *
 * The store is what the Worker answers for the seeded fixture store
 * (tests/fixtures/storeLayout.ts): the real JSON, blocks data included.
 */
import { createElement } from 'react';
import { prerender } from 'react-dom/static';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../../src/LanguageContext';
import StoreRenderer from '../../src/components/storefront/StoreRenderer';
import { StorefrontRuntimeProvider, type StorefrontRuntime } from '../../src/components/storefront/runtime';
import { previewRuntime } from '../../src/components/storefront/preview';
import type { StorefrontStore } from '../../src/components/storefront/types';
import type { BlockData } from '../../packages/storeLayout/src/data';
import type { StoreLayout } from '../../packages/storeLayout/src/schema';
import { storefrontRoutes } from '../../worker/routes/storefront';
import { blockDataFor } from '../../worker/lib/storeLayout';
import { storeById } from '../../worker/lib/merchantAuth';
import { asD1, freshDb, get, json, stubApp } from './app';
import { SLUG, STORE_ID, seedLayoutStore } from './storeLayout';

export type Lang = 'ar' | 'en';

/** The language provider reads localStorage once, when it mounts. */
function setLanguage(lang: Lang) {
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (k === 'levo_lang' ? lang : null),
    setItem: () => {},
    removeItem: () => {},
  };
}

/**
 * React.lazy suspends the first time its chunk is asked for, and prerender
 * then streams the late content with its own small inline scripts. One
 * throwaway render per process loads the chunk, so every render a test looks
 * at is the plain markup — and "no <script> in the page" means exactly that.
 */
let lazyChunkLoaded = false;

export async function renderStore(
  store: StorefrontStore,
  opts: { layout?: unknown; data?: BlockData; lang?: Lang; runtime?: Partial<StorefrontRuntime> } = {}
): Promise<string> {
  if (!lazyChunkLoaded) {
    lazyChunkLoaded = true;
    await renderStore(store, { layout: { schema_version: 1, blocks: [{ type: 'text' }] } });
  }
  setLanguage(opts.lang ?? 'ar');
  const tree = createElement(
    MemoryRouter,
    null,
    createElement(
      LanguageProvider,
      null,
      createElement(
        StorefrontRuntimeProvider,
        { value: previewRuntime(opts.runtime) },
        createElement(StoreRenderer, { store, layout: opts.layout, data: opts.data })
      )
    )
  );
  // One chunk: React otherwise moves large Suspense content out of line and
  // stitches it back with its own inline scripts.
  const { prelude } = await prerender(tree, { progressiveChunkSize: Number.MAX_SAFE_INTEGER });
  return new Response(prelude as unknown as ReadableStream).text();
}

/** The seeded store as `/api/storefront/:slug` answers it (classic page, no layout published). */
export async function fixtureStore(): Promise<StorefrontStore> {
  const raw = freshDb();
  seedLayoutStore(raw);
  const app = stubApp(asD1(raw), null, (a) => a.route('/api/storefront', storefrontRoutes), {
    env: { STORE_ROOT_DOMAIN: 'levonis-iq.com' },
  });
  const res = await get(app, `/api/storefront/${SLUG}`);
  const body = await json(res);
  if (res.status !== 200) throw new Error(`fixture store: ${res.status} ${JSON.stringify(body)}`);
  return body.store as StorefrontStore;
}

/** The rows a (normalised) layout's blocks show, read by the Worker's own code from the seeded store. */
export async function fixtureData(layout: StoreLayout): Promise<BlockData> {
  const raw = freshDb();
  seedLayoutStore(raw);
  const db = asD1(raw);
  const ctx = await storeById(db, STORE_ID);
  if (!ctx) throw new Error('fixture store missing');
  return blockDataFor(db, ctx, layout);
}

/** Every attribute value of `name` in the markup, decoded enough to inspect. */
export function attributeValues(html: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\s${name}="([^"]*)"`, 'g');
  for (let m = re.exec(html); m; m = re.exec(html)) out.push(m[1].replace(/&amp;/g, '&'));
  return out;
}

/** The markup's text, tags removed — what a visitor reads. */
export function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
