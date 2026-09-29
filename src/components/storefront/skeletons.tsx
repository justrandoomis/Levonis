/**
 * The store pages' loading screens (merchant programme P1c, storefront L1;
 * docs/PERFORMANCE_LOG.md «P1c»).
 *
 * Every box here is the REAL box it stands in for, so the swap from loading
 * to content moves nothing: the same wrapper classes, the same paddings, and
 * — for every line of text — the same type classes around a zero-width
 * space, so the line box is exactly as tall as the words will be at every
 * breakpoint without one new utility class in the stylesheet. The bars
 * themselves are `Skeleton` from ui/Skeleton (already in the entry chunk);
 * this file rides with the store pages, never with the first paint of the
 * main site.
 *
 * Only what every product / every store has is reserved: a facts list or a
 * variant picker that a product may not carry is not drawn in advance
 * (drawing it would shift the page UP when the answer arrives without one);
 * `ProductFactsSkeleton` reserves the facts once the answer says how many.
 */
import { Skeleton, SkeletonGroup } from '../ui/Skeleton';
import { gridClasses } from './theme';
import { useStoreTheme } from './StoreTheme';

const ZW = '​';

/** A bar inside a real line box: the parent carries the text classes. */
function Line({ w, h = 'h-3' }: { w: string; h?: string }) {
  return (
    <>
      <Skeleton className={`inline-block align-middle ${h} ${w}`} />
      {ZW}
    </>
  );
}

/**
 * The classic store page before its answer: cover → identity → stats → bio →
 * links → info cards → actions → the tab strip → the products grid, with the
 * same geometry blocks/Hero.tsx and blocks/Tabs.tsx draw (measured at 360:
 * cover 144, identity 103, stats 43, bio 36, links 28, cards 51, actions 30,
 * strip 44, tiles 103 × 156).
 */
export function StoreHomeSkeleton() {
  return (
    <div className="min-h-screen bg-black text-zinc-300 pb-24">
      <SkeletonGroup className="@container relative z-0">
        <div aria-hidden="true">
          <div className="h-36 @min-[40rem]:h-48 w-full bg-white/[0.03] animate-pulse motion-reduce:animate-none" />
          <div className="sf-col px-4 @min-[40rem]:px-6 relative">
            <div dir="ltr" className="flex items-start gap-4 mb-3.5 -mt-[18px]">
              <Skeleton className="w-[72px] h-[72px] rounded-full shrink-0" />
              <div className="min-w-0 flex-1 pt-2.5">
                <p className="sf-name leading-tight">
                  <Line w="w-2/3" h="h-4" />
                </p>
                <p className="text-[12px]">
                  <Line w="w-24" h="h-2.5" />
                </p>
                <p className="text-[12.5px] mt-1">
                  <Line w="w-32" h="h-2.5" />
                </p>
              </div>
            </div>
            <div className="flex items-center mb-3.5">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex-1 py-1 px-1 text-center">
                  <p className="text-[14px] leading-tight">
                    <Line w="w-10" h="h-3" />
                  </p>
                  <p className="text-[11px]">
                    <Line w="w-14" h="h-2.5" />
                  </p>
                </div>
              ))}
            </div>
            <p className="text-[13px] leading-snug text-center mb-4 px-2">
              <Line w="w-4/5" h="h-3" />
            </p>
            <div className="grid grid-cols-2 gap-3 mb-3 px-1.5">
              <Skeleton className="h-7 rounded-full" />
              <Skeleton className="h-7 rounded-full" />
            </div>
            <div dir="rtl" className="grid grid-cols-2 gap-3 mb-4">
              {[0, 1].map((i) => (
                <div key={i} className="sf-fact px-2 py-2.5 flex items-center justify-center gap-2 min-w-0">
                  <Skeleton className="w-4 h-4 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-[12.5px] leading-tight">
                      <Line w="w-16" h="h-2.5" />
                    </p>
                    <p className="text-[11px] leading-tight">
                      <Line w="w-10" h="h-2.5" />
                    </p>
                  </div>
                </div>
              ))}
            </div>
            <Skeleton className="h-[30px] rounded-full mb-4" />
          </div>
          <div className="sf-col px-4 @min-[40rem]:px-6 mt-4">
            <div className="border-b border-white/10 mb-4 h-11 flex items-center gap-6">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-16" />
            </div>
            <ProductGridLoading />
          </div>
        </div>
      </SkeletonGroup>
    </div>
  );
}

/**
 * The products tab before its rows: tiles in the theme's own grid (columns,
 * gap, ratio, card style all come from the same classes the real tiles use).
 */
