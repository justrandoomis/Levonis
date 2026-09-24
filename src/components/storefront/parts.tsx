/**
 * Pieces several blocks share: the product card and grid, the price line, the
 * empty state, a titled card, and the ONE component that turns a typed link
 * into an anchor. Presentation only — anything that acts comes from the
 * runtime (runtime.tsx).
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Heart, Loader2, ShoppingBag } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { GOVERNORATE_LABELS } from '../../lib/governorates';
import type { ProfileWidget } from '../../lib/merchant';
import { safeExternalUrl, type LinkTarget } from '../../../packages/storeLayout/src/refs';
import { pickText, type LocalizedText } from '../../../packages/storeLayout/src/text';
import type { BlockData } from '../../../packages/storeLayout/src/data';
import { useSavedIds, useStorefrontRuntime } from './runtime';
import { useStoreTheme } from './StoreTheme';
import { gridClasses } from './theme';
import type { StorefrontStore } from './types';

export type Loc = (ar: string, en: string, ckb?: string) => string;

/** The fields a product card reads — the public card shape and the full product both carry them. */
export interface CardProduct {
  id: string;
  slug: string;
  name: string;
  images: string[];
  price_iqd: number;
  original_price_iqd: number | null;
  in_stock?: boolean;
  featured?: boolean;
}

/** Merchant text in the viewer's language, falling back to what the merchant wrote. */
export function useText(): (t: LocalizedText | null | undefined) => string {
  const { lang } = useLanguage();
  return (t) => pickText(t, lang);
}

/**
 * The profile's price line, written the way the reference writes it: the
 * dinar marker «ع.» immediately left of the western digits. The flex row makes
 * that ordering deterministic — bidi resolution never gets a say.
 */
export function DinarPrice({ amount, className = '' }: { amount: number; className?: string }) {
  return (
    <span className={`inline-flex flex-row items-baseline ${className}`} dir="ltr">
      <span>ع.</span>
      <span>{Number(amount).toLocaleString('en-US')}</span>
    </span>
  );
}

export function Empty({ icon, text, hint }: { icon: ReactNode; text: string; hint?: string }) {
  return (
    <div className="py-12 text-center">
      <div className="flex justify-center mb-3">{icon}</div>
      <p className="text-zinc-400 text-[13px]">{text}</p>
      {hint && <p className="text-zinc-600 text-[11.5px] mt-1.5">{hint}</p>}
    </div>
  );
}

export function Loading() {
  return (
    <div className="py-10 flex justify-center">
      <Loader2 className="w-5 h-5 text-gold animate-spin" aria-hidden="true" />
    </div>
  );
}

/** A titled card (the About panels). */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="sf-card sf-card-pad">
      <h3 className="text-gold font-bold text-[12.5px] mb-2.5">{title}</h3>
      {children}
    </div>
  );
}

/** A block's own heading, when the merchant gave it one. */
export function BlockHeading({ title, action }: { title: string; action?: ReactNode }) {
  if (!title && !action) return null;
  return (
    <div className="flex items-center justify-between gap-3 mb-3">
      {title ? (
        <h2 className="sf-title text-white min-w-0 [text-wrap:balance]" dir="auto">
          {title}
        </h2>
      ) : (
        <span />
      )}
      {action}
    </div>
  );
}

/** The content column every block sits in. */
export function Column({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`sf-col px-4 @min-[40rem]:px-6 ${className}`}>{children}</div>;
}

// ----------------------------------------------------------------- products

