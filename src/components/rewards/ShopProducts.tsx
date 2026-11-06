/**
 * «منتجات مقابل نقاطك» — /rewards/shop, below the coupons (owner, 2026-11-05: «23000
 * points to redeem filament of esun pla plus beige …»; DECISIONS row 299).
 *
 * Each row is what the server sent: the photo, the name, the colour, the price in points,
 * what is short, «استبدل». The page decides nothing: the button is off by the server's own
 * fields alone (`holding`, `available`, `affordable`), and the line beside it says why.
 *
 * THE SWAP is the coupon's: the ConfirmDialog states the price and «تدفع أجرة التوصيل فقط»,
 * its confirm POSTs `/api/rewards/program/shop/items/:id` (no body) busy inside the dialog,
 * and a refusal stays in it in words while the list is read again behind it. On success the
 * dialog closes, the frame reads the hub and the wallet again, and the alert offers the next
 * step: «أضف إلى السلة» through the gift cart's one door (conflicts as «هداياي» handles them:
 * ../reviews/gifts/useGiftCartAdd) and «هداياي», where the gift waits if they leave.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ShoppingCart } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { giftLang, giftText } from '../reviews/gifts/giftStrings';
import { useGiftCartAdd, useGiftRefusalSentence } from '../reviews/gifts/useGiftCartAdd';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import SafeImage from '../ui/SafeImage';
import { ForwardChevron, INLINE_LINK, SECTION_HEADING } from './AreaChrome';
import { pointsForm, type CopyKey } from './copy';
import type { ShopProductItem } from './types';
import { useRewardsT } from './useT';

/** The link that ends a line with ‹ («اجمع النقاط ‹», «هداياي ‹»). */
const CHEVRON_LINK = `${INLINE_LINK} inline-flex items-center gap-0.5`;

/** A refusal of the swap, in the shop's words (the codes of worker/lib/rewards/shopItems.ts). */
function refusalKey(error: unknown): CopyKey {
  switch (error instanceof ApiError ? error.code : undefined) {
    case 'INSUFFICIENT_POINTS':
      return 'shop.err.points';
    case 'REWARD_SHOP_HOLDING':
      return 'shop.product.err.holding';
    case 'REWARD_SHOP_UNAVAILABLE':
      return 'shop.err.unavailable';
    case 'RATE_LIMITED':
      return 'tooMany';
    default:
      return 'shop.err.generic';
  }
}

interface Done {
  giftId: string;
  name: string;
  added: boolean;
  error: string;
}

export interface ShopProductsProps {
  items: ShopProductItem[];
  /** Reads the hub again after a refusal: the list on screen was wrong. */
  reload: () => unknown;
  /** After a swap: reads the hub and the wallet again, together. Never rejects. */
  onSwapped: () => Promise<void>;
}

