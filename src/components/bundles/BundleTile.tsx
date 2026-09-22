import React from 'react';
import { Link } from 'react-router-dom';
import { Lock, Package } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { type ApiProduct } from '../../lib/api';
import SafeImage from '../ui/SafeImage';
import CardPrice from '../CardPrice';
import OfferBadge from '../ui/OfferBadge';
import Countdown from '../ui/Countdown';
import BundleSavingLine from './BundleSavingLine';
import { tierLabel } from '../subscription/tierMeta';
import { useMoney } from '../../CurrencyContext';

/**
 * THE BUNDLE CARD, AND THE CARD-STATE VOCABULARY (docs/BUNDLES_MYSTERY.md §13).
 *
 * It lives here rather than inside `src/pages/Bundles.tsx` for a concrete
 * reason: the home shelf renders the same card, and `Bundles` is a LAZY route.
 * Importing the card from the page would drag the whole bundles page — its
 * filters, its search, its trilingual copy — into the eager home chunk and
 * quietly undo the split `tests/bundleBudget.test.ts` measures.
 *
 * EVERY STRING AND EVERY NUMBER HERE IS THE SERVER'S. The eight card states of
 * §13.3 are produced by `bundleAvailability` and arrive as one word; this file
 * maps that word to a chip and nothing more. There is no threshold, no
 * "low stock" arithmetic and no membership comparison in the browser — a
 * second opinion here is exactly what would let the card, the cart and the
 * door disagree.
 */

export interface BundleMainItem {
  product_id: string;
  slug: string;
  name: string;
  image: string;
  qty: number;
}

/**
 * The card as the server sends it. Every composition field is OPTIONAL because
 * a LOCKED card genuinely does not carry them (§9): the allow-list is the
 * payload, so "missing" means absent, never an assumed zero. A component that
 * reads `b.composition!.saving_percent` would crash on the one payload this
 * design exists to protect.
 */
export interface BundleCard extends Partial<ApiProduct> {
  id: string;
  product_slug: string;
  name: string;
  name_ar?: string;
  name_ku?: string;
  image: string;
  locked: boolean;
  availability_state: string;
  offer: { offer_id: string | null; required_tiers: string[]; starts_at: string | null; ends_at: string | null };
  composition?: {
    kind: string;
    component_total_iqd: number;
    saving_percent: number;
    availability_state: string;
    member_exclusive: boolean;
    shipping_type: string;
    modes: string[];
    main_items: BundleMainItem[];
  };
}

/** The eight states §13.3 requires, and nothing else. A state the server sends
 *  that is not in this table renders NO chip rather than a guessed one. */
