/**
 * ONE CARD PER GIFT, ONE BODY PER STATUS (docs/GIFTS_QUICK_BUY.md §1.2, §1.3).
 *
 * The status is the SERVER's (`giftStatusOf`, worker/lib/gifts/model.ts): this
 * file never combines flags to decide where a gift is, it draws the status it
 * was handed, and each status offers exactly its own action:
 *
 *   GRANTED          the level's alternatives → «تأكيد الاختيار»
 *   READY_TO_REDEEM  the chosen product → «استرداد الهدية» (and, for a level
 *                    gift, «تغيير الاختيار»)
 *   REDEEMED         «تم استرداد الهدية ✓» → «أضف إلى السلة»
 *   ADDED_TO_ORDER   «في السلة» → «الذهاب إلى السلة»
 *   ORDERED          «تم طلب هذه الهدية» → the order
 *   FULFILLED        «تم التسليم»
 *   CANCELLED        nothing to do
 *
 * After an action the page re-reads the server's answer rather than guessing
 * the next status here. Nothing in a card is a price or a permission: the
 * value shown is the server's, the price is always 0, and every action is
 * re-checked by the server.
 */
import React, { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Gift, PackageCheck, ShoppingCart, Truck, XCircle } from 'lucide-react';
import SafeImage from '../../ui/SafeImage';
import { Button } from '../../ui/Button';
import { StatusChip } from '../../ui/Badge';
import { formatDate } from '../../orders/format';
import { giftText, type GiftLang, type GiftStringKey } from './giftStrings';

// ------------------------------------------------------------------ the view

/** Mirrors `GiftStatus` in worker/lib/gifts/model.ts. */
export type GiftStatus =
  | 'GRANTED'
  | 'READY_TO_REDEEM'
  | 'REDEEMED'
  | 'ADDED_TO_ORDER'
  | 'ORDERED'
  | 'FULFILLED'
  | 'CANCELLED'
  | 'LEGACY';

export interface Tri {
  ar: string;
  en: string;
  ckb: string;
}

/** Mirrors `GiftItemView`. */
export interface GiftItemView {
  item_id: string | null;
  product_id: string;
  slug: string;
  name: Tri;
  image: string;
  variant: Tri;
  color: (Tri & { hex: string }) | null;
  qty: number;
  sale_type: 'direct_sale' | 'pre_order';
  transport_method: string;
  value_iqd: number;
  lead_time_text: string;
  lead_time_min_days?: number | null;
  lead_time_max_days?: number | null;
  available: boolean | null;
  reason: string | null;
}

/** Mirrors `GiftView` — never the internal note, the granting admin or the cancel reason. */
export interface GiftView {
  id: string;
  status: GiftStatus;
  mode: 'legacy' | 'level' | 'product';
  reason: 'legacy' | 'review' | 'reward' | 'compensation' | 'admin_gift';
  level: { n: number; name: Tri; description: Tri; active: boolean } | null;
  choices: GiftItemView[] | null;
  chosen: GiftItemView | null;
  can_change_choice: boolean;
  cart_item_id: string | null;
  order: { id: string; status: string; stage: string | null } | null;
  granted_at: string;
  chosen_at: string | null;
  redeemed_at: string | null;
  ordered_at: string | null;
  fulfilled_at: string | null;
  cancelled_at: string | null;
  legacy: unknown;
}

// ------------------------------------------------------------- pure helpers

export const STATUS_LABEL: Record<GiftStatus, GiftStringKey> = {
  GRANTED: 'stateGranted',
  READY_TO_REDEEM: 'stateReady',
  REDEEMED: 'stateRedeemed',
  ADDED_TO_ORDER: 'stateInCart',
  ORDERED: 'stateOrdered',
  FULFILLED: 'stateFulfilled',
  CANCELLED: 'stateCancelled',
  LEGACY: 'stateLegacy',
};