export function ProductGridLoading({ count = 6 }: { count?: number }) {
  const { tokens } = useStoreTheme();
  return (
    <SkeletonGroup>
      {/* The view's title row («أحدث المنتجات» and its «الكل» link), 36px. */}
      <div dir="rtl" aria-hidden="true" className="flex items-center justify-between mb-3">
        <p className="sf-title">
          <Line w="w-32" h="h-3.5" />
        </p>
      </div>
      <div dir="rtl" aria-hidden="true" className={`grid sf-grid ${gridClasses(tokens)}`}>
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="sf-tile">
            <div className="sf-media sf-well animate-pulse motion-reduce:animate-none" />
            <div className="sf-tile-body">
              <p className="text-[12.5px] leading-snug">
                <Line w="w-4/5" h="h-2.5" />
              </p>
              <p className="text-[12px] mt-0.5">
                <Line w="w-1/2" h="h-2.5" />
              </p>
            </div>
          </div>
        ))}
      </div>
    </SkeletonGroup>
  );
}

/**
 * pages/StorefrontProduct.tsx before its answer: the back row, the square
 * gallery, the name, the price, the store card and three lines of
 * description — the parts every product has — plus the buy bar's box.
 */
export function StoreProductPageSkeleton() {
  return (
    <div className="min-h-screen bg-black text-zinc-300 pb-32">
      <SkeletonGroup className="max-w-2xl mx-auto">
        <div aria-hidden="true">
          <div className="px-4 sm:px-6 pt-4 mb-2 flex items-center justify-between gap-3">
            <Skeleton className="h-11 w-24 rounded-lg" />
            <div className="h-11 w-[96px] shrink-0" />
          </div>
          <div className="aspect-square sm:aspect-[4/3] bg-black/40 animate-pulse motion-reduce:animate-none" />
          <div className="px-4 sm:px-6 pt-4">
            <p className="text-[18px] leading-snug mb-2">
              <Line w="w-2/3" h="h-4" />
            </p>
            <p className="text-xl mb-4">
              <Line w="w-24" h="h-5" />
            </p>
            <div className="flex items-center gap-2.5 rounded-2xl border border-white/10 bg-white/[0.03] p-3 mb-4">
              <Skeleton className="w-9 h-9 rounded-xl shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1 text-[13px]">
                  <Line w="w-32" h="h-3" />
                </div>
                {/* An inline span, as the rating is: its line box is the parent's strut, not the 11.5px face. */}
                <span className="text-[11.5px]">
                  <Line w="w-20" h="h-2.5" />
                </span>
              </div>
            </div>
            <p className="text-[13.5px] leading-relaxed">
              <Line w="w-full" h="h-3" />
            </p>
            <p className="text-[13.5px] leading-relaxed">
              <Line w="w-5/6" h="h-3" />
            </p>
            <p className="text-[13.5px] leading-relaxed mb-6">
              <Line w="w-2/3" h="h-3" />
            </p>
          </div>
        </div>
      </SkeletonGroup>
      <div aria-hidden="true" className="fixed bottom-0 inset-x-0 z-40 border-t border-white/10 bg-black/95 backdrop-blur-xl px-4 sm:px-6 py-3">
        <div className="max-w-2xl mx-auto flex items-center gap-3">
          <Skeleton className="h-11 w-28 rounded-xl shrink-0" />
          <Skeleton className="flex-1 min-h-[48px] rounded-2xl" />
        </div>
      </div>
    </div>
  );
}

/** The facts catalog/ProductFacts reads (packages/catalog/src/attributes `Attributes`, structurally). */
type FactFields = {
  material?: string | null;
  technology?: string | null;
  color?: string | null;
  finish?: string | null;
  dim_x_mm?: number | null;
  dim_y_mm?: number | null;
  dim_z_mm?: number | null;
  weight_g?: number | null;
};

/** How many rows catalog/ProductFacts will draw for these attributes — the same tests, in the same order. */
export function factRows(a: FactFields | undefined): number {
  if (!a) return 0;
  let n = 0;
  if (a.material) n++;
  if (a.technology) n++;
  if (a.color) n++;
  if (a.finish) n++;
  if ([a.dim_x_mm, a.dim_y_mm, a.dim_z_mm].some((d) => d != null)) n++;
  if (a.weight_g != null) n++;
  return n;
}

/**
 * The facts list's box while its chunk arrives: the same `dl` classes and
 * one dt/dd line pair per row, so the real list lands on the same pixels.
 */
export function ProductFactsSkeleton({ rows }: { rows: number }) {
  if (rows <= 0) return null;
  return (
    <div
      aria-hidden="true"
      className="mb-6 grid grid-cols-2 gap-x-4 gap-y-2 rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-[12.5px]"
    >
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="min-w-0">
          <p>
            <Line w="w-12" h="h-2.5" />
          </p>
          <p>
            <Line w="w-20" h="h-2.5" />
          </p>
        </div>
      ))}
    </div>
  );
}
