import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Gift, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { IconButton } from '../ui/Button';
import { Skeleton, SkeletonGroup } from '../ui/Skeleton';
import { EmptyState, ErrorState } from '../ui/AsyncStates';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import ShippingConflictDialog from '../cart/ShippingConflictDialog';
import GiftCard, { PendingGiftCard, sortGifts, type GiftPick, type GiftView, type PendingGiftView } from './gifts/GiftCard';
import { giftLang, giftText, type GiftStringKey } from './gifts/giftStrings';

/**
 * /gifts — THE CUSTOMER'S PRINTER-REVIEW GIFTS (docs/REVIEWS_GIFTS.md §2, §6.2, §8 C3).
 *
 * The lifecycle is the server's: `GET /api/reviews/gifts` answers one
 * `ui_state` per gift (and the quiet `pending` rows of reviews still awaiting
 * the admin), and this page draws one card per state. Every action is one
 * request and then a fresh read of that same answer:
 *
 *   code issued ──«استرداد الهدية» (POST …/redeem {code})──► choose / ready
 *   choose      ──«تأكيد الاختيار» (POST …/choose)──────────► ready
 *   ready       ──«أضف الهدية إلى السلة» (POST /api/cart/gift-items)──► in cart
 *   in cart → ordered → delivered happen in the cart, the checkout and the order.
 *
 * Nothing here decides a state, a price or a relation. A failed code reads ONE
 * generic sentence whatever the reason (the server answers every failure with
 * the same code, so a stranger learns nothing). The refusal sentences live in
 * src/lib/refusalStrings.ts and are loaded on the first refusal only, so the
 * page does not carry that table up front; and nothing here imports the phone
 * library (the code boxes take their digits from src/lib/localeNumber).
 */

type Refusals = typeof import('../../lib/refusalStrings');

interface GiftsPayload {
  gifts: GiftView[];
  pending: PendingGiftView[];
}

type Conflict =
  | { kind: 'shipping'; gift: GiftView; cartType: unknown; incomingType: unknown }
  | { kind: 'seller'; gift: GiftView };

