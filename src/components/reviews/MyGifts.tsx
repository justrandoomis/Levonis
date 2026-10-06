import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Gift, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { useMoney } from '../../CurrencyContext';
import { IconButton } from '../ui/Button';
import { Skeleton, SkeletonGroup } from '../ui/Skeleton';
import { EmptyState, ErrorState } from '../ui/AsyncStates';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import GiftCard, { sortGifts, type GiftView } from './gifts/GiftCard';
import LegacyGiftCard, { type LegacyGift } from './gifts/LegacyGiftCard';
import { giftLang, giftText, type GiftStringKey } from './gifts/giftStrings';

/**
 * /gifts — «هداياي» (owner brief 2026-10-06 §1; docs/GIFTS_QUICK_BUY.md §1.3).
 *
 * The lifecycle is the server's: `GET /api/gifts` answers one `status` per
 * gift, and this page draws one card per status. Every action is one request
 * and then a fresh read of that same answer:
 *
 *   GRANTED          ──«تأكيد الاختيار» (POST /api/gifts/:id/choose)──► READY_TO_REDEEM
 *   READY_TO_REDEEM  ──«استرداد الهدية» (POST /api/gifts/:id/redeem)──► REDEEMED
 *   REDEEMED         ──«أضف إلى السلة» (POST /api/cart/gift-items)───► ADDED_TO_ORDER
 *   ADDED_TO_ORDER → ORDERED → FULFILLED happen in the cart, the checkout and the order.
 *
 * Nothing here decides a status, a price or a permission. A double press is
 * answered by the server as a replay; the buttons are busy meanwhile. The
 * refusal sentences live in src/lib/refusalStrings.ts and are loaded on the
 * first refusal only, so the page does not carry that table up front.
 */

type Refusals = typeof import('../../lib/refusalStrings');

type Conflict = { kind: 'shipping' | 'seller'; gift: GiftView };

/** A refusal that means the card on screen is out of date — the next read shows the truth. */
const STALE_CODES = new Set([
  'GIFT_NOT_FOUND',
  'GIFT_STATE',
  'GIFT_NOT_REDEEMED',
  'GIFT_ALREADY_ORDERED',
  'GIFT_CHOICE_REQUIRED',
  'GIFT_ITEM_UNAVAILABLE',
  'GIFT_NOT_AVAILABLE',
  'GIFT_NOT_ORDERABLE',
]);

function without<T>(map: Record<string, T>, id: string): Record<string, T> {
  if (!(id in map)) return map;
  const next = { ...map };
  delete next[id];
  return next;
}

