import React from 'react';
import { Sparkles, Star } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { type ApiProduct } from '../lib/api';
import { pairedUsd, splitMoney, useMoney } from '../CurrencyContext';
import { memberLine } from '../lib/productCard';
import { ESTIMATE_SHORT, ESTIMATE_TEXT, isEstimated, isUnpriced, UNPRICED_TEXT } from '../lib/priceStatus';

/**
 * The ONE price block every product card renders (home rails, /products grid,
 * bundles). Entirely server-driven: `display_price_iqd` is the CHEAPEST
 * tier-resolved price across the base row and every active option/colour,
 * already resolved at the VIEWER'S server-side tier — the client never does
 * tier math, so a spoofed local state can't change a shown price.
 *
 * The owner's display rules:
 *  - non-member: bold regular price, and under it — faint — the PRIME and PRO
 *    prices when they exist;
 *  - PLUS member on a BUNDLE or MYSTERY offer: bold PLUS price. That rung is
 *    offer-scoped (docs/BUNDLES_MYSTERY.md §4.4) and no ordinary product emits
 *    it — but without this branch a PLUS member is shown the regular price on
 *    the grid, the home shelf and search, and is then charged the PLUS price in
 *    the cart and at the door;
 *  - PRIME member: bold PRIME price (strikethrough regular beside it), faint
 *    PRO price under it;
 *  - PRO member: the PRO price, in PRO's red with its mark, and the regular
 *    price small and struck beside it — the saving read at a glance.
 * Which branch applies is read from display_applied_tier — the server's
 * verdict, not a client guess. `display_from` marks genuinely differing
 * variant prices, so «يبدأ من» is honest, never decorative.
 *
 * «سعر تقديري» (docs/SMART_PRICING.md §5.3): a priced card whose price is an
 * estimated pre-order price (`price_estimate: true`, src/lib/priceStatus.ts
 * `isEstimated`) says so — a muted line under the price on a regular row, the
 * second line of a compact row. The figure itself is unchanged.
 */
export default function CardPrice({
  p,
  compact = false,
  density = 'regular',
  saving = null,
  occasion = null,
}: {
  p: ApiProduct;
  /** Smaller type for list rows (search suggestions, bundle tiles). */
  compact?: boolean;
  /** 'compact' is the compact product card's price block (see CompactPrice). */
  density?: 'regular' | 'compact';
  /**
   * A sale with an occasion (DECISIONS row 294): its «−N٪» and the sentence a screen reader hears, printed
   * beside the struck price — the photograph carries the occasion's ribbon alone (ProductCard).
   */
  saving?: CardSaving | null;
  /** That sale's occasion, after its «−N٪»: its sentence — and on a list row its name (ProductCard `OccasionWords`). */
  occasion?: React.ReactNode;
}) {
  // A priced card always carries its display price; one that does not is never drawn as 0.
  if (isUnpriced(p) || (p.display_price_iqd ?? p.price_iqd) == null) return <UnpricedPrice rows={density === 'compact'} />;
  if (density === 'compact') return <CompactPrice p={p} saving={saving} occasion={occasion} />;
  return <RegularPrice p={p} compact={compact} saving={saving} occasion={occasion} />;
}

export interface CardSaving {
  text: string;
  sr: string;
}

/** «−17٪» beside a struck price, in the sale's green (the product page's saving pill), with its sentence. */
function SavingText({ saving }: { saving: CardSaving }) {
  return (
    <>
      <bdi dir="ltr" aria-hidden data-card-saving className="shrink-0 font-bold text-success tabular-nums">
        {saving.text}
      </bdi>
      <span className="sr-only">{saving.sr}</span>
    </>
  );
}

/**
 * CATALOG-ONLY (DECISIONS rows 239-240): the label in the muted token, and no
 * number, no unit, no member line — a price is never shown as 0. The compact
 * card keeps its two fixed rows (20 + 1 + 15 px = h-9), so a grid that mixes
 * priced and unpriced cards keeps one card height.
 */
function UnpricedPrice({ rows }: { rows: boolean }) {
  const { loc } = useLanguage();
  return (
    <p data-price-status="unpriced" className={`text-[12px] font-bold leading-4 text-text-muted${rows ? ' line-clamp-2 h-9' : ''}`}>
      {loc(UNPRICED_TEXT.ar, UNPRICED_TEXT.en, UNPRICED_TEXT.ckb)}
    </p>
  );
}