/** A refusal that means the card on screen is out of date — the next read shows the truth. */
const STALE_CODES = new Set([
  'GIFT_NOT_FOUND',
  'GIFT_NOT_REDEEMED',
  'GIFT_IN_CART',
  'GIFT_ALREADY_ORDERED',
  'GIFT_CHOICE_REQUIRED',
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
  const t = useCallback((key: GiftStringKey) => giftText(lang, key), [lang]);

  const [data, setData] = useState<GiftsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [refusals, setRefusals] = useState<Refusals | null>(null);

  const busyRef = useRef(new Set<string>());
  const loadSeq = useRef(0);
  const aborter = useRef<AbortController | null>(null);
  const refusalsLoad = useRef<Promise<Refusals | null> | null>(null);

  /** The refusal table, fetched once, on the first refusal (or the first gift that cannot be ordered). */
  const loadRefusals = useCallback((): Promise<Refusals | null> => {
    if (!refusalsLoad.current) {
      refusalsLoad.current = import('../../lib/refusalStrings').then(
        (m) => {
          setRefusals(m);
          return m;
        },
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
    // Its own request every time (a signal opts out of GET coalescing): a read
    // that started BEFORE an action committed must never answer for after it.
    aborter.current?.abort();
    const controller = new AbortController();
    aborter.current = controller;
    if (!opts?.silent) {
      setLoading(true);
      setLoadError(null);
    }
    try {
      const res = await api.get<{ gifts?: GiftView[]; pending?: PendingGiftView[] }>('/api/reviews/gifts', {
        signal: controller.signal,
      });
      if (seq !== loadSeq.current) return;
      setData({
        gifts: Array.isArray(res.gifts) ? res.gifts : [],
        pending: Array.isArray(res.pending) ? res.pending : [],
      });
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

  // A gift the server says cannot be ordered right now names its reason in
  // the customer's words — which needs the table, so it is fetched here.
  const needsReasons = !!data?.gifts.some((g) => g.orderable && g.orderable.ok === false && g.orderable.code);
  useEffect(() => {
    if (needsReasons) void loadRefusals();
  }, [needsReasons, loadRefusals]);

  const orderableText = useCallback(
    (code: string) => (refusals ? refusals.refusalText(code, lang, '') : ''),
    [refusals, lang]
  );

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
    async (err: unknown, onlyCode?: string): Promise<string> => {
      if (err instanceof ApiError && err.status === 0) return t('networkError');
      if (err instanceof ApiError && err.status === 429) return t('tooManyTries');
      const table = await loadRefusals();
      const code = onlyCode ?? (err instanceof ApiError ? err.code ?? '' : '');
      return table ? table.refusalText(code, lang, t('actionFailed')) || t('actionFailed') : t('actionFailed');
    },
    [lang, loadRefusals, t]
  );

  const putGift = useCallback((gift: GiftView) => {
    setData((d) => (d ? { ...d, gifts: d.gifts.map((g) => (g.id === gift.id ? gift : g)) } : d));
  }, []);

  const redeem = useCallback(
    async (gift: GiftView, code: string): Promise<boolean> => {
      const ok = await run(gift.id, async () => {
        try {
          const res = await api.post<{ gift?: GiftView }>(`/api/reviews/gifts/${encodeURIComponent(gift.id)}/redeem`, { code });
          if (res && res.gift && typeof res.gift === 'object') putGift(res.gift);
          void load({ silent: true });
          return true;
        } catch (err) {
          // ONE generic sentence for every refusal — wrong, used, revoked,
          // locked, foreign: the server answers them all alike, and so do we.
          const text = await sentence(err, 'GIFT_CODE_INVALID');
          setErrors((e) => ({ ...e, [gift.id]: text }));
          // A fifth wrong try locks the code: the next read shows that card.
          void load({ silent: true });
          return false;
        }
      });
      return ok ?? false;
    },
    [load, putGift, run, sentence]
  );

  const choose = useCallback(
    async (gift: GiftView, pick: GiftPick): Promise<boolean> => {
      const ok = await run(gift.id, async () => {
        try {
          const body: Record<string, unknown> = { ref: pick.ref };
          if (pick.optionValueIds.length > 0) body.optionValueIds = pick.optionValueIds;
          if (pick.colorId) body.colorId = pick.colorId;
          const res = await api.post<{ gift?: GiftView }>(`/api/reviews/gifts/${encodeURIComponent(gift.id)}/choose`, body);
          if (res && res.gift && typeof res.gift === 'object') putGift(res.gift);
          void load({ silent: true });
          return true;
        } catch (err) {
          const text = await sentence(err);
          setErrors((e) => ({ ...e, [gift.id]: text }));
          if (err instanceof ApiError && STALE_CODES.has(err.code ?? '')) void load({ silent: true });
          return false;
        }
      });
      return ok ?? false;
    },
    [load, putGift, run, sentence]
  );

  const addToCart = useCallback(
    async (gift: GiftView, replaceCart = false): Promise<void> => {
      await run(gift.id, async () => {
        try {
          // Nothing but the entitlement travels: the server derives the
          // product, the selection, the sale type and the price (0) itself.
          // The answer is the cart, so the badge updates on its own.
          await api.post('/api/cart/gift-items', replaceCart ? { entitlementId: gift.id, replaceCart: true } : { entitlementId: gift.id });
          setConflict(null);
          setNotices((n) => ({ ...n, [gift.id]: t('added') }));
          await load({ silent: true });
        } catch (err) {
          const code = err instanceof ApiError ? err.code ?? '' : '';
          if (!replaceCart && code === 'CART_SHIPPING_CONFLICT' && err instanceof ApiError) {
            setConflict({
              kind: 'shipping',
              gift,
              cartType: err.details?.cart_shipping_type,
              incomingType: err.details?.incoming_shipping_type,
            });
            return;
          }
          if (!replaceCart && code === 'CART_SELLER_CONFLICT') {
            setConflict({ kind: 'seller', gift });
            return;
          }
          setConflict(null);
          const text = await sentence(err);
          setErrors((e) => ({ ...e, [gift.id]: text }));
          if (STALE_CODES.has(code)) void load({ silent: true });
        }
      });
    },
    [load, run, sentence, t]
  );

  const clearError = useCallback((id: string) => setErrors((e) => without(e, id)), []);

  const gifts = data ? sortGifts(data.gifts) : [];
  const pending = data?.pending ?? [];
  const empty = !!data && gifts.length === 0 && pending.length === 0;
  const conflictBusy = conflict ? !!busy[conflict.gift.id] : false;

  return (
    <div dir={dir} className="mx-auto w-full max-w-3xl space-y-4" data-my-gifts>
      <div className="flex items-center justify-between gap-3">
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
          onClick={() => load({ silent: !!data })}
          icon={<RefreshCw aria-hidden="true" className={`w-4 h-4 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`} />}
        />
      </div>

      {loading && !data && !loadError && (
        <SkeletonGroup label={t('loading')} className="space-y-4">
          <Skeleton className="h-40 rounded-2xl" />
          <Skeleton className="h-40 rounded-2xl" />
        </SkeletonGroup>
      )}

      {!data && loadError != null && <ErrorState error={loadError} onRetry={() => load()} next="/gifts" />}

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

      {gifts.map((gift) => (
        <GiftCard
          key={gift.id}
          gift={gift}
          busy={!!busy[gift.id]}
          error={errors[gift.id]}
          notice={notices[gift.id]}
          onRedeem={redeem}
          onChoose={choose}
          onAddToCart={(g) => addToCart(g)}
          onEdit={clearError}
          orderableText={orderableText}
        />
      ))}

      {pending.map((p) => (
        <PendingGiftCard key={p.reward_id} pending={p} />
      ))}

      <ShippingConflictDialog
        open={conflict?.kind === 'shipping'}
        lang={rawLang}
        dir={dir}
        cartType={conflict?.kind === 'shipping' ? conflict.cartType : undefined}
        incomingType={conflict?.kind === 'shipping' ? conflict.incomingType : undefined}
        busy={conflictBusy}
        onConfirm={() => {
          if (conflict) void addToCart(conflict.gift, true);
        }}
        onCancel={() => setConflict(null)}
      />

      <ConfirmDialog
        open={conflict?.kind === 'seller'}
        title={t('sellerConflictTitle')}
        consequence={t('sellerConflictBody')}
        confirmLabel={t('replaceCart')}
        cancelLabel={t('cancel')}
        destructive
        busy={conflictBusy}
        onConfirm={() => (conflict ? addToCart(conflict.gift, true) : undefined)}
        onCancel={() => setConflict(null)}
        testId="gift-seller-conflict"
      />
    </div>
  );
}