export default function MyGifts() {
  const { lang: rawLang, dir } = useLanguage();
  const lang = giftLang(rawLang);
  const { money } = useMoney();
  const t = useCallback((key: GiftStringKey) => giftText(lang, key), [lang]);

  const [gifts, setGifts] = useState<GiftView[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [confirming, setConfirming] = useState<GiftView | null>(null);

  const busyRef = useRef(new Set<string>());
  const loadSeq = useRef(0);
  const aborter = useRef<AbortController | null>(null);
  const refusalsLoad = useRef<Promise<Refusals | null> | null>(null);

  /** The refusal table, fetched once, on the first refusal. */
  const loadRefusals = useCallback((): Promise<Refusals | null> => {
    if (!refusalsLoad.current) {
      refusalsLoad.current = import('../../lib/refusalStrings').then(
        (m) => m,
        () => {
          refusalsLoad.current = null;
          return null;
        }
      );
    }
    return refusalsLoad.current;
  }, []);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    const seq = ++loadSeq.current;
    // Its own request every time: a read that started BEFORE an action
    // committed must never answer for after it.
    aborter.current?.abort();
    const controller = new AbortController();
    aborter.current = controller;
    if (!opts?.silent) {
      setLoading(true);
      setLoadError(null);
    }
    try {
      const res = await api.get<{ gifts?: GiftView[] }>('/api/gifts', { signal: controller.signal });
      if (seq !== loadSeq.current) return;
      setGifts(Array.isArray(res.gifts) ? res.gifts : []);
      setLoadError(null);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      // A background re-read that fails leaves the cards on screen alone.
      if (!opts?.silent) setLoadError(err);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => aborter.current?.abort();
  }, [load]);

  /** One action per card at a time; the card's last message is cleared when a new one starts. */
  const run = useCallback(async <T,>(id: string, action: () => Promise<T>): Promise<T | undefined> => {
    if (busyRef.current.has(id)) return undefined;
    busyRef.current.add(id);
    setBusy((b) => ({ ...b, [id]: true }));
    setErrors((e) => without(e, id));
    setNotices((n) => without(n, id));
    try {
      return await action();
    } finally {
      busyRef.current.delete(id);
      setBusy((b) => without(b, id));
    }
  }, []);

  /** A refusal as the customer's sentence: network and rate first, then the code's own sentence. */
  const sentence = useCallback(
    async (err: unknown): Promise<string> => {
      if (err instanceof ApiError && err.status === 0) return t('networkError');
      if (err instanceof ApiError && err.status === 429) return t('tooManyTries');
      const table = await loadRefusals();
      return table ? table.apiRefusal(err, lang, t('actionFailed')) || t('actionFailed') : t('actionFailed');
    },
    [lang, loadRefusals, t]
  );

  const putGift = useCallback((gift: GiftView) => {
    setGifts((list) => (list ? list.map((g) => (g.id === gift.id ? gift : g)) : list));
  }, []);

  const fail = useCallback(
    async (id: string, err: unknown) => {
      const text = await sentence(err);
      setErrors((e) => ({ ...e, [id]: text }));
      if (err instanceof ApiError && STALE_CODES.has(err.code ?? '')) void load({ silent: true });
    },
    [load, sentence]
  );

  const choose = useCallback(
    async (gift: GiftView, itemId: string): Promise<boolean> => {
      const ok = await run(gift.id, async () => {
        try {
          const res = await api.post<{ gift?: GiftView }>(`/api/gifts/${encodeURIComponent(gift.id)}/choose`, { itemId });
          if (res?.gift && typeof res.gift === 'object') putGift(res.gift);
          void load({ silent: true });
          return true;
        } catch (err) {
          await fail(gift.id, err);
          return false;
        }
      });
      return ok ?? false;
    },
    [fail, load, putGift, run]
  );

  const redeem = useCallback(
    async (gift: GiftView): Promise<void> => {
      await run(gift.id, async () => {
        try {
          const res = await api.post<{ gift?: GiftView }>(`/api/gifts/${encodeURIComponent(gift.id)}/redeem`, {});
          if (res?.gift && typeof res.gift === 'object') putGift(res.gift);
          setConfirming(null);
          void load({ silent: true });
        } catch (err) {
          setConfirming(null);
          await fail(gift.id, err);
        }
      });
    },
    [fail, load, putGift, run]
  );

  const redeemLegacy = useCallback(
    async (gift: LegacyGift, level: number, options: Record<string, string>): Promise<void> => {
      await run(gift.id, async () => {
        try {
          await api.post(`/api/gifts/${encodeURIComponent(gift.id)}/redeem`, { level, options });
          await load({ silent: true });
        } catch (err) {
          await fail(gift.id, err);
        }
      });
    },
    [fail, load, run]
  );

  const addToCart = useCallback(
    async (gift: GiftView, replaceCart = false): Promise<void> => {
      await run(gift.id, async () => {
        try {
          // Nothing but the gift travels: the server derives the product, the
          // selection, the sale type and the price (0) itself. The answer is
          // the cart, so the badge updates on its own.
          await api.post('/api/cart/gift-items', replaceCart ? { giftId: gift.id, replaceCart: true } : { giftId: gift.id });
          setConflict(null);
          setNotices((n) => ({ ...n, [gift.id]: t('added') }));
          await load({ silent: true });
        } catch (err) {
          const code = err instanceof ApiError ? err.code ?? '' : '';
          if (!replaceCart && code === 'CART_SHIPPING_CONFLICT') {
            setConflict({ kind: 'shipping', gift });
            return;
          }
          if (!replaceCart && code === 'CART_SELLER_CONFLICT') {
            setConflict({ kind: 'seller', gift });
            return;
          }
          setConflict(null);
          await fail(gift.id, err);
        }
      });
    },
    [fail, load, run, t]
  );

  const sorted = gifts ? sortGifts(gifts) : [];
  const empty = !!gifts && gifts.length === 0;
  const conflictBusy = conflict ? !!busy[conflict.gift.id] : false;

  return (
    <div dir={dir} className="mx-auto w-full max-w-3xl space-y-4" data-my-gifts>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-[19px] font-bold text-text-primary">
            <Gift aria-hidden="true" className="w-5 h-5 shrink-0 text-gold" />
            {t('title')}
          </h1>
          <p className="mt-0.5 text-[13px] leading-relaxed text-text-muted">{t('intro')}</p>
        </div>
        <IconButton
          label={t('refresh')}
          variant="secondary"
          onClick={() => load({ silent: !!gifts })}
          icon={<RefreshCw aria-hidden="true" className={`w-4 h-4 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`} />}
        />
      </div>

      {loading && !gifts && !loadError && (
        <SkeletonGroup label={t('loading')} className="space-y-4">
          <Skeleton className="h-40 rounded-2xl" />
          <Skeleton className="h-40 rounded-2xl" />
        </SkeletonGroup>
      )}

      {!gifts && loadError != null && <ErrorState error={loadError} onRetry={() => load()} next="/gifts" />}

      {empty && (
        <EmptyState
          icon={<Gift aria-hidden="true" className="w-6 h-6" />}
          title={t('emptyTitle')}
          description={t('emptyBody')}
          action={
            <Link to="/orders" className="lv-button lv-button-secondary">
              {t('emptyAction')}
            </Link>
          }
        />
      )}

      {sorted.map((gift) =>
        gift.status === 'LEGACY' && gift.legacy ? (
          <LegacyGiftCard
            key={gift.id}
            lang={lang}
            gift={gift.legacy as LegacyGift}
            busy={!!busy[gift.id]}
            error={errors[gift.id]}
            onRedeem={redeemLegacy}
          />
        ) : (
          <GiftCard
            key={gift.id}
            lang={lang}
            gift={gift}
            money={money}
            busy={!!busy[gift.id]}
            error={errors[gift.id]}
            notice={notices[gift.id]}
            onChoose={choose}
            onRedeem={(g) => setConfirming(g)}
            onAddToCart={(g) => addToCart(g)}
          />
        )
      )}

      <ConfirmDialog
        open={!!confirming}
        title={t('confirmTitle')}
        consequence={t('confirmBody')}
        confirmLabel={t('confirmAction')}
        cancelLabel={t('cancel')}
        busy={confirming ? !!busy[confirming.id] : false}
        onConfirm={() => (confirming ? redeem(confirming) : undefined)}
        onCancel={() => setConfirming(null)}
        testId="gift-redeem-confirm"
      />

      {/* The server refused the add (CART_SHIPPING_CONFLICT / CART_SELLER_CONFLICT):
          the cart is emptied only when the customer says so here. One dialog for
          both, already loaded for the redeem confirmation. */}
      <ConfirmDialog
        open={!!conflict}
        title={t(conflict?.kind === 'seller' ? 'sellerConflictTitle' : 'shippingConflictTitle')}
        consequence={t(conflict?.kind === 'seller' ? 'sellerConflictBody' : 'shippingConflictBody')}
        confirmLabel={t('replaceCart')}
        cancelLabel={t('cancel')}
        destructive
        busy={conflictBusy}
        onConfirm={() => (conflict ? addToCart(conflict.gift, true) : undefined)}
        onCancel={() => setConflict(null)}
        testId={conflict?.kind === 'seller' ? 'gift-seller-conflict' : 'gift-shipping-conflict'}
      />
    </div>
  );
}
