/**
 * «أضف إلى السلة» FOR A GIFT — the one door every screen that adds a gift uses: «هداياي»
 * and the points shop (DECISIONS row 299). Nothing but the gift travels: the server derives
 * the product, the selection, the sale type and the price (0) itself, and its answer is the
 * cart, so the badge updates on its own.
 *
 * A cart that cannot hold the gift (another seller, another shipping type) is refused by the
 * server; the cart is emptied only when the customer says so in this one dialog.
 *
 * `useGiftRefusalSentence` turns any refusal into the customer's sentence: network and rate
 * first, then the code's own sentence. The table in src/lib/refusalStrings.ts is loaded on
 * the first refusal only, so a page does not carry it up front.
 */
import { useCallback, useRef, useState } from 'react';
import { api, ApiError } from '../../../lib/api';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { giftText, type GiftLang } from './giftStrings';

type Refusals = typeof import('../../../lib/refusalStrings');
type Conflict = { kind: 'shipping' | 'seller'; giftId: string };

export function useGiftRefusalSentence(lang: GiftLang): (err: unknown) => Promise<string> {
  const refusalsLoad = useRef<Promise<Refusals | null> | null>(null);
  /** The refusal table, fetched once, on the first refusal. */
  const loadRefusals = useCallback((): Promise<Refusals | null> => {
    if (!refusalsLoad.current) {
      refusalsLoad.current = import('../../../lib/refusalStrings').then(
        (m) => m,
        () => {
          refusalsLoad.current = null;
          return null;
        }
      );
    }
    return refusalsLoad.current;
  }, []);
  return useCallback(
    async (err: unknown): Promise<string> => {
      if (err instanceof ApiError && err.status === 0) return giftText(lang, 'networkError');
      if (err instanceof ApiError && err.status === 429) return giftText(lang, 'tooManyTries');
      const table = await loadRefusals();
      const failed = giftText(lang, 'actionFailed');
      return table ? table.apiRefusal(err, lang, failed) || failed : failed;
    },
    [lang, loadRefusals]
  );
}

export function useGiftCartAdd({
  lang,
  run,
  onAdded,
  onRefused,
}: {
  lang: GiftLang;
  /** The caller's own guard around the request («هداياي»: one action per card). */
  run?: <T>(giftId: string, action: () => Promise<T>) => Promise<T | undefined>;
  onAdded: (giftId: string) => void | Promise<void>;
  /** Any refusal but the two this hook asks about. */
  onRefused: (giftId: string, err: unknown) => void | Promise<void>;
}) {
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [busy, setBusy] = useState(false);

  const add = useCallback(
    async (giftId: string, replaceCart = false): Promise<void> => {
      const request = async () => {
        setBusy(true);
        try {
          await api.post('/api/cart/gift-items', replaceCart ? { giftId, replaceCart: true } : { giftId });
          setConflict(null);
          await onAdded(giftId);
        } catch (err) {
          const code = err instanceof ApiError ? err.code ?? '' : '';
          if (!replaceCart && code === 'CART_SHIPPING_CONFLICT') {
            setConflict({ kind: 'shipping', giftId });
            return;
          }
          if (!replaceCart && code === 'CART_SELLER_CONFLICT') {
            setConflict({ kind: 'seller', giftId });
            return;
          }
          setConflict(null);
          await onRefused(giftId, err);
        } finally {
          setBusy(false);
        }
      };
      if (run) await run(giftId, request);
      else await request();
    },
    [onAdded, onRefused, run]
  );

  const dialog = (
    <ConfirmDialog
      open={!!conflict}
      title={giftText(lang, conflict?.kind === 'seller' ? 'sellerConflictTitle' : 'shippingConflictTitle')}
      consequence={giftText(lang, conflict?.kind === 'seller' ? 'sellerConflictBody' : 'shippingConflictBody')}
      confirmLabel={giftText(lang, 'replaceCart')}
      cancelLabel={giftText(lang, 'cancel')}
      destructive
      busy={busy}
      onConfirm={() => (conflict ? add(conflict.giftId, true) : undefined)}
      onCancel={() => setConflict(null)}
      testId={conflict?.kind === 'seller' ? 'gift-seller-conflict' : 'gift-shipping-conflict'}
    />
  );

  return { add, busy, dialog };
}