/** The statuses that ask the customer to do something now — what «هداياي» counts on the orders page. */
export const ACTIONABLE_GIFT_STATUSES: ReadonlySet<GiftStatus> = new Set(['GRANTED', 'READY_TO_REDEEM', 'REDEEMED']);

/** Reading order: what needs the customer first, history last. */
const STATUS_ORDER: Record<GiftStatus, number> = {
  GRANTED: 0,
  READY_TO_REDEEM: 1,
  REDEEMED: 2,
  ADDED_TO_ORDER: 3,
  ORDERED: 4,
  LEGACY: 5,
  FULFILLED: 6,
  CANCELLED: 7,
};

/** A stable sort by `STATUS_ORDER`; the server's order (newest first) is kept inside one status. */
export function sortGifts<T extends { status: GiftStatus }>(gifts: readonly T[]): T[] {
  return gifts
    .map((g, i) => ({ g, i }))
    .sort((a, b) => (STATUS_ORDER[a.g.status] ?? 99) - (STATUS_ORDER[b.g.status] ?? 99) || a.i - b.i)
    .map((x) => x.g);
}

/** A three-language label in the reader's language, falling back to Arabic. */
export const pick = (lang: GiftLang, t: Tri | null | undefined): string => (t ? (t[lang] || t.ar || t.en || '').trim() : '');

/** The product's own name: the store names products the same way in every language (§3/§12). */
const productName = (item: GiftItemView): string => (item.name.en || item.name.ar || item.name.ckb || '').trim();

function saleLabel(lang: GiftLang, item: Pick<GiftItemView, 'sale_type' | 'transport_method'>): string {
  if (item.sale_type !== 'pre_order') return giftText(lang, 'saleDirect');
  if (item.transport_method === 'air') return giftText(lang, 'routeAir');
  if (item.transport_method === 'sea') return giftText(lang, 'routeSea');
  if (item.transport_method === 'land') return giftText(lang, 'routeLand');
  return giftText(lang, 'salePreorder');
}

/** A pre-order's lead time in the reader's language; the store's free text when no days are stated. */
function leadTime(lang: GiftLang, item: Pick<GiftItemView, 'lead_time_text' | 'lead_time_min_days' | 'lead_time_max_days'>): string {
  const min = typeof item.lead_time_min_days === 'number' && item.lead_time_min_days > 0 ? item.lead_time_min_days : null;
  const max = typeof item.lead_time_max_days === 'number' && item.lead_time_max_days > 0 ? item.lead_time_max_days : null;
  if (min !== null && max !== null && max > min) return giftText(lang, 'leadDays', { min, max });
  if (min !== null || max !== null) return giftText(lang, 'leadDay', { n: (max ?? min) as number });
  return item.lead_time_text;
}

const REASON_KEY: Record<string, GiftStringKey> = {
  review: 'reasonReview',
  reward: 'reasonReward',
  compensation: 'reasonCompensation',
  admin_gift: 'reasonAdminGift',
};

// ------------------------------------------------------------ small pieces

function Thumb({ src, alt, size }: { src: string; alt: string; size: 'sm' | 'lg' }) {
  return (
    <div className={`${size === 'lg' ? 'w-20 h-20 rounded-lg' : 'w-14 h-14 rounded-md'} shrink-0 overflow-hidden bg-surface-raised`}>
      <SafeImage src={src} alt={alt} aspect="auto" className="w-full h-full" bgClassName="bg-surface-raised" fallbackClassName="text-text-muted" />
    </div>
  );
}

function Swatch({ hex }: { hex: string }) {
  if (!hex) return null;
  return <span aria-hidden="true" className="inline-block w-3 h-3 shrink-0 rounded-full border border-white/30" style={{ backgroundColor: hex }} />;
}

