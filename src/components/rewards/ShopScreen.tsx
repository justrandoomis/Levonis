/**
 * «استبدل نقاطك» — /rewards/shop (rewards spec §3.3): swap points for a coupon,
 * knowing its price and its terms — or learn that points are spent at
 * checkout.
 *
 * WHO RENDERS WHAT (src/pages/RewardsArea.tsx)
 * - The frame draws the header (h1 «استبدل نقاطك»), the scroller and its
 *   `space-y-4` column; this returns the screen's blocks as a fragment.
 * - Session loading: the frame draws <ShopSkeleton />. A guest: the frame
 *   draws the sign-in state (guest.shop.*). A signed-in customer: this.
 * - The frame draws <StaleLine /> above the screen when `hub.stale`, and
 *   <RelatedDoors current="shop" /> after it; neither is drawn here.
 *
 * By `hub.status`:
 * - no data yet: <ShopSkeleton />; a failed first read: <ErrorState />;
 * - `installed === false`: <SetupState />;
 * - ready, `shop` empty (the default, nothing priced): the balance row and the
 *   honest unpriced EmptyState — points are spent at checkout; no «opens
 *   soon» promise;
 * - ready: the balance row, the offers, the one-of-each note, «أو استخدم نقاطك
 *   عند الدفع». No raised card on this screen; prices and the balance are ink.
 *
 * THE SWAP. «استبدل» is disabled by the server's fields only (`!affordable ||
 * holding`) and the line beside it says why — the points still missing
 * (`points_short`) with «اجمع النقاط», or the coupon already held with
 * «اعرضه». The controlled ConfirmDialog states the price and that the points
 * never come back (policy 14.10); its confirm POSTs
 * `/api/rewards/program/shop/:kind` (no body), busy inside the dialog, and a
 * refusal stays in it in words (the hub is read again behind it, so the list
 * shows what the server now says). On success:
 * 1. the dialog closes;
 * 2. `await onSwapped()` — the frame reads the hub and the wallet again,
 *    together, and resolves once both are in;
 * 3. the success alert (`shop.done`, the date from the RETURNED
 *    `coupon.expires_at`);
 * 4. its «استخدمه الآن» runs `coupon.useIt(c)` (./couponUse) on the reloaded
 *    `hub.data.coupons` entry with the returned coupon's id — disabled until
 *    that entry is there. When the swap disabled the button that opened the
 *    dialog (the coupon is now held), focus moves to that alert instead of
 *    falling to the page.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Coins, Percent, Truck } from 'lucide-react';
import { useMoney } from '../../CurrencyContext';
import { api, ApiError } from '../../lib/api';
import { formatPercent } from '../../lib/localeNumber';
import { EmptyState, ErrorState } from '../ui/AsyncStates';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { ForwardChevron, ICON_DISC, INLINE_LINK, SECTION_HEADING, SetupState, ShopSkeleton } from './AreaChrome';
import { pointsForm, type CopyKey } from './copy';
import { useCouponAction, useShipDetail } from './couponUse';
import { nearDate, usable } from './model';
import type { RewardCoupon, RewardsHubData, ShopItem } from './types';
import type { Read } from './useRewardsData';
import { useRewardsT } from './useT';

export interface ShopScreenProps {
  /** GET /api/rewards/program (useRewardsHub): `shop`, `point_balance`, `coupons`, `program`. */
  hub: Read<RewardsHubData>;
  /** After a swap succeeded: `await Promise.all([hub.reload(), refreshWallet()])`, run by the frame. Never rejects. */
  onSwapped: () => Promise<void>;
}

/** What `POST /api/rewards/program/shop/:kind` answers. */
interface SwapResponse {
  success: true;
  coupon: RewardCoupon;
}

/** A refusal of the swap, in the shop's words (the codes of worker/routes/rewardsProgram.ts). */
function refusalKey(error: unknown): CopyKey {
  switch (error instanceof ApiError ? error.code : undefined) {
    case 'INSUFFICIENT_POINTS':
      return 'shop.err.points';
    case 'REWARD_SHOP_HOLDING':
      return 'shop.err.holding';
    case 'REWARD_SHOP_UNAVAILABLE':
      return 'shop.err.unavailable';
    case 'RATE_LIMITED':
      return 'tooMany';
    default:
      return 'shop.err.generic';
  }
}

/** The link that ends a line with ‹ («اجمع النقاط ‹», «اعرضه ‹», «كوبوناتي ‹»). */
const CHEVRON_LINK = `${INLINE_LINK} inline-flex items-center gap-0.5`;