export function ShopProducts({ items, reload, onSwapped }: ShopProductsProps) {
  const { t, count, tri, lang } = useRewardsT();
  const gl = giftLang(lang);
  // The item is kept after closing, so the dialog's words stay in place while it slides away.
  const [asking, setAsking] = useState<{ item: ShopProductItem; open: boolean } | null>(null);
  const [refusal, setRefusal] = useState<CopyKey | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const alertRef = useRef<HTMLDivElement | null>(null);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const sentence = useGiftRefusalSentence(gl);

  const onAdded = useCallback(() => setDone((d) => (d ? { ...d, added: true, error: '' } : d)), []);
  const onRefused = useCallback(
    async (_id: string, err: unknown) => {
      const said = await sentence(err);
      setDone((d) => (d ? { ...d, error: said } : d));
    },
    [sentence]
  );
  const cart = useGiftCartAdd({ lang: gl, onAdded, onRefused });

  // The swap disabled the button that opened the dialog (the product is now held), and focus
  // fell to the page with it, or sits in the dialog still sliding away and falls when it leaves
  // (a quick answer beats the animation): give it to the next step, or to the alert that says
  // what happened.
  useEffect(() => {
    if (!done || done.added || typeof document === 'undefined') return;
    const at = document.activeElement;
    const lost = !at || at === document.body || (at instanceof HTMLButtonElement && at.disabled) || !!at.closest('[data-overlay]');
    if (!lost) return;
    (addRef.current ?? alertRef.current)?.focus();
    // Only when a new swap lands, not on every change of the alert.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done?.giftId]);

  const nameOf = (item: ShopProductItem) => tri(item.product.name);
  const cancel = () => setAsking((s) => (s ? { ...s, open: false } : s));

  const settle = async (giftId: string | undefined, name: string) => {
    await onSwapped();
    if (giftId) setDone({ giftId, name, added: false, error: '' });
  };

  const confirm = async () => {
    const item = asking?.item;
    if (!item) return;
    setRefusal(null);
    let giftId: string | undefined;
    try {
      const res = await api.post<{ success: true; gift?: { id?: string } | null }>(`/api/rewards/program/shop/items/${encodeURIComponent(item.id)}`);
      giftId = res?.gift?.id;
    } catch (error) {
      const key = refusalKey(error);
      setRefusal(key);
      // The list behind the dialog was wrong (points, a held product, an offer withdrawn): read what the server says now. Not after a rate limit.
      if (key !== 'tooMany') void reload();
      return;
    }
    cancel();
    void settle(giftId, nameOf(item));
  };

  return (
    <section aria-labelledby="shop-products-title" className="space-y-2" data-shop-products>
      <div>
        <h2 id="shop-products-title" className={SECTION_HEADING}>
          {t('shop.products.title')}
        </h2>
        <p className="px-1 text-[12.5px] leading-5 text-text-secondary">{t('shop.products.lead')}</p>
      </div>

      {done && (
        <div
          ref={alertRef}
          tabIndex={-1}
          role="status"
          data-testid="shop-product-done"
          className="lv-alert lv-alert-success space-y-2 text-[13px] leading-6 text-text-primary focus:outline-none"
        >
          <p className="flex items-start gap-2">
            <Check className="mt-1 w-4 h-4 shrink-0 text-success" aria-hidden="true" />
            <span className="min-w-0">{done.added ? t('shop.product.added') : t('shop.product.done', { item: done.name })}</span>
          </p>
          {done.error && (
            <p role="alert" className="text-[12.5px] leading-5 text-danger">
              {done.error}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {done.added ? (
              <Link to="/cart" className="lv-button lv-button-primary lv-button-sm">
                <ShoppingCart aria-hidden="true" className="w-4 h-4" />
                {giftText(gl, 'goToCart')}
              </Link>
            ) : (
              <Button
                ref={addRef}
                variant="primary"
                size="sm"
                loading={cart.busy}
                loadingLabel={giftText(gl, 'adding')}
                icon={<ShoppingCart aria-hidden="true" className="w-4 h-4" />}
                onClick={() => void cart.add(done.giftId)}
                data-testid="shop-product-add"
              >
                {giftText(gl, 'addToCart')}
              </Button>
            )}
            <Link to="/gifts" className={CHEVRON_LINK}>
              {t('shop.product.gifts')}
              <ForwardChevron />
            </Link>
          </div>
        </div>
      )}

      <ul className="space-y-2">
        {items.map((item) => {
          const held = item.holding;
          const off = !held && !item.available;
          const short = !held && !off && !item.affordable;
          const reasonId = `shop-product-${item.id}-why`;
          const name = nameOf(item);
          const color = item.product.color ? tri(item.product.color) : '';
          const option = item.product.option ? tri(item.product.option) : '';
          const qty = item.product.qty ?? 1;
          return (
            <li key={item.id} className="lv-surface p-4 space-y-3" data-testid="shop-product" data-shop-product={item.id}>
              <div className="flex items-start gap-3">
                <div className="size-[4.5rem] shrink-0 overflow-hidden rounded-xl lv-well">
                  <SafeImage sizes="72px" src={item.product.image} alt={name} aspect="auto" className="w-full h-full" bgClassName="bg-surface-raised" fallbackClassName="text-text-muted" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-[15px] font-bold leading-6 text-text-primary">
                    <bdi>{name}</bdi>
                  </h3>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12.5px] leading-5 text-text-secondary">
                    {color && (
                      <span className="inline-flex items-center gap-1.5">
                        {item.product.color_hex && (
                          <span aria-hidden="true" className="inline-block size-3 shrink-0 rounded-full border border-text-muted/70" style={{ backgroundColor: item.product.color_hex }} />
                        )}
                        <bdi>{color}</bdi>
                      </span>
                    )}
                    {color && option && <span aria-hidden="true">·</span>}
                    {option && <bdi>{option}</bdi>}
                    {qty > 1 && <span>· {count('pieces', qty)}</span>}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <p className="text-[15px] font-bold tabular-nums text-text-primary">{count('points', item.points)}</p>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={held || off || short}
                      aria-describedby={held || off || short ? reasonId : undefined}
                      onClick={() => {
                        setRefusal(null);
                        setAsking({ item, open: true });
                      }}
                      data-testid="shop-product-swap"
                    >
                      {t('shop.swap')}
                    </Button>
                  </div>
                </div>
              </div>
              {(held || off || short) && (
                <p id={reasonId} className="text-[12px] leading-5 text-text-secondary">
                  {held ? (
                    <>
                      {t('shop.product.holding')}
                      {' · '}
                      <Link to="/gifts" className={CHEVRON_LINK}>
                        {t('shop.product.gifts')}
                        <ForwardChevron />
                      </Link>
                    </>
                  ) : off ? (
                    t('shop.product.unavailable')
                  ) : (
                    <>
                      {item.points_short > 0 ? count('pointsShort', item.points_short) : t('shop.err.points')}
                      {' · '}
                      <Link to="/points" className={CHEVRON_LINK}>
                        {t('earn')}
                        <ForwardChevron />
                      </Link>
                    </>
                  )}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <p className="px-1 text-[12px] leading-5 text-text-muted">{t('shop.product.oneEach')}</p>

      {asking && (
        <ConfirmDialog
          open={asking.open}
          title={t('shop.product.confirm.title', { points: count(pointsForm('shop.product.confirm.title'), asking.item.points) })}
          consequence={t('shop.product.confirm.body', { item: nameOf(asking.item) })}
          confirmLabel={t('shop.swap')}
          cancelLabel={t('cancel')}
          onConfirm={confirm}
          onCancel={cancel}
          error={refusal ? t(refusal) : undefined}
          testId="shop-product-confirm"
        />
      )}

      {cart.dialog}
    </section>
  );
}
