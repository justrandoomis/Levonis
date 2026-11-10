/**
 * «استخدمه الآن» — USING A COUPON (rewards spec §3.1 `useCoupon`, §3.2
 * CouponTargetsSheet), shared by the hub's «بانتظارك» card, «كوبوناتي» and
 * the shop's success line.
 *
 *   const coupon = useCouponAction();
 *   <Button variant="secondary" onClick={() => coupon.useIt(c)}>…</Button>
 *   {coupon.sheet}
 *
 * `useIt(c)` saves the code for the cart (storePromo, the promo box's own
 * sessionStorage key) and then follows `couponDestination(c)`:
 * - a page (the cart, the coupon's one product, its section): the toast
 *   «حفظنا الكود — وعند الدفع نطبّق كل كوبوناتك المناسبة للطلب.», then that page. The toast queue is
 *   module-level, so it survives the shell swap to the main site;
 * - a choice of products: the targets sheet opens, and its rows lead to each
 *   product;
 * - nowhere (no live target): nothing — a screen shows no use button then.
 *
 * CALL IT AS A MEMBER, `coupon.useIt(c)`: a bare `useIt(c)` (destructured)
 * reads as a hook call to react-hooks/rules-of-hooks inside an event handler.
 * Rename on destructuring (`const { useIt: use } = …`) if a bare name is
 * wanted.
 *
 * The screen that calls the hook OWNS the sheet: render `coupon.sheet` once,
 * anywhere in the screen. It unmounts with the screen, so Back never leaves
 * a sheet open.
 */
import React, { useCallback, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { storePromo } from '../PromoCodeField';
import { useMoney } from '../../CurrencyContext';
import { toast } from '../../lib/toastStore';
import { Sheet } from '../ui/Sheet';
import SafeImage from '../ui/SafeImage';
import { ForwardChevron } from './AreaChrome';
import { couponDestination, pickName } from './model';
import type { RewardCoupon } from './types';
import { useRewardsT } from './useT';

/**
 * What a free-delivery coupon is worth, from its own row: an amount and the order
 * it needs, or (issued before 0225) the whole fee.
 */
export function useShipDetail(): (c: Pick<RewardCoupon, 'amount_iqd' | 'min_total_iqd'>) => string {
  const { t } = useRewardsT();
  const { money } = useMoney();
  return (c) => {
    if (!c.amount_iqd) return t('coupon.shipDetail');
    // A figure and its unit never part at a line end: «100,000 / د.ع» read as two things.
    const whole = (iqd: number) => money(iqd).replace(/ /g, '\u00A0');
    const amount = t('coupon.shipAmount', { money: whole(c.amount_iqd) });
    return c.min_total_iqd ? `${amount} · ${t('coupon.shipMin', { money: whole(c.min_total_iqd) })}` : amount;
  };
}

export interface CouponAction {
  /** Save the code and go where it is spent (see above). Call it as `coupon.useIt(c)`. */
  useIt(c: RewardCoupon): void;
  /** The targets sheet of the last coupon that needed a choice; null until one did. */
  sheet: React.ReactNode;
}

export function useCouponAction(): CouponAction {
  const navigate = useNavigate();
  const { t } = useRewardsT();
  // The coupon is kept after closing, so the sheet's rows stay in place while it slides away.
  const [choice, setChoice] = useState<{ coupon: RewardCoupon; open: boolean } | null>(null);

  const useIt = useCallback(
    (c: RewardCoupon) => {
      const where = couponDestination(c);
      if (where.kind === 'none') return;
      storePromo(c.code);
      if (where.kind === 'path') {
        toast.success(t('coupon.saved'));
        navigate(where.to);
        return;
      }
      setChoice({ coupon: c, open: true });
    },
    [navigate, t]
  );

  const close = useCallback(() => setChoice((s) => (s ? { ...s, open: false } : s)), []);

  return {
    useIt,
    sheet: choice ? <CouponTargetsSheet open={choice.open} coupon={choice.coupon} onClose={close} /> : null,
  };
}

/** The most rows the sheet lists (the server names at most 20 per coupon). */
export const TARGETS_SHOWN_MAX = 20;

export interface CouponTargetsSheetProps {
  open: boolean;
  /** A filament coupon whose `targets` name more than one product. */
  coupon: RewardCoupon;
  onClose: () => void;
}

/**
 * «على أي فلامنت تستخدمه؟»: the coupon's products (the code is already
 * saved), each a row to its page, then how many more it covers. A centred
 * window from `sm`; one height on a phone, dragged by its grabber.
 */
export function CouponTargetsSheet({ open, coupon, onClose }: CouponTargetsSheetProps) {
  const { t, count } = useRewardsT();
  const targets = coupon.targets ?? null;
  const rows = (targets?.products ?? []).filter((p) => !!p.slug).slice(0, TARGETS_SHOWN_MAX);
  // Counted against the rows shown, so a product with no page still counts as one more.
  const rest = Math.max(0, (targets?.products_total ?? 0) - rows.length);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      dragHandle
      labelledBy="targets-title"
      testId="coupon-targets"
      // Never taller than a phone's screen (twenty rows are): the rows scroll, as in the entry sheet.
      panelClassName="max-h-[calc(100dvh-3.5rem)] sm:max-w-[460px] sm:w-[92vw]"
      header={
        <h2 id="targets-title" className="px-4 pb-2 pt-1 text-center text-[16px] font-extrabold">
          {t('targets.title')}
        </h2>
      }
    >
      <div className="space-y-2 px-4 py-2">
        <p className="text-[13px] text-text-secondary">{t('targets.body')}</p>
        <ul className="space-y-2">
          {rows.map((p) => (
            <li key={p.id}>
              <Link to={`/product/${encodeURIComponent(p.slug)}`} onClick={onClose} className="lv-choice flex w-full items-center gap-3 p-3 text-start">
                <SafeImage src={p.image || null} alt="" aspect="square" sizes="48px" className="size-12 shrink-0 rounded-md" bgClassName="bg-surface" />
                <span className="min-w-0 flex-1 text-[14px] font-semibold text-text-primary">
                  <bdi>{pickName(p.name)}</bdi>
                </span>
                <ForwardChevron />
              </Link>
            </li>
          ))}
        </ul>
        {rest > 0 && <p className="text-[12px] text-text-muted">{count('targetsMore', rest)}</p>}
      </div>
    </Sheet>
  );
}