/** The product the gift grants: picture, name, option, colour, sale type, quantity — and its value at 0 IQD. */
export function GiftItemSummary({
  lang,
  item,
  money,
  size = 'lg',
  trailing,
}: {
  lang: GiftLang;
  item: GiftItemView;
  money: (iqd: number) => string;
  size?: 'sm' | 'lg';
  trailing?: React.ReactNode;
}) {
  const name = productName(item);
  const variant = pick(lang, item.variant);
  const color = item.color ? pick(lang, item.color) : '';
  return (
    <div className="flex items-start gap-3 min-w-0" data-gift-item={item.item_id ?? item.product_id}>
      <Thumb src={item.image} alt={name} size={size} />
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-semibold leading-snug text-text-primary line-clamp-2">
          <bdi>{name}</bdi>
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px] leading-relaxed text-text-secondary">
          {variant && <span>{variant}</span>}
          {variant && color && <span aria-hidden="true">·</span>}
          {color && (
            <span className="inline-flex items-center gap-1.5">
              <Swatch hex={item.color?.hex ?? ''} />
              {color}
            </span>
          )}
        </p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-text-muted">
          {saleLabel(lang, item)}
          {item.qty > 1 ? ` · ${giftText(lang, 'qty')} ${item.qty}` : ''}
          {item.sale_type === 'pre_order' && leadTime(lang, item) ? ` · ${leadTime(lang, item)}` : ''}
        </p>
        <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-[14px] font-semibold text-text-primary tabular-nums">{money(0)}</span>
          {item.value_iqd > 0 && (
            <span className="text-[12px] text-text-muted tabular-nums">
              {giftText(lang, 'value')} {money(item.value_iqd)}
            </span>
          )}
        </p>
      </div>
      {trailing}
    </div>
  );
}

