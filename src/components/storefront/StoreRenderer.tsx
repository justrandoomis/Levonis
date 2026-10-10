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
 *   - An address that asks for one part of the store (`/products`, `/about`,
 *     `?tab=…`, `?section=…`) on a page with no tab strip gets that part as a
 *     page of its own (./StoreViewPage.tsx) — on six of the seven starters
 *     such links used to draw the home page again.
 *   - What a visitor sees first on the classic page — the hero, the tab strip
 *     and the Products tab — ships with the storefront. The other tabs' views
 *     (and the blocks made of them) are one lazy chunk, fetched as soon as the
 *     browser is idle; every other block is a second lazy chunk, fetched the
 *     first time a layout uses one (tests/bundleBudget.test.ts).
 *
 * MEDIA EVERYWHERE (P5, docs/MERCHANT_PLATFORM_V2.md storefront L3–L8):
 *   - A PAGE BACKGROUND (./BackgroundLayer.tsx, a lazy chunk) paints behind the blocks, and
 *     then every block, the notice, the footer and the host's own footer sit
 *     on the theme's OPAQUE ground in a card of the page's column — text is
 *     never read off a picture, whatever its dim (§8). No new CSS: the card is
 *     `sf-bg sf-r-lg`, the dims are overlay classes the app ships.
 *   - The NOTICE LINE comes after the first block (under the bar for the
 *     `bar` header), judged against `now`.
 *   - SCHEDULED blocks: the live page shows a block only inside its window
 *     (`renderableBlocks(layout, now, 'live')`; the answer is cached at the
 *     edge, so the client decides); the builder's preview shows every block
 *     and marks the scheduled ones. A live page left with nothing to show
 *     falls back to the classic page's blocks, never to an empty page.
 *   - `now` is the instant the page is judged at: the host may pass the
 *     server's clock; without one it is the device's, read once per mount.
 */