export function ProductCard({ product, storeOpen, legacyLink = false }: { product: CardProduct; storeOpen: boolean; legacyLink?: boolean }) {
  const { loc } = useLanguage();
  const rt = useStorefrontRuntime();
  const href = legacyLink ? rt.legacyProductHref(product.slug) : rt.productHref(product.slug);
  const image = product.images[0];
  const discounted = !!product.original_price_iqd && product.original_price_iqd > product.price_iqd;
  const sellable = storeOpen && product.in_stock !== false;
  const saved = useSavedIds().has(product.id);

  return (
    <Link to={href} className="sf-tile active:scale-[0.98] transition-transform">
      <div className="sf-media sf-well overflow-hidden relative">
        {image ? (
          <img src={image} alt={product.name} className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <ShoppingBag className="w-5 h-5 text-zinc-700" strokeWidth={1.5} aria-hidden="true" />
          </div>
        )}
        {/* The heart lives on the image's physical top-left, as drawn. */}
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            rt.toggleSave(product.id);
          }}
          className="absolute top-1.5 left-1.5 w-[22px] h-[22px] rounded-full bg-[#10161f]/85 flex items-center justify-center"
          aria-label={saved ? loc('إزالة من المحفوظات', 'Remove from saved', 'لابردن') : loc('حفظ المنتج', 'Save product', 'پاشەکەوتکردن')}
          aria-pressed={saved}
        >
          <Heart className={`w-3 h-3 ${saved ? 'text-rose-500 fill-rose-500' : 'text-white'}`} strokeWidth={2} aria-hidden="true" />
        </button>
        {discounted && (
          <span className="absolute top-1.5 right-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-red-500/85 text-white" dir="ltr">
            −{Math.round((1 - product.price_iqd / (product.original_price_iqd as number)) * 100)}%
          </span>
        )}
        {!sellable && (
          <span className="sf-tile-flag absolute bottom-1 start-1 text-[8.5px] font-bold px-1.5 py-0.5 rounded-full bg-zinc-800/90 text-zinc-300">
            {loc('غير متوفر', 'Unavailable', 'بەردەست نییە')}
          </span>
        )}
      </div>
      <div className="sf-tile-body">
        <p className="text-zinc-300 text-[12.5px] truncate leading-snug" dir="auto">
          {product.name}
        </p>
        {/* One price line that never wraps — the −% badge already tells the
            deal story on a card this narrow. */}
        <p className="text-zinc-400 text-[12px] whitespace-nowrap mt-0.5">
          <DinarPrice amount={product.price_iqd} />
        </p>
      </div>
    </Link>
  );
}

export function ProductGrid({ products, storeOpen, legacyLinks = false }: { products: CardProduct[]; storeOpen: boolean; legacyLinks?: boolean }) {
  const { tokens } = useStoreTheme();
  return (
    <div dir="rtl" className={`grid sf-grid ${gridClasses(tokens)}`}>
      {products.map((p) => (
        <ProductCard key={p.id} product={p} storeOpen={storeOpen} legacyLink={legacyLinks} />
      ))}
    </div>
  );
}

/** One row that scrolls sideways, snapping card by card. */
export function ProductShelf({ products, storeOpen }: { products: CardProduct[]; storeOpen: boolean }) {
  return (
    <div dir="rtl" className="sf-shelf pb-1">
      {products.map((p) => (
        <ProductCard key={p.id} product={p} storeOpen={storeOpen} />
      ))}
    </div>
  );
}

// -------------------------------------------------------------------- links

/**
 * A typed link, rendered. Internal destinations become router links through
 * the runtime; a product link names a product the server preloaded (so a
 * product that is not live renders as plain content, never a dead link); an
 * external address is re-checked here and opens in a new tab that gets no
 * handle on this page. Anything else renders its children unlinked.
 */
export function LinkTo({
  link,
  data,
  className = '',
  children,
}: {
  link: LinkTarget;
  data: BlockData;
  className?: string;
  children: ReactNode;
}) {
  const rt = useStorefrontRuntime();
  switch (link.kind) {
    case 'route':
      return (
        <Link to={rt.routeHref(link.route)} className={className}>
          {children}
        </Link>
      );
    case 'collection':
      return (
        <Link to={rt.collectionHref(link.id)} className={className}>
          {children}
        </Link>
      );
    case 'product': {
      const p = data.picked.find((x) => x.id === link.id);
      return p ? (
        <Link to={rt.productHref(p.slug)} className={className}>
          {children}
        </Link>
      ) : (
        <span className={className}>{children}</span>
      );
    }
    case 'external': {
      const href = safeExternalUrl(link.url);
      return href ? (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow" className={className}>
          {children}
        </a>
      ) : (
        <span className={className}>{children}</span>
      );
    }
    default:
      return <span className={className}>{children}</span>;
  }
}