/** «اختر هديتك»: one of the level's alternatives, as a radio group. */
function GiftChooser({
  lang,
  gift,
  money,
  busy,
  onConfirm,
  onCancel,
}: {
  lang: GiftLang;
  gift: GiftView;
  money: (iqd: number) => string;
  busy: boolean;
  onConfirm: (itemId: string) => unknown;
  onCancel?: () => void;
}) {
  const choices = gift.choices ?? [];
  const [picked, setPicked] = useState<string>(gift.chosen?.item_id ?? (choices.length === 1 && choices[0].available ? choices[0].item_id ?? '' : ''));
  const groupId = useId();
  if (choices.length === 0) {
    return <p className="text-[13px] leading-relaxed text-text-muted">{giftText(lang, 'noChoices')}</p>;
  }
  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-labelledby={`${groupId}-label`} className="grid gap-2">
        <span id={`${groupId}-label`} className="sr-only">
          {giftText(lang, 'titleGranted')}
        </span>
        {choices.map((c) => {
          const id = c.item_id ?? c.product_id;
          const selected = picked === id;
          const off = c.available === false;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-disabled={off || undefined}
              disabled={busy}
              onClick={() => {
                if (!off) setPicked(id);
              }}
              data-gift-choice={id}
              className={`w-full text-start rounded-xl border p-3 transition-colors duration-150 [touch-action:manipulation] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold ${
                selected ? 'border-gold/40 bg-surface-selected' : 'border-border-subtle bg-surface-raised'
              } ${off ? 'opacity-60 cursor-not-allowed' : ''}`}
            >
              <GiftItemSummary
                lang={lang}
                item={c}
                money={money}
                size="sm"
                trailing={
                  <span
                    aria-hidden="true"
                    className={`mt-0.5 w-5 h-5 shrink-0 rounded-full border flex items-center justify-center ${selected ? 'border-gold/40 bg-gold/10' : 'border-border-subtle'}`}
                  >
                    {selected && <Check className="w-3.5 h-3.5 text-gold" strokeWidth={3} />}
                  </span>
                }
              />
              {off && <p className="mt-2 text-[12px] leading-relaxed text-warning">{giftText(lang, 'unavailableChoice')}</p>}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={!picked || busy}
          loading={busy}
          onClick={() => onConfirm(picked)}
          data-gift-action="choose"
          className="flex-1"
        >
          {giftText(lang, 'chooseThis')}
        </Button>
        {onCancel && (
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            {giftText(lang, 'keepChoice')}
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the card

export interface GiftCardProps {
  lang: GiftLang;
  gift: GiftView;
  money: (iqd: number) => string;
  busy?: boolean;
  error?: string;
  notice?: string;
  onChoose: (gift: GiftView, itemId: string) => Promise<boolean>;
  onRedeem: (gift: GiftView) => unknown;
  onAddToCart: (gift: GiftView) => unknown;
}

const TITLE: Record<Exclude<GiftStatus, 'LEGACY'>, [GiftStringKey, GiftStringKey]> = {
  GRANTED: ['titleGranted', 'bodyGranted'],
  READY_TO_REDEEM: ['titleReady', 'bodyReady'],
  REDEEMED: ['titleRedeemed', 'bodyRedeemed'],
  ADDED_TO_ORDER: ['titleInCart', 'bodyInCart'],
  ORDERED: ['titleOrdered', 'bodyOrdered'],
  FULFILLED: ['titleFulfilled', 'bodyFulfilled'],
  CANCELLED: ['titleCancelled', 'bodyCancelled'],
};

function StateIcon({ status }: { status: GiftStatus }) {
  const cls = 'w-5 h-5 shrink-0';
  switch (status) {
    case 'REDEEMED':
      return <Gift aria-hidden="true" className={`${cls} text-success`} />;
    case 'ADDED_TO_ORDER':
      return <ShoppingCart aria-hidden="true" className={`${cls} text-info`} />;
    case 'ORDERED':
      return <Truck aria-hidden="true" className={`${cls} text-info`} />;
    case 'FULFILLED':
      return <PackageCheck aria-hidden="true" className={`${cls} text-success`} />;
    case 'CANCELLED':
      return <XCircle aria-hidden="true" className={`${cls} text-text-muted`} />;
    default:
      return <Gift aria-hidden="true" className={`${cls} text-gold`} />;
  }
}

export default function GiftCard({ lang, gift, money, busy = false, error, notice, onChoose, onRedeem, onAddToCart }: GiftCardProps) {
  const titleId = useId();
  const [changing, setChanging] = useState(false);
  const status = gift.status === 'LEGACY' ? 'CANCELLED' : gift.status;
  const [titleKey, bodyKey] = TITLE[status];
  const levelName = gift.level ? pick(lang, gift.level.name) : '';
  const levelDescription = gift.level ? pick(lang, gift.level.description) : '';
  const reasonKey = REASON_KEY[gift.reason];
  const choosing = status === 'GRANTED' || (status === 'READY_TO_REDEEM' && gift.can_change_choice && changing);
  const chosen = gift.chosen;
  const blocked = !!chosen && chosen.available === false && (status === 'READY_TO_REDEEM' || status === 'REDEEMED');
  const dates: Array<[GiftStringKey, string | null]> = [
    ['grantedAt', gift.granted_at],
    ['redeemedAt', gift.redeemed_at],
    ['orderedAt', gift.status === 'ORDERED' || gift.status === 'FULFILLED' ? gift.ordered_at : null],
    ['fulfilledAt', gift.fulfilled_at],
    ['cancelledAt', gift.status === 'CANCELLED' ? gift.cancelled_at : null],
  ];

  return (
    <article
      aria-labelledby={titleId}
      data-gift-card={gift.id}
      data-gift-status={gift.status}
      className={`rounded-2xl border border-border-subtle bg-surface p-4 sm:p-5 space-y-4 ${status === 'CANCELLED' ? 'opacity-60' : ''}`}
    >
      <header className="space-y-2">
        {gift.level && (
          <StatusChip tone="neutral" dot={false} icon={<Gift aria-hidden="true" className="w-3.5 h-3.5 text-gold" />}>
            {levelName || giftText(lang, 'levelChip', { level: gift.level.n })}
          </StatusChip>
        )}
        <h2 id={titleId} className="flex items-start gap-2 text-[16px] font-bold leading-snug text-text-primary">
          <StateIcon status={gift.status} />
          <span className="min-w-0">
            {giftText(lang, titleKey)}
            {status === 'REDEEMED' && <span aria-hidden="true"> ✓</span>}
          </span>
        </h2>
        <p className="text-[13px] leading-relaxed text-text-secondary">
          {choosing && levelDescription ? levelDescription : giftText(lang, bodyKey)}
        </p>
        {reasonKey && <p className="text-[12px] leading-relaxed text-text-muted">{giftText(lang, reasonKey)}</p>}
      </header>

      {choosing ? (
        <GiftChooser
          lang={lang}
          gift={gift}
          money={money}
          busy={busy}
          onConfirm={async (itemId) => {
            const ok = await onChoose(gift, itemId);
            if (ok) setChanging(false);
          }}
          onCancel={status === 'READY_TO_REDEEM' ? () => setChanging(false) : undefined}
        />
      ) : (
        chosen && (
          <div className="rounded-xl bg-surface-raised p-3">
            <GiftItemSummary lang={lang} item={chosen} money={money} />
            {blocked && (
              <p className="mt-2 text-[12px] leading-relaxed text-warning" data-gift-blocked={gift.id}>
                {giftText(lang, 'unavailableChosen')}
              </p>
            )}
          </div>
        )
      )}

      {notice && (
        <p role="status" className="text-[13px] leading-relaxed text-success">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-[13px] leading-relaxed text-danger" data-gift-error={gift.id}>
          {error}
        </p>
      )}

      {!choosing && (status === 'READY_TO_REDEEM' || status === 'REDEEMED' || status === 'ADDED_TO_ORDER' || status === 'ORDERED' || status === 'FULFILLED') && (
        <div className="flex flex-wrap gap-2">
          {status === 'READY_TO_REDEEM' && (
            <>
              <Button
                variant="primary"
                className="flex-1"
                disabled={blocked}
                loading={busy}
                loadingLabel={giftText(lang, 'redeeming')}
                onClick={() => onRedeem(gift)}
                data-gift-action="redeem"
              >
                {giftText(lang, 'redeem')}
              </Button>
              {gift.can_change_choice && (
                <Button variant="ghost" disabled={busy} onClick={() => setChanging(true)} data-gift-action="change">
                  {giftText(lang, 'changeChoice')}
                </Button>
              )}
            </>
          )}
          {status === 'REDEEMED' && (
            <Button
              variant="primary"
              className="flex-1"
              disabled={blocked}
              loading={busy}
              loadingLabel={giftText(lang, 'adding')}
              icon={<ShoppingCart aria-hidden="true" className="w-4 h-4" />}
              onClick={() => onAddToCart(gift)}
              data-gift-action="add-to-cart"
            >
              {giftText(lang, 'addToCart')}
            </Button>
          )}
          {status === 'ADDED_TO_ORDER' && (
            <Link to="/cart" className="lv-button lv-button-secondary flex-1" data-gift-action="go-to-cart">
              <ShoppingCart aria-hidden="true" className="w-4 h-4" />
              {giftText(lang, 'goToCart')}
            </Link>
          )}
          {(status === 'ORDERED' || status === 'FULFILLED') && gift.order && (
            <Link to={`/orders/${encodeURIComponent(gift.order.id)}`} className="lv-button lv-button-secondary flex-1" data-gift-action="view-order">
              {giftText(lang, 'viewOrder')}
              <span dir="ltr" className="tabular-nums">
                {gift.order.id}
              </span>
            </Link>
          )}
        </div>
      )}

      <footer className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] leading-relaxed text-text-muted">
        {dates
          .filter(([, at]) => !!at)
          .map(([key, at]) => (
            <span key={key}>
              {giftText(lang, key)} {formatDate(at, lang)}
            </span>
          ))}
      </footer>
    </article>
  );
}