export const STATE_LABELS: Record<string, { ar: string; en: string; ckb: string; tone: string }> = {
  in_stock: { ar: 'متوفر', en: 'In stock', ckb: 'بەردەستە', tone: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  low: { ar: 'الكمية محدودة', en: 'Only a few left', ckb: 'کەمە', tone: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  sold_out: { ar: 'نفدت الكمية', en: 'Sold out', ckb: 'تەواو بوو', tone: 'bg-red-500/15 text-red-300 border-red-500/30' },
  upcoming: { ar: 'قريباً', en: 'Coming soon', ckb: 'بەم زووانە', tone: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
  ending_soon: { ar: 'ينتهي قريباً', en: 'Ending soon', ckb: 'بەزوویی کۆتایی دێت', tone: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  ended: { ar: 'انتهى العرض', en: 'Offer ended', ckb: 'کۆتایی هات', tone: 'bg-zinc-700/40 text-zinc-400 border-zinc-700' },
  preorder: { ar: 'طلب مسبق', en: 'Pre-order', ckb: 'پێش-داواکاری', tone: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
  locked: { ar: 'حصري للمشتركين', en: 'Members only', ckb: 'تەنها ئەندامان', tone: 'bg-gold/15 text-gold border-gold/30' },
  member_exclusive: { ar: 'متاح لك', en: 'Yours', ckb: 'بۆ تۆ', tone: 'bg-gold/15 text-gold border-gold/30' },
  unconfigured: { ar: 'غير مكتمل', en: 'Not ready', ckb: 'ئامادە نییە', tone: 'bg-zinc-700/40 text-zinc-400 border-zinc-700' },
};

export function StateChip({ state, className = '' }: { state: string; className?: string }) {
  const { lang } = useLanguage();
  const meta = STATE_LABELS[state];
  if (!meta) return null;
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-bold ${meta.tone} ${className}`}>
      {meta[lang]}
    </span>
  );
}

/**
 * One card. The whole tile is a link — a LOCKED one included, because the
 * detail page renders the same honest lock and the subscribe path, and sending
 * a member-curious visitor to a dead card is how a paid tier fails to sell.
 */
export default function BundleTile({
  b,
  onRevalidate,
  className = '',
}: {
  b: BundleCard;
  /** Fired when a countdown on this card reaches zero, so the page can ask the
   *  server what the state is now instead of showing a negative clock. */
  onRevalidate?: () => void;
  className?: string;
}) {
  const { money } = useMoney();
  const { lang, loc } = useLanguage();
  const gated = b.offer.required_tiers.length > 0;
  const membersOnly = { ar: 'حصري للمشتركين', en: 'Members only', ckb: 'تەنها بۆ ئەندامان' }[lang];

  return (
    <Link
      to={`/bundles/${b.product_slug}`}
      className={`bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden flex flex-col group hover:border-olive/50 transition-colors min-w-0 ${className}`}
    >
      <div className="relative aspect-square overflow-hidden bg-black">
        <SafeImage
          src={b.image}
          alt={b.name}
          aspect="auto"
          className="w-full h-full group-hover:scale-105 transition-transform duration-500 motion-reduce:transition-none"
        />
        <span className="absolute top-2 start-2">
          <StateChip state={b.availability_state} />
        </span>
        {b.composition && b.composition.saving_percent > 0 && (
          <span className="absolute top-2 end-2">
            <OfferBadge>
              {loc(
                `وفّر ${b.composition.saving_percent}٪`,
                `Save ${b.composition.saving_percent}%`,
                `${b.composition.saving_percent}٪ پاشەکەوت`
              )}
            </OfferBadge>
          </span>
        )}
        {b.locked && (
          <span className="absolute inset-0 bg-black/55 grid place-items-center">
            <Lock aria-hidden className="w-6 h-6 text-gold" />
          </span>
        )}
      </div>

      <div className="p-3 flex flex-col flex-1 min-w-0">
        {/* §13.3: the bundle's own title is owner-authored ar/en/ckb, but it is
            rendered `dir="ltr"` like every product name so a latin name inside
            an Arabic paragraph is not bidi-reordered. */}
        <h3 dir="ltr" className="text-white font-medium text-[13px] leading-snug line-clamp-2 min-h-[2.2rem] text-start">
          {b.name}
        </h3>

        {b.composition && b.composition.main_items.length > 0 && (
          <div className="flex items-center gap-1.5 mt-1.5">
            {b.composition.main_items.map((m) => (
              <span
                key={m.product_id}
                className="relative w-8 h-8 rounded-lg overflow-hidden bg-zinc-950 border border-zinc-800 shrink-0 grid place-items-center"
              >
                {m.image ? (
                  <SafeImage src={m.image} alt={m.name} aspect="auto" className="w-full h-full" />
                ) : (
                  <Package aria-hidden className="w-3.5 h-3.5 text-zinc-700" />
                )}
                {m.qty > 1 && (
                  <span className="absolute bottom-0 end-0 bg-zinc-950/90 text-zinc-200 text-[8px] font-bold px-1 rounded-tl rtl:rounded-tl-none rtl:rounded-tr">
                    ×{m.qty}
                  </span>
                )}
              </span>
            ))}
          </div>
        )}

        <div className="mt-auto pt-2 space-y-1">
          {b.locked ? (
            <div className="min-w-0">
              {/* The ONLY price a locked card may carry, and only when the
                  offer allows a preview: never a member rung nobody sold. */}
              {typeof b.display_regular_iqd === 'number' && (
                <span className="text-zinc-400 font-bold text-[13px] tabular-nums">{money(b.display_regular_iqd)}</span>
              )}
              <div className="text-[10px] text-gold font-bold mt-0.5">
                {membersOnly}
                {gated ? ` · ${b.offer.required_tiers.map(tierLabel).join(' / ')}` : ''}
              </div>
            </div>
          ) : (
            <>
              <CardPrice p={b as ApiProduct} compact />
              {b.composition && (
                <BundleSavingLine
                  componentTotalIqd={b.composition.component_total_iqd}
                  savingPercent={b.composition.saving_percent}
                />
              )}
            </>
          )}
          {b.availability_state === 'upcoming' && (
            <Countdown target={b.offer.starts_at} kind="opens" onZero={onRevalidate} />
          )}
          {b.availability_state !== 'upcoming' && b.offer.ends_at && (
            <Countdown target={b.offer.ends_at} kind="ends" onZero={onRevalidate} />
          )}
        </div>
      </div>
    </Link>
  );
}