import { Fragment, lazy, Suspense, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { normalizeLayout, renderableBlocks } from '../../../packages/storeLayout/src/normalize';
import { defaultLayoutFromStore } from '../../../packages/storeLayout/src/defaults';
import { emptyBlockData, type BlockData } from '../../../packages/storeLayout/src/data';
import { backgroundAttributes } from '../../../packages/storeLayout/src/tokens';
import type { BlockType } from '../../../packages/storeLayout/src/blocks';
import type { StoreBlock, StoreLayout } from '../../../packages/storeLayout/src/schema';
import { useLanguage } from '../../LanguageContext';
import StoreTheme, { useStoreTheme } from './StoreTheme';
import { NoticeLine, StoreFooter, StoreHeader } from './StoreHeader';
import BackgroundLayer, { BackgroundToggle } from './BackgroundLayer';
import { backgroundActive } from './theme';
import { storefrontStrings } from './strings';
import { useStorefrontRuntime } from './runtime';
import { addressedView } from './addressedView';
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

/** One part of the store as its own page, on a layout with no tab strip. */
const StoreViewPage = lazy(() => import('./StoreViewPage'));

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

/**
 * The column-wide card every block sits in over a page background: the
 * theme's own opaque ground (`sf-bg`), its radius, a hairline; a gutter
 * outside it so the picture shows around it. A block that renders nothing
 * leaves no empty card (`empty:hidden`).
 */
export const BG_GUTTER = 'px-2 @min-[40rem]:px-6';
export const BG_CARD = 'sf-col sf-bg sf-r-lg overflow-hidden border border-white/10 empty:hidden';

function Block({ block, store, data, wrap = false, scheduled = false }: { block: StoreBlock; store: StorefrontStore; data: BlockData; wrap?: boolean; scheduled?: boolean }) {
  const Core = CORE_BLOCKS[block.type];
  const Lazy = TAB_VIEW_BLOCKS.includes(block.type) ? TabViewBlock : ExtraBlock;
  const { lang } = useLanguage();
  const inner = Core ? (
    <Core block={block} store={store} data={data} />
  ) : (
    <Suspense fallback={<div className="min-h-12" />}>
      <Lazy block={block} store={store} data={data} />
    </Suspense>
  );
  // The hero's picture meets the card's top edge; its last row keeps the card's own bottom padding.
  const body = wrap ? <div className={`${BG_CARD}${block.type === 'hero' ? ' pb-4' : ' py-4'}`}>{inner}</div> : inner;
  return (
    <div data-block={block.type} data-block-id={block.id} data-scheduled={scheduled ? '' : undefined} className={`${visibilityClass(block)}${wrap ? ` ${BG_GUTTER}` : ''}`.trim()}>
      {scheduled ? (
        // The builder's preview marks a scheduled block — a dashed frame the
        // width of the page's column, with its word — because it shows every
        // block whatever the clock says.
        <div className="sf-col relative rounded-xl border border-dashed border-white/30" data-scheduled-frame="">
          <span className="absolute -top-3 end-3 z-10 rounded-full bg-black/60 px-2 py-0.5 text-[10.5px] text-snow" data-scheduled-mark="">
            {storefrontStrings(lang).media.scheduled}
          </span>
          {body}
        </div>
      ) : (
        body
      )}
    </div>
  );
}

/**
 * The blocks this page shows now. Preview: every renderable block. Live: those
 * inside their schedule at `now` — and when that leaves nothing (every block
 * still to come), the classic page's blocks instead of an empty page.
 */
export function blocksNow(layout: StoreLayout, store: StorefrontStore, now: string, live: boolean): StoreBlock[] {
  if (!live) return renderableBlocks(layout);
  const shown = renderableBlocks(layout, now, 'live');
  return shown.length ? shown : renderableBlocks(defaultLayoutFromStore(store));
}

/** The host's own footer and the addressed views, in the same card as the blocks over a background. */
function OnGround({ wrap, children, pad = true }: { wrap: boolean; children: ReactNode; pad?: boolean }) {
  if (!wrap) return <>{children}</>;
  return (
    <div className={`${BG_GUTTER} mt-4`}>
      <div className={`${BG_CARD}${pad ? ' py-4' : ''}`}>{children}</div>
    </div>
  );
}

/** The classic ground's accent haze: the accent's own tint, faded to nothing
 *  by a radial mask (docs/DECISIONS.md row 208). It used to be a 120px blur
 *  filter, re-rastered under scrolling; the mask draws the same haze once. */
function Glow() {
  const { accent } = useStoreTheme();
  return (
    <div
      aria-hidden="true"
      className={`sf-glow fixed top-0 left-1/2 -translate-x-1/2 w-full max-w-2xl h-[380px] ${accent.glow} [mask-image:radial-gradient(closest-side,#000,transparent)] pointer-events-none z-0`}
    />
  );
}

export default function StoreRenderer({
  store,
  layout: rawLayout,
  data: dataOverride,
  className = '',
  footer = null,
  now,
}: {
  store: StorefrontStore;
  /** A layout to render instead of the store's own (a draft, a revision). */
  layout?: unknown;
  data?: BlockData;
  className?: string;
  /** Something the page hangs under the blocks, INSIDE the store's theme island — a related-stores rail. */
  footer?: ReactNode;
  /** The instant schedules and the notice window are judged at (ISO) — the server's, when the host has it. */
  now?: string;
}) {
  const rt = useStorefrontRuntime();
  const layout = useMemo(() => renderableLayout(rawLayout ?? store.layout, store), [rawLayout, store]);
  const data = useMemo(() => dataOverride ?? blockData(store), [dataOverride, store]);
  const clock = useMemo(() => now ?? new Date().toISOString(), [now]);
  const live = rt.mode === 'live';
  const blocks = blocksNow(layout, store, clock, live);
  const view = addressedView(blocks, rt);
  usePrefetchTabViews(blocks.some((b) => b.type === 'tabs'));

  // The page background (L4). Whether its video may move (the device, the
  // hero's own video — one <video> at a time — and the visitor's «stop») is
  // decided in its lazy chunk (./BackgroundMedia.tsx); the «stop» is kept here
  // because the layer and its control sit at the two ends of the page.
  const bg = layout.background;
  const withBg = backgroundActive(bg);
  const [bgStopped, setBgStopped] = useState(false);
  const notice = <NoticeLine header={layout.header} store={store} data={data} now={clock} solid={withBg} />;
  const noticeUnderBar = layout.header.variant === 'bar';

  return (
    <StoreTheme tokens={layout.tokens} storeAccent={store.accent} className={`relative text-zinc-300 ${className}`}>
      {withBg ? <BackgroundLayer background={bg} stopped={bgStopped} /> : <Glow />}
      <div className="@container relative z-0" {...(withBg ? backgroundAttributes(bg) : {})}>
        <StoreHeader variant={layout.header.variant} store={store} notice={noticeUnderBar ? notice : null} solid={withBg} />
        {view ? (
          // A part of the store on its own page carries no notice for the `overlay` / `none` headers:
          // its top belongs to the header's corner controls and the part's own title.
          <OnGround wrap={withBg}>
            <Suspense fallback={<div className="min-h-48" />}>
              <StoreViewPage kind={view} store={store} data={data} header={layout.header.variant} />
            </Suspense>
          </OnGround>
        ) : (
          <div className="sf-stack">
            {blocks.map((b, i) => (
              <Fragment key={b.id}>
                <Block block={b} store={store} data={data} wrap={withBg} scheduled={!live && !!b.schedule} />
                {i === 0 && !noticeUnderBar && notice}
              </Fragment>
            ))}
          </div>
        )}
        {footer && <OnGround wrap={withBg}>{footer}</OnGround>}
        <StoreFooter variant={layout.footer.variant} store={store} links={layout.footer.links} data={data} solid={withBg} />
        {/* A moving background can be stopped (WCAG 2.2.2) — here, at the page's end, where it covers nothing. */}
        {withBg && live && <BackgroundToggle background={bg} stopped={bgStopped} onToggle={() => setBgStopped((v) => !v)} />}
      </div>
    </StoreTheme>
  );
}
