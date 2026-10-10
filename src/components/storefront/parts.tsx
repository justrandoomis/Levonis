/**
 * Pieces several blocks share: the product card and grid, the price line, the
 * empty state, a titled card, and the ONE component that turns a typed link
 * into an anchor. Presentation only — anything that acts comes from the
 * runtime (runtime.tsx).
 */
import { productName } from '../../lib/productText';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Heart, Loader2, Play, ShoppingBag } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { GOVERNORATE_LABELS } from '../../lib/governorates';
import type { ProfileWidget } from '../../lib/merchant';
import { safeExternalUrl, type LinkTarget } from '../../../packages/storeLayout/src/refs';
import { pickText, type LocalizedText } from '../../../packages/storeLayout/src/text';
import type { BlockData } from '../../../packages/storeLayout/src/data';
import { useSavedIds, useStorefrontRuntime } from './runtime';
import { useStoreTheme } from './StoreTheme';
import { gridClasses } from './theme';
import { storefrontStrings } from './strings';
import type { StorefrontStore } from './types';

export type Loc = (ar: string, en: string, ckb?: string) => string;

/** The fields a product card reads — the public card shape and the full product both carry them. */
export interface CardProduct {
  id: string;
  slug: string;
  name: string;
  /** The merchant's Arabic name, when they wrote one (lib/productText.ts). */
  name_ar?: string | null;
  images: string[];
  /** The second picture, shown while the card is hovered or focused (storefront L10). */
  image_2?: string | null;
  /** The product carries a video: the card draws a ▶ mark, never the video. */
  has_video?: boolean;
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
const digits = (n: number) => Number(n).toLocaleString('en-US');
export function DinarPrice({ amount, className = '' }: { amount: number; className?: string }) {
  return (
    <span className={`inline-flex flex-row items-baseline ${className}`} dir="ltr">
      <span>ع.</span>
      <span>{digits(amount)}</span>
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

/**
 * The server's sized variants of a `/files/` still picture (`?w=`,
 * worker/lib/imageConvert.ts IMAGE_VARIANT_WIDTHS) — the same five widths
 * `ui/SafeImage` names, repeated here rather than imported because a store
 * visit must not carry that component's icons and strings for one line
 * (tests/storefrontBlocks.test.ts allow-list; tests/imageVariants.test.ts
 * pins the two lists equal). Anything that is not such a picture — an
 * external URL, a GIF, a URL with its own query — gets no srcset.
 */
const VARIANT_WIDTHS = [160, 320, 480, 640, 1080] as const;
// A store's pictures are the relative `/files/<key>` the upload answered with.
function variantSrcSet(src: string): string | undefined {
  return /^\/files\/[^?#]+\.(?:webp|jpe?g|png)$/i.test(src) ? VARIANT_WIDTHS.map((w) => `${src}?w=${w} ${w}w`).join(', ') : undefined;
}

export function ProductCard({ product, storeOpen, legacyLink = false }: { product: CardProduct; storeOpen: boolean; legacyLink?: boolean }) {
  const { loc, lang } = useLanguage();
  const s = storefrontStrings(lang);
  const name = productName(product, lang);
  const rt = useStorefrontRuntime();
  const href = legacyLink ? rt.legacyProductHref(product.slug) : rt.productHref(product.slug);
  const first = product.images[0];
  // THE SECOND FRAME (L10): the server's `image_2`, or the gallery's second
  // picture when a whole product arrived. A `src` swap while the pointer is
  // over the card or it holds focus — state, not motion: no transform, and
  // reduced motion changes nothing. Touch never hovers, so a phone shows the
  // first picture as it always did.
  const second = product.image_2 ?? product.images[1] ?? null;
  const [peek, setPeek] = useState(false);
  const image = peek && second ? second : first;
  const discounted = !!product.original_price_iqd && product.original_price_iqd > product.price_iqd;
  const sellable = storeOpen && product.in_stock !== false;
  const saved = useSavedIds().has(product.id);

  return (
    <Link
      to={href}
      className="sf-tile press-scale"
      onPointerEnter={() => setPeek(true)}
      onPointerLeave={() => setPeek(false)}
      onFocus={() => setPeek(true)}
      onBlur={() => setPeek(false)}
      data-card-frame={peek && second ? '2' : '1'}
    >
      <div className="sf-media sf-well overflow-hidden relative">
        {image ? (
          // A store tile is 2 or 3 across on a phone and up to 5 across on a
          // wide theme (theme.ts gridClasses); the srcset lets the browser
          // take the 320/640 px cut instead of the stored original.
          <img
            src={image}
            srcSet={variantSrcSet(image)}
            sizes="(min-width: 1024px) 20vw, (min-width: 640px) 25vw, 50vw"
            alt={name}
            className="w-full h-full object-cover"
            loading="lazy"
          />
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
          // A 44px target in the corner; the 22px disc is drawn where it always was (W6:
          // a ::after slop is clipped by the image frame, so the button itself is the target).
          className="group absolute top-0 left-0 w-11 h-11 p-1.5 flex items-start justify-start focus-visible:outline-none"
          aria-label={saved ? loc('إزالة من المحفوظات', 'Remove from saved', 'لابردن') : loc('حفظ المنتج', 'Save product', 'پاشەکەوتکردن')}
          aria-pressed={saved}
        >
          <span className="w-[22px] h-[22px] rounded-full bg-black/60 flex items-center justify-center group-focus-visible:ring-2 group-focus-visible:ring-focus">
            <Heart className={`w-3 h-3 ${saved ? 'text-rose-500 fill-rose-500' : 'text-white'}`} strokeWidth={2} aria-hidden="true" />
          </span>
        </button>
        {discounted && (
          <span className="absolute top-1.5 end-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-crimson text-snow" dir="ltr">
            −{Math.round((1 - product.price_iqd / (product.original_price_iqd as number)) * 100)}%
          </span>
        )}
        {/* ▶ at the picture's bottom end when the product carries a video (L10):
            a mark, never a player — video plays on the product page only. */}
        {product.has_video && (
          <span
            className="absolute bottom-1 end-1 w-[22px] h-[22px] rounded-full bg-black/60 flex items-center justify-center"
            role="img"
            aria-label={s.card.hasVideo}
            data-card-video
          >
            <Play className="w-3 h-3 text-snow" strokeWidth={2} aria-hidden="true" />
          </span>
        )}
        {!sellable && (
          <span className="sf-tile-flag absolute bottom-1 start-1 text-[8.5px] font-bold px-1.5 py-0.5 rounded-full bg-onyx/80 text-snow">
            {loc('غير متوفر', 'Unavailable', 'بەردەست نییە')}
          </span>
        )}
      </div>
      <div className="sf-tile-body">
        <p className="text-zinc-300 text-[12.5px] truncate leading-snug" dir="auto">
          {name}
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
  if (link.kind === 'external') {
    const href = safeExternalUrl(link.url);
    return href ? (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow" className={className}>
        {children}
      </a>
    ) : (
      <span className={className}>{children}</span>
    );
  }
  const picked = link.kind === 'product' ? data.picked.find((x) => x.id === link.id) : null;
  const to =
    link.kind === 'route' ? rt.routeHref(link.route) : link.kind === 'collection' ? rt.collectionHref(link.id) : picked ? rt.productHref(picked.slug) : null;
  return to ? (
    <Link to={to} className={className}>
      {children}
    </Link>
  ) : (
    <span className={className}>{children}</span>
  );
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
  const out: Omit<ProfileWidget, 'visible'>[] = [];
  if (store.governorate) {
    out.push({ icon: 'map-pin', title: governorateLabel(store.governorate, lang), subtitle: loc('الموقع', 'Location', 'شوێن') });
  }
  // «التوصيل إلى <محافظتك>: <الأجرة>» — the signed-in visitor's own
  // default-address governorate, answered by the server from this store's
  // delivery rules (W2-A). A preview: the checkout prices again.
  const toYou = deliveryToYou(store, loc, lang);
  if (toYou) out.push({ icon: 'truck', title: toYou.title, subtitle: toYou.subtitle });
  if ((store.service_areas?.length ?? 0) > 0) {
    out.push({ icon: 'truck', title: loc('شحن إلى', 'Ships to', 'گەیاندن بۆ'), subtitle: store.service_areas.slice(0, 2).join('، ') });
  }
  const note = deliveryNote(store);
  if (note) out.push({ icon: 'clock', title: loc('التوصيل', 'Delivery', 'گەیاندن'), subtitle: note });
  return out.slice(0, 3).map((w) => ({ ...w, visible: true }));
}

/**
 * A day's times as the page shows them: «09:00 – 18:00», «مغلق» for a day the
 * merchant marked closed, or nothing at all for a day written as free text
 * (a pre-structured row carries its times inside the words). Both empty used
 * to be drawn as « – », a stray dash that said nothing.
 */
export function HoursTime({ hours, loc, className = '' }: { hours: { open?: string; close?: string; closed?: boolean }; loc: Loc; className?: string }) {
  if (hours.closed) {
    // OWNER: Sorani to be written by hand.
    return <span className={`text-zinc-400 ${className}`}>{loc('مغلق', 'Closed')}</span>;
  }
  const open = (hours.open ?? '').trim();
  const close = (hours.close ?? '').trim();
  if (!open && !close) return null;
  return (
    <span className={`text-zinc-300 ${className}`} dir="ltr">
      {open && close ? `${open} – ${close}` : open || close}
    </span>
  );
}

export function governorateLabel(id: string, lang: string): string {
  return GOVERNORATE_LABELS[id]?.[lang === 'ckb' || lang === 'en' ? lang : 'ar'] ?? id;
}

/**
 * The visitor's own delivery line (W2-A), or null for a guest, an address
 * without a governorate, or a server that sends none: «التوصيل إلى بغداد» over
 * «3,000 د.ع» / «مجاني» / «لا يوصل إليها».
 */
export function deliveryToYou(store: StorefrontStore, loc: Loc, lang: string): { title: string; subtitle: string; available: boolean } | null {
  const d = store.delivery_to_you;
  if (!d || !d.governorate) return null;
  const place = governorateLabel(d.governorate, lang);
  // OWNER: Sorani to be written by hand.
  const title = loc(`التوصيل إلى ${place}`, `Delivery to ${place}`);
  const subtitle = !d.available
    ? loc('لا يوصل إليها', 'Not delivered')
    : d.free
      ? loc('مجاني', 'Free', 'بەخۆڕایی')
      : `${digits(d.fee_iqd)} ${lang === 'en' ? 'IQD' : 'د.ع'}`;
  return { title, subtitle, available: !!d.available };
}

export function deliveryNote(store: StorefrontStore): string {
  const note = (store.delivery_settings as Record<string, unknown> | undefined)?.note;
  return typeof note === 'string' ? note : '';
}

/** «أغسطس 2026» — a month and a year in the reader's calendar words. */
const monthYear = (iso: string, lang: string) =>
  new Date(iso).toLocaleDateString(lang === 'en' ? 'en-US' : 'ar-IQ', { year: 'numeric', month: 'long' });

/** «انضم في أغسطس 2026» — the joined line a profile-only merchant shows where a store shows its @address. */
export function joinedLine(createdAt: string, loc: Loc, lang: string): string {
  if (!createdAt) return loc('تاجر مجتمع', 'Community merchant', 'بازرگانی کۆمەڵگا');
  return `${loc('انضم في', 'Joined', 'بەشداری کرد لە')} ${monthYear(createdAt, lang)}`;
}

/** «على Levonis منذ …» */
export function sinceLine(createdAt: string, loc: Loc, lang: string): string {
  if (!createdAt) return '';
  return `${loc('على Levonis منذ', 'On Levonis since', 'لەسەر LEVONIS لە')} ${monthYear(createdAt, lang)}`;
}