function RegularPrice({ p, compact, saving, occasion }: { p: ApiProduct; compact: boolean; saving: CardSaving | null; occasion: React.ReactNode }) {
  const { money } = useMoney();
  const { loc } = useLanguage();

  // Non-null: CardPrice drew the unpriced label for a missing figure.
  const main = (p.display_price_iqd ?? p.price_iqd) as number;
  const regular = (p.display_regular_iqd ?? p.price_iqd) as number;
  const appliedTier = p.display_applied_tier ?? 'regular';
  // A LIVE OFFER strikes the published price it replaced (docs/ux/PRODUCT-DISCOUNT.md §8.2, F1) — the
  // server's number, never `regular`, which already IS the offer price; a member saving strikes as before.
  const struck = typeof p.display_offer_before_iqd === 'number' ? p.display_offer_before_iqd : main < regular ? regular : null;
  // The shop's dollar prices (DECISIONS row 248): the struck pair in dollars only when both exist.
  const usd = pairedUsd(
    p.display_price_usd_cents,
    typeof p.display_offer_before_iqd === 'number' ? p.display_offer_before_usd_cents : p.display_regular_usd_cents,
    struck !== null
  );
  const from = !!p.display_from;

  const teasers: Array<{ label: string; price: number }> = [];
  // A PLUS viewer is already on the offer-scoped PLUS rung, so PRIME and PRO
  // are teased only when they are genuinely cheaper than what they are paying
  // — the same rule the regular branch follows, not a second one.
  if (appliedTier === 'regular' || appliedTier === 'plus') {
    if (typeof p.display_prime_iqd === 'number' && p.display_prime_iqd < main)
      teasers.push({ label: 'PRIME', price: p.display_prime_iqd });
    if (typeof p.display_pro_iqd === 'number' && p.display_pro_iqd < main)
      teasers.push({ label: 'PRO', price: p.display_pro_iqd });
  } else if (appliedTier === 'prime') {
    if (typeof p.display_pro_iqd === 'number' && p.display_pro_iqd < main)
      teasers.push({ label: 'PRO', price: p.display_pro_iqd });
  }
  // A PRO member sees the PRO price alone — nothing to tease.

  const memberPrice = appliedTier !== 'regular';
  /** PRO is drawn in PRO's own red (tierMeta), every other member rung in gold. */
  const pro = appliedTier === 'pro';

  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-1.5 min-w-0 flex-wrap">
        {from && (
          <span className="text-zinc-500 text-[10px] shrink-0">{loc('يبدأ من', 'from', 'لە')}</span>
        )}
        <span
          className={`font-bold ${compact ? 'text-[13px]' : 'text-[15px]'} ${
            pro
              ? 'text-coral font-extrabold inline-flex items-center gap-1'
              : memberPrice
                ? 'text-gold font-extrabold inline-flex items-center gap-1'
                : 'text-white'
          }`}
          data-pro-price={pro || undefined}
        >
          {pro ? (
            <Sparkles aria-hidden className="w-3 h-3" />
          ) : (
            memberPrice && <Star aria-hidden className="w-3 h-3 fill-gold" />
          )}
          {money(main, usd.price)}
        </span>
        {struck !== null && (
          <span className="text-zinc-500/80 text-[10.5px] line-through truncate">{money(struck, usd.struck)}</span>
        )}
        {struck !== null && saving ? (
          <span className="text-[10.5px]">
            <SavingText saving={saving} />
          </span>
        ) : null}
        {struck !== null ? occasion : null}
      </div>
      {/* An estimated pre-order price says so, muted, under the figure (§5.3). */}
      {isEstimated(p) ? (
        <p data-price-estimate className="mt-0.5 truncate text-[10px] font-semibold text-text-muted">
          {loc(ESTIMATE_TEXT.ar, ESTIMATE_TEXT.en, ESTIMATE_TEXT.ckb)}
        </p>
      ) : null}
      {teasers.map((t) => (
        <div key={t.label} className="flex items-center gap-1 mt-0.5 min-w-0">
          <Star aria-hidden className="w-2.5 h-2.5 text-gold/70 shrink-0" />
          <span className="text-zinc-500 font-medium text-[10px] truncate">
            {t.label} {money(t.price)} ({loc('للمشتركين', 'members', 'بۆ ئەندامان')})
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * THE COMPACT CARD'S PRICE (docs/ux/CATALOG_DISCOVERY.md §4.1) — two fixed
 * rows, so a grid of cards keeps one height whatever the viewer's tier:
 *
 *   row 1   «يبدأ من» 10 muted · the amount 15/20 800 tabular · «د.ع» 10.5
 *   row 2   A LIVE OFFER'S struck before price first (docs/ux/PRODUCT-DISCOUNT.md
 *           §8.2: `display_offer_before_iqd`; the member line yields to it) —
 *           and, for a sale with an occasion, its «−N٪» beside it in the
 *           sale's green (`saving`, DECISIONS row 294: the photo wears the
 *           occasion's ribbon alone), then the occasion (`occasion`: its
 *           sentence; a list row, whose photo wears the wordless flag,
 *           its name too — «· بلاك فرايدي», truncated before the price is).
 *           Else, on an ESTIMATED price (docs/SMART_PRICING.md §5.3), «تقديري»
 *           — the member line yields to it too. Else ONE member line — the
 *           cheapest rung below what this viewer pays (src/lib/productCard.ts
 *           `memberLine`): ✧ 674,100 لأعضاء PRO.
 *           When there is no cheaper rung but the viewer's own price is below
 *           the regular one (a member), the struck regular price takes the row
 *           instead. Otherwise the row stays empty.
 *
 * The main amount keeps CardPrice's colour rule: PRO's red for a PRO viewer,
 * gold for PRIME and PLUS, the foreground for everyone else. Same fields,
 * same server verdict — nothing here computes a price.
 */
function CompactPrice({ p, saving, occasion }: { p: ApiProduct; saving: CardSaving | null; occasion: React.ReactNode }) {
  const { money } = useMoney();
  const { loc } = useLanguage();

  const main = (p.display_price_iqd ?? p.price_iqd) as number;
  const regular = (p.display_regular_iqd ?? p.price_iqd) as number;
  const applied = p.display_applied_tier ?? 'regular';
  const offerBefore = typeof p.display_offer_before_iqd === 'number' ? p.display_offer_before_iqd : null;
  // «تقديري» takes the row after a live offer's struck price and before the member line (§5.3).
  const estimate = offerBefore === null && isEstimated(p);
  const line = offerBefore === null && !estimate ? memberLine(p) : null;
  const struck = offerBefore ?? (!estimate && !line && main < regular ? regular : null);
  // The shop's dollar prices (DECISIONS row 248): the struck pair in dollars only when both exist.
  const usd = pairedUsd(p.display_price_usd_cents, offerBefore !== null ? p.display_offer_before_usd_cents : p.display_regular_usd_cents, struck !== null);
  const [amount, unit] = splitMoney(money(main, usd.price));
  const amountTone =
    applied === 'pro' ? 'text-coral' : applied === 'regular' ? 'text-text-primary' : 'text-gold';

  return (
    <div data-card-price="compact" className="min-w-0">
      <div className="flex h-5 min-w-0 items-baseline gap-1 overflow-hidden whitespace-nowrap">
        {p.display_from ? (
          <span className="shrink-0 text-[10px] font-semibold text-text-muted">{loc('يبدأ من', 'from', 'لە')}</span>
        ) : null}
        <bdi
          dir="ltr"
          data-pro-price={applied === 'pro' || undefined}
          className={`text-[15px] font-extrabold leading-5 tracking-[-0.01em] tabular-nums ${amountTone}`}
        >
          {amount}
        </bdi>
        {unit ? <span className="shrink-0 text-[10.5px] font-bold text-text-secondary">{unit}</span> : null}
      </div>
      <div className="mt-px flex h-[15px] min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-[10.5px] leading-[15px] text-text-secondary">
        {line ? (
          <>
            {line.tier === 'PRO' ? (
              <Sparkles aria-hidden className="size-2.5 shrink-0 text-coral" />
            ) : (
              <Star aria-hidden className="size-2.5 shrink-0 fill-current text-gold" />
            )}
            <bdi dir="ltr" className="font-semibold tabular-nums">{splitMoney(money(line.price))[0]}</bdi>
            {/* «لأعضاء» before a tier name; its own Sorani (DECISIONS row 183, F6). */}
            <span className="truncate">{loc('لأعضاء', 'for', 'بۆ ئەندامانی')}</span>
            <b className={`font-extrabold tracking-[0.02em] ${line.tier === 'PRO' ? 'text-coral' : 'text-gold'}`}>{line.tier}</b>
          </>
        ) : struck !== null ? (
          <>
            {/* «بدل» — instead of; its own Sorani (F6). */}
            <span className="sr-only">{loc('بدل', 'instead of', 'لە جیاتی')} </span>
            <bdi dir="ltr" className="text-text-muted line-through tabular-nums">{splitMoney(money(struck, usd.struck))[0]}</bdi>
            {/* An occasion's «−N٪» (DECISIONS row 294): beside the price it was taken from, not on the photo —
                then the occasion itself (its sentence; on a list row, its name). */}
            {offerBefore !== null && saving ? <SavingText saving={saving} /> : null}
            {offerBefore !== null ? occasion : null}
          </>
        ) : estimate ? (
          <span data-price-estimate className="truncate font-semibold text-text-muted">
            {loc(ESTIMATE_SHORT.ar, ESTIMATE_SHORT.en, ESTIMATE_SHORT.ckb)}
          </span>
        ) : null}
      </div>
    </div>
  );
}