export function ShopScreen({ hub, onSwapped }: ShopScreenProps) {
  const { t, tx, count, lang } = useRewardsT();
  const { money } = useMoney();
  const coupon = useCouponAction();
  // The item is kept after closing, so the dialog's words stay in place while it slides away.
  const [asking, setAsking] = useState<{ item: ShopItem; open: boolean } | null>(null);
  const [refusal, setRefusal] = useState<CopyKey | null>(null);
  /** The coupon the last swap issued, as the POST returned it. */
  const [done, setDone] = useState<{ id: string; expiresAt: string } | null>(null);
  const alertRef = useRef<HTMLDivElement | null>(null);
  const useNowRef = useRef<HTMLButtonElement | null>(null);
  const shipDetail = useShipDetail();
  const { reload } = hub;

  // The swap disabled the button that opened the dialog (the coupon is now
  // held), and focus fell to the page with it: give it to the alert that
  // says what happened. Focus that is still somewhere is left where it is.
  useEffect(() => {
    if (!done || typeof document === 'undefined') return;
    const at = document.activeElement;
    const lost = !at || at === document.body || (at instanceof HTMLButtonElement && at.disabled);
    if (!lost) return;
    const button = useNowRef.current;
    (button && !button.disabled ? button : alertRef.current)?.focus();
  }, [done]);

  const data = hub.data;
  if (!data) {
    return hub.status === 'error' ? <ErrorState error={hub.error} onRetry={() => void hub.reload()} /> : <ShopSkeleton />;
  }
  if (data.installed === false) return <SetupState />;

  const program = data.program;
  const shop = data.shop ?? [];
  const cap = program?.filament?.max_discount_iqd;
  const shipAmount = program?.free_shipping?.amount_iqd;
  const shipText = shipAmount ? shipDetail({ amount_iqd: shipAmount, min_total_iqd: program?.free_shipping?.min_order_iqd }) : null;
  const pieces = program?.filament?.max_pieces;
  const filamentText = [cap != null && cap > 0 ? t('shop.cap', { money: money(cap) }) : null, pieces ? t('coupon.pieces', { pieces: count('pieces', pieces) }) : null]
    .filter(Boolean)
    .join(' · ');
  const validText = t('shop.valid', { days: count('days', program?.valid_days ?? 0) });

  const itemTitle = (item: ShopItem) =>
    item.kind === 'free_shipping' ? t('shop.ship') : t('shop.filament', { percent: formatPercent(program?.filament?.percent ?? 0, lang, 0) });

  const ask = (item: ShopItem) => {
    setRefusal(null);
    setAsking({ item, open: true });
  };
  const cancel = () => setAsking((s) => (s ? { ...s, open: false } : s));

  // 2 and 3 of THE SWAP: once the dialog has closed.
  const settle = async (issued: RewardCoupon | undefined) => {
    await onSwapped();
    if (issued?.id) setDone({ id: issued.id, expiresAt: issued.expires_at });
  };

  const confirm = async () => {
    const item = asking?.item;
    if (!item) return;
    setRefusal(null);
    let issued: RewardCoupon | undefined;
    try {
      const res = await api.post<SwapResponse>(`/api/rewards/program/shop/${encodeURIComponent(item.kind)}`);
      issued = res?.coupon;
    } catch (error) {
      const key = refusalKey(error);
      setRefusal(key);
      // The list behind the dialog was wrong (points, a held coupon, an offer
      // withdrawn): read what the server says now. Not after a rate limit.
      if (key !== 'tooMany') void reload();
      return;
    }
    cancel();
    void settle(issued);
  };

  // The reloaded hub's copy of the issued coupon: «استخدمه الآن» waits for it.
  const fresh = done ? (data.coupons ?? []).find((c) => c.id === done.id) : undefined;
  const pointsNow = data.point_balance;

  return (
    <>
      <Link
        to="/points"
        className="lv-surface flex min-h-14 items-center justify-between gap-3 px-4 py-3 hover:bg-surface-raised active:shadow-press transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <span className="min-w-0 text-[14px] leading-6 text-text-secondary">
          {tx('shop.balance', {
            points: (
              <span className="text-[15px] font-bold tabular-nums text-text-primary">
                {typeof pointsNow === 'number' && Number.isFinite(pointsNow) ? count('points', pointsNow) : '—'}
              </span>
            ),
          })}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 text-[13px] font-semibold text-text-secondary">
          {t('shop.history')}
          <ForwardChevron />
        </span>
      </Link>

      {done && (
        <div
          ref={alertRef}
          tabIndex={-1}
          role="status"
          data-testid="shop-done"
          className="lv-alert lv-alert-success space-y-2 text-[13px] leading-6 text-text-primary focus:outline-none"
        >
          <p className="flex items-start gap-2">
            <Check className="mt-1 w-4 h-4 shrink-0 text-success" aria-hidden="true" />
            <span className="min-w-0">{t('shop.done', { date: nearDate(done.expiresAt, data.server_time, lang) })}</span>
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {(!fresh || usable(fresh)) && (
              <Button
                ref={useNowRef}
                variant="primary"
                size="sm"
                disabled={!fresh}
                onClick={() => {
                  if (fresh) coupon.useIt(fresh);
                }}
              >
                {t('coupon.use')}
              </Button>
            )}
            <Link to="/rewards/coupons" className={CHEVRON_LINK}>
              {t('title.coupons')}
              <ForwardChevron />
            </Link>
          </div>
        </div>
      )}

      {shop.length === 0 ? (
        <EmptyState
          icon={<Coins className="w-6 h-6" aria-hidden="true" />}
          title={t('shop.empty.title')}
          description={t('shop.empty.body')}
          action={
            <Link to="/cart" className="lv-button lv-button-secondary mt-1">
              {t('shop.toCart')}
            </Link>
          }
        />
      ) : (
        <>
          <ul className="space-y-2">
            {shop.map((item) => {
              const held = item.holding === true;
              const short = !held && !item.affordable;
              const reasonId = `shop-${item.kind}-why`;
              return (
                <li key={item.kind} className="lv-surface p-4 space-y-3" data-testid="shop-item">
                  <div className="flex items-start gap-3">
                    <span aria-hidden="true" className={ICON_DISC}>
                      {item.kind === 'free_shipping' ? <Truck className="w-5 h-5" /> : <Percent className="w-5 h-5" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                        <h2 className="min-w-0 text-[15px] font-bold leading-6 text-text-primary">{itemTitle(item)}</h2>
                        <span className="shrink-0 text-[15px] font-bold tabular-nums text-text-primary">{count('points', item.points)}</span>
                      </div>
                      <p className="mt-0.5 text-[12px] leading-5 text-text-secondary">
                        {item.kind === 'filament_discount' && filamentText ? `${filamentText} · ${validText}` : item.kind === 'free_shipping' && shipText ? `${shipText} · ${validText}` : validText}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
                    {(held || short) && (
                      <p id={reasonId} className="min-w-0 flex-1 text-[12px] leading-5 text-text-secondary">
                        {held ? (
                          <>
                            {t('shop.holding')}
                            {' · '}
                            <Link to="/rewards/coupons" className={CHEVRON_LINK}>
                              {t('shop.show')}
                              <ForwardChevron />
                            </Link>
                          </>
                        ) : (
                          <>
                            {typeof item.points_short === 'number' && item.points_short > 0
                              ? count('pointsShort', item.points_short)
                              : t('shop.err.points')}
                            {' · '}
                            <Link to="/points" className={CHEVRON_LINK}>
                              {t('earn')}
                              <ForwardChevron />
                            </Link>
                          </>
                        )}
                      </p>
                    )}
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={held || short}
                      aria-describedby={held || short ? reasonId : undefined}
                      onClick={() => ask(item)}
                    >
                      {t('shop.swap')}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="px-1 text-[12px] leading-5 text-text-muted">{t('shop.oneEach')}</p>
          <section aria-labelledby="shop-checkout-title" className="space-y-2">
            <h2 id="shop-checkout-title" className={SECTION_HEADING}>
              {t('shop.checkout.title')}
            </h2>
            <div className="lv-surface flex flex-wrap items-center justify-end gap-3 p-4">
              <p className="min-w-0 flex-1 text-[13px] leading-6 text-text-secondary">{t('shop.checkout.body')}</p>
              <Link to="/cart" className="lv-button lv-button-secondary lv-button-sm shrink-0">
                {t('shop.toCart')}
              </Link>
            </div>
          </section>
        </>
      )}

      {asking && (
        <ConfirmDialog
          open={asking.open}
          title={t('shop.confirm.title', { points: count(pointsForm('shop.confirm.title'), asking.item.points) })}
          consequence={t('shop.confirm.body', { item: itemTitle(asking.item), days: count('days', program?.valid_days ?? 0) })}
          confirmLabel={t('shop.swap')}
          cancelLabel={t('cancel')}
          onConfirm={confirm}
          onCancel={cancel}
          error={refusal ? t(refusal) : undefined}
          testId="shop-confirm"
        />
      )}

      {coupon.sheet}
    </>
  );
}