export function hasLink(link: LinkTarget, data: BlockData): boolean {
  if (link.kind === 'none') return false;
  if (link.kind === 'product') return data.picked.some((x) => x.id === link.id);
  if (link.kind === 'external') return !!safeExternalUrl(link.url);
  return true;
}

// ------------------------------------------------------------ store helpers

/**
 * What a link pill SAYS must not contradict where it GOES. A free-text title
 * («تابعنا على إنستغرام») shows as written; a title that reads like an
 * address but names a different host than the real destination is replaced
 * by the destination's own host — a platform-branded page must not lend its
 * trust to «instagram.com/…» pointing somewhere else.
 */
export function linkPillLabel(w: ProfileWidget): string {
  if (!w.url) return w.title;
  let host = '';
  try {
    host = new URL(w.url).host.replace(/^www\./, '').toLowerCase();
  } catch {
    return w.title;
  }
  const looksLikeAddress = /^[^\s]+\.[^\s]{2,}/.test(w.title.trim());
  if (looksLikeAddress && host && !w.title.toLowerCase().includes(host)) return host;
  return w.title;
}

/**
 * The info cards, with an honest fallback: until the merchant arranges their
 * own three, the store's existing facts fill the row (location, coverage,
 * delivery note) — real values, never invented ones.
 */
export function factsWithFallback(store: StorefrontStore, loc: Loc, lang: string): ProfileWidget[] {
  // Once the merchant has arranged this row at all, their arrangement is
  // final — hiding every card means an intentionally empty row, and the
  // fallback must not resurrect what they removed.
  if (store.profile_facts_configured) {
    return (store.profile_facts ?? []).filter((w) => w.visible !== false).slice(0, 3);
  }
  const out: ProfileWidget[] = [];
  if (store.governorate) {
    out.push({ icon: 'map-pin', title: governorateLabel(store.governorate, lang), subtitle: loc('الموقع', 'Location', 'شوێن'), visible: true });
  }
  if ((store.service_areas?.length ?? 0) > 0) {
    out.push({
      icon: 'truck',
      title: loc('شحن إلى', 'Ships to', 'گەیاندن بۆ'),
      subtitle: store.service_areas.slice(0, 2).join('، '),
      visible: true,
    });
  }
  const note = deliveryNote(store);
  if (note) out.push({ icon: 'clock', title: loc('التوصيل', 'Delivery', 'گەیاندن'), subtitle: note, visible: true });
  return out.slice(0, 3);
}

export function governorateLabel(id: string, lang: string): string {
  return GOVERNORATE_LABELS[id]?.[lang === 'ckb' ? 'ckb' : lang === 'en' ? 'en' : 'ar'] ?? id;
}

export function deliveryNote(store: StorefrontStore): string {
  const note = (store.delivery_settings as Record<string, unknown> | undefined)?.note;
  return typeof note === 'string' ? note : '';
}

/** «انضم في أغسطس 2026» — the joined line a profile-only merchant shows where a store shows its @address. */
export function joinedLine(createdAt: string, loc: Loc, lang: string): string {
  if (!createdAt) return loc('تاجر مجتمع', 'Community merchant', 'بازرگانی کۆمەڵگا');
  const when = new Date(createdAt).toLocaleDateString(lang === 'en' ? 'en-US' : 'ar-IQ', { year: 'numeric', month: 'long' });
  return `${loc('انضم في', 'Joined', 'بەشداری کرد لە')} ${when}`;
}

/** «على Levonis منذ …» */
export function sinceLine(createdAt: string, loc: Loc, lang: string): string {
  if (!createdAt) return '';
  const when = new Date(createdAt).toLocaleDateString(lang === 'en' ? 'en-US' : 'ar-IQ', { year: 'numeric', month: 'long' });
  return `${loc('على Levonis منذ', 'On Levonis since', 'لەسەر LEVONIS لە')} ${when}`;
}
