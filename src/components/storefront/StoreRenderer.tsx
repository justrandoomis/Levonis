/**
 * THE STORE RENDERER — one layout in, one store page out. The storefront
 * imports it for the published layout; the builder's preview (wave 4) and the
 * design panel import it for a draft. Same components, same result.
 *
 *   - The layout is normalised AGAIN here (packages/storeLayout, shape only —
 *     the server already checked ownership) before a single block renders, so
 *     whatever arrived, only the allow-listed schema reaches the DOM. A layout
 *     with nothing a visitor could see falls back to the classic page.
 *   - The page is a CONTAINER: blocks respond to its width (Tailwind's
 *     `@container` variants), not the viewport's, so a preview frame lays out
 *     exactly like a device of that width. Per-block visibility is the same
 *     test at 48rem.
 *   - What a visitor sees first on the classic page — the hero, the tab strip
 *     and the Products tab — ships with the storefront. The other tabs' views
 *     (and the blocks made of them) are one lazy chunk, fetched as soon as the
 *     browser is idle; every other block is a second lazy chunk, fetched the
 *     first time a layout uses one (tests/bundleBudget.test.ts).
 */
import { lazy, Suspense, useEffect, useMemo, type ComponentType } from 'react';
import { normalizeLayout, renderableBlocks } from '../../../packages/storeLayout/src/normalize';
import { defaultLayoutFromStore } from '../../../packages/storeLayout/src/defaults';
import { emptyBlockData, type BlockData } from '../../../packages/storeLayout/src/data';
import type { BlockType } from '../../../packages/storeLayout/src/blocks';
import type { StoreBlock, StoreLayout } from '../../../packages/storeLayout/src/schema';
import StoreTheme, { useStoreTheme } from './StoreTheme';
import { StoreFooter, StoreHeader } from './StoreHeader';
import { useStorefrontRuntime } from './runtime';
import HeroBlock from './blocks/Hero';
import TabsBlock from './blocks/Tabs';
import ProductsGridBlock from './blocks/ProductsGrid';
import type { BlockProps, StorefrontStore } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBlockComponent = ComponentType<BlockProps<any>>;

/** What the classic page shows first — in the storefront chunk. */
export const CORE_BLOCKS: Partial<Record<BlockType, AnyBlockComponent>> = {
  hero: HeroBlock,
  tabs: TabsBlock,
  products_grid: ProductsGridBlock,
};

/** Blocks made of the classic page's other tabs: blocks/tabViews.tsx, one lazy chunk. */
export const TAB_VIEW_BLOCKS: readonly BlockType[] = ['collections', 'deals', 'services', 'showcase', 'reviews', 'about'];

const TabViewBlock = lazy(() => import('./blocks/tabViews'));

/** Every other block, in one chunk fetched when a layout first needs it. */
const ExtraBlock = lazy(() => import('./blocks/extra'));

/**
 * The other tabs' chunk, fetched once the page is idle, so the first tab a
 * visitor picks is already there. The storefront's first paint never waits
 * for it.
 */
function usePrefetchTabViews(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const load = () => {
      import('./blocks/tabViews').catch(() => {
        /* the tab loads it on demand */
      });
    };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(load);
      return () => w.cancelIdleCallback?.(id);
    }
    const t = window.setTimeout(load, 1500);
    return () => window.clearTimeout(t);
  }, [enabled]);
}

/** The layout to render: normalised, and never one a visitor would see as empty. */
export function renderableLayout(raw: unknown, store: StorefrontStore): StoreLayout {
  if (raw) {
    const { layout } = normalizeLayout(raw, { ownerUserId: null });
    if (renderableBlocks(layout).length) return layout;
  }
  return defaultLayoutFromStore(store);
}

export function blockData(store: StorefrontStore): BlockData {
  return { ...emptyBlockData(), ...(store.blocks_data ?? {}) } as BlockData;
}

/** Shown below 48rem only, at 48rem and up only, or both. */
function visibilityClass(b: StoreBlock): string {
  if (!b.visibility.mobile) return 'hidden @min-[48rem]:block';
  if (!b.visibility.desktop) return '@min-[48rem]:hidden';
  return '';
}

function Block({ block, store, data }: { block: StoreBlock; store: StorefrontStore; data: BlockData }) {
  const Core = CORE_BLOCKS[block.type];
  const Lazy = TAB_VIEW_BLOCKS.includes(block.type) ? TabViewBlock : ExtraBlock;
  return (
    <div data-block={block.type} data-block-id={block.id} className={visibilityClass(block)}>
      {Core ? (
        <Core block={block} store={store} data={data} />
      ) : (
        <Suspense fallback={<div className="min-h-12" />}>
          <Lazy block={block} store={store} data={data} />
        </Suspense>
      )}
    </div>
  );
}

function Glow() {
  const { accent } = useStoreTheme();
  return (
    <div
      aria-hidden="true"
      className={`sf-glow fixed top-0 left-1/2 -translate-x-1/2 w-full max-w-2xl h-[380px] ${accent.glow} rounded-full blur-[120px] pointer-events-none z-0`}
    />
  );
}

export default function StoreRenderer({
  store,
  layout: rawLayout,
  data: dataOverride,
  className = '',
}: {
  store: StorefrontStore;
  /** A layout to render instead of the store's own (a draft, a revision). */
  layout?: unknown;
  data?: BlockData;
  className?: string;
}) {
  const rt = useStorefrontRuntime();
  const layout = useMemo(() => renderableLayout(rawLayout ?? store.layout, store), [rawLayout, store]);
  const data = useMemo(() => dataOverride ?? blockData(store), [dataOverride, store]);
  let blocks = renderableBlocks(layout);
  // An address that asks for one collection (`?section=`) on a page with no
  // tab strip to show it in gets that collection first, as a grid.
  if (rt.section && !blocks.some((b) => b.type === 'tabs')) {
    const shelf = normalizeLayout(
      { blocks: [{ id: 'collection-view', type: 'products_grid', settings: { source: 'collection', collection_id: rt.section, limit: 24 } }] },
      { ownerUserId: null }
    ).layout.blocks;
    blocks = [...shelf, ...blocks];
  }
  usePrefetchTabViews(blocks.some((b) => b.type === 'tabs'));

  return (
    <StoreTheme tokens={layout.tokens} storeAccent={store.accent} className={`relative text-zinc-300 ${className}`}>
      <Glow />
      <div className="@container relative z-0">
        <StoreHeader variant={layout.header.variant} store={store} />
        <div className="sf-stack">
          {blocks.map((b) => (
            <Block key={b.id} block={b} store={store} data={data} />
          ))}
        </div>
        <StoreFooter variant={layout.footer.variant} store={store} />
      </div>
    </StoreTheme>
  );
}
