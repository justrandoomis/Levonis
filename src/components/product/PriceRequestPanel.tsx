/**
 * «طلب السعر» — THE REQUEST BLOCK OF A PRODUCT OR SELECTION WITH NO PRICE YET
 * (DECISIONS rows 239 (4) and 240, spec §6.2).
 *
 * A LAZY CHUNK. The product page mounts it only when the product is
 * catalog-only or the chosen SKU has no V2 price, so a priced page never pays
 * for it (tests/bundleBudget.test.ts keeps it out of the product opening).
 *
 * WHAT IT DOES, AND WHAT IT NEVER DOES. It asks the signed-in customer's own
 * rows once (`GET /api/price-requests/mine?product_id=`, `private, no-store`,
 * so no shared cache and no first-screen wave changes), and writes through
 * three doors: POST to ask, PATCH to change the notify consent, DELETE to
 * withdraw. A request touches no order, cart, wallet or stock table, and the
 * server counts a person once per product and once per selection however many
 * times they tap — the button is replaced by «طلبت السعر» anyway. Counts are
 * never shown to a customer (default D11).
 *
 * SIGNED OUT, NOTHING IS SENT. The button opens a sheet that sends the
 * customer to /auth with the selection in `?price_request=`; back on the page
 * the selection is pre-chosen from that UNTRUSTED parameter and the customer
 * taps again (the «خبرني لما يرجع» pattern).
 *
 * WHERE IT SITS. On a phone the full-width 48 px button takes the sticky buy
 * bar's place (the page hands its bar slot in `barSlot`) and the switch stays
 * in the page above; on a desktop the whole block sits in the price card.
 * House primitives and tokens only (clay, rows 207-210).
 */
import React, { useCallback, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Check, Tag } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api, ApiError } from '../../lib/api';
import { authPathWithSupportRef } from '../../lib/supportRef';
import { Switch } from '../ui/Switch';
import { Sheet } from '../ui/Overlay';
import Spinner from '../ui/Spinner';
import { alertRefusalText } from './stockAlertTargets';
import { priceRequestView, productPathWithPriceIntent, withRow, type PriceRequestRow } from './priceRequestState';

type Lang = 'ar' | 'en' | 'ckb';

/** Every word of the block, in Arabic, English and Sorani (never the Arabic copied, row 183). */
export const PRICE_REQUEST_TEXT = {
  ar: {
    request: 'طلب السعر',
    chooseFirst: 'اختر الخيارات أولاً لطلب سعرها',
    signInTitle: 'سجّل الدخول لطلب السعر',
    signInBody: 'نحسب كل شخص مرة واحدة ونخبرك عند توفر السعر.',
    signIn: 'تسجيل الدخول',
    notifyMe: 'أخبرني عندما يتوفر السعر',
    requested: 'طلبت السعر',
    willTell: 'سنخبرك عندما يتوفر السعر.',
    recorded: 'سُجّل طلبك.',
    withdraw: 'سحب الطلب',
    close: 'إغلاق',
    failed: 'تعذّر إرسال الطلب. حاول مجدداً.',
  },
  en: {
    request: 'Request price',
    chooseFirst: 'Choose the options first to request their price',
    signInTitle: 'Sign in to request the price',
    signInBody: 'We count each person once and tell you when the price is ready.',
    signIn: 'Sign in',
    notifyMe: 'Notify me when the price is available',
    requested: 'Price requested',
    willTell: 'We will let you know when the price is ready.',
    recorded: 'Your request is recorded.',
    withdraw: 'Withdraw request',
    close: 'Close',
    failed: 'The request could not be sent. Try again.',
  },
  ckb: {
    request: 'داوای نرخ بکە',
    chooseFirst: 'سەرەتا هەڵبژاردنەکان دیاری بکە بۆ داواکردنی نرخەکەیان',
    signInTitle: 'بۆ داواکردنی نرخ بچۆ ژوورەوە',
    signInBody: 'هەر کەسێک تەنها یەک جار دەژمێرین و کاتێک نرخ ئامادە بوو ئاگادارت دەکەینەوە.',
    signIn: 'چوونەژوورەوە',
    notifyMe: 'ئاگادارم بکەرەوە کاتێک نرخ بەردەست بوو',
    requested: 'داوای نرخت کردووە',
    willTell: 'کاتێک نرخ ئامادە بوو ئاگادارت دەکەینەوە.',
    recorded: 'داواکارییەکەت تۆمار کرا.',
    withdraw: 'کشاندنەوەی داواکاری',
    close: 'داخستن',
    failed: 'داواکارییەکە نەنێردرا. دووبارە هەوڵ بدەرەوە.',
  },
} as const;

export interface PriceRequestPanelProps {
  productId: string;
  productSlug: string;
  /** The page body's `price_status`. */
  productStatus: 'priced' | 'unpriced';
  /** A priced product whose chosen SKU has no V2 price. */
  selectionUnpriced: boolean;
  /** `skuComboKey` of the current selection. */
  selectionKey: string;
  optionValueIds: readonly string[];
  colorId: string;
  /** Every required option group and colour is chosen. */
  selectionComplete: boolean;
  isAuthenticated: boolean;
  /** The phone's bottom-bar slot: the button is drawn there. Null on a desktop. */
  barSlot: HTMLElement | null;
  /** The server says this selection has a price now (409 ALREADY_PRICED, or a 404 after a sweep): reload the page body. */
  onPriced: () => void;
}

export default function PriceRequestPanel({
  productId,
  productSlug,
  productStatus,
  selectionUnpriced,
  selectionKey,
  optionValueIds,
  colorId,
  selectionComplete,
  isAuthenticated,
  barSlot,
  onPriced,
}: PriceRequestPanelProps) {
  const { lang } = useLanguage();
  const L: Lang = lang === 'en' || lang === 'ckb' ? lang : 'ar';
  const s = PRICE_REQUEST_TEXT[L];
  const navigate = useNavigate();
  const helperId = useId();
  const [mine, setMine] = useState<PriceRequestRow[] | null>(null);
  const [reload, setReload] = useState(0);
  // Default D10: consent is visible and ON before the first tap; the server stores exactly what is sent.
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState<'' | 'send' | 'notify' | 'withdraw'>('');
  const [error, setError] = useState('');
  const [signInOpen, setSignInOpen] = useState(false);
  // Mounted on the first open and kept, so it can animate closed (the page's `cheaperStarted` pattern).
  const [signInStarted, setSignInStarted] = useState(false);
  const openSignIn = useCallback(() => {
    setSignInStarted(true);
    setSignInOpen(true);
  }, []);

  // The caller's own rows, once per product (and again after a 404 says they moved).
  useEffect(() => {
    setMine(null);
    if (!isAuthenticated) return;
    let cancelled = false;
    api
      .get<{ requests?: PriceRequestRow[] }>(`/api/price-requests/mine?product_id=${encodeURIComponent(productId)}`)
      .then((r) => {
        if (!cancelled) setMine(Array.isArray(r.requests) ? r.requests : []);
      })
      .catch(() => {
        // Unreadable (or 0193 not on this database yet): the button still works, and its answer says why if not.
        if (!cancelled) setMine([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, productId, reload]);

  // A new selection starts clean: an error belonged to the previous one.
  useEffect(() => setError(''), [selectionKey]);

  const view = priceRequestView({
    productStatus,
    selectionUnpriced,
    selectionComplete,
    authenticated: isAuthenticated,
    mine,
    selectionKey,
  });

  const toSignIn = useCallback(() => {
    navigate(authPathWithSupportRef(productPathWithPriceIntent(productSlug, selectionKey)));
  }, [navigate, productSlug, selectionKey]);

  const fail = useCallback(
    async (e: unknown) => {
      const code = e instanceof ApiError ? e.code ?? '' : '';
      if (e instanceof ApiError && e.status === 401) {
        openSignIn();
        return;
      }
      if (code === 'PRICE_REQUEST_ALREADY_PRICED') {
        onPriced();
        return;
      }
      if (e instanceof ApiError && e.status === 404) {
        // Withdrawn elsewhere, or a sweep priced it a moment ago: read the truth again.
        setReload((n) => n + 1);
        onPriced();
        return;
      }
      if (code === 'RATE_LIMITED' || (e instanceof ApiError && e.status === 429)) {
        setError(alertRefusalText({ code: 'RATE_LIMITED' }, L, s.failed));
        return;
      }
      try {
        const { refusalText } = await import('../../lib/refusalStrings');
        setError(refusalText(code, L, s.failed));
      } catch {
        setError(s.failed);
      }
    },
    [L, s.failed, onPriced, openSignIn]
  );

  if (view.kind === 'none') return null;

  const send = async () => {
    if (busy) return;
    if (view.kind === 'choose' || view.kind === 'loading') return;
    if (view.kind === 'signed_out') {
      openSignIn();
      return;
    }
    setBusy('send');
    setError('');
    try {
      const res = await api.post<{ request: PriceRequestRow }>('/api/price-requests', {
        product_id: productId,
        ...(optionValueIds.length ? { option_value_ids: [...optionValueIds] } : {}),
        ...(colorId ? { color_id: colorId } : {}),
        notify,
      });
      setMine((rows) => withRow(rows, { ...res.request, selection: res.request.selection ?? selectionKey, state: 'open' }));
    } catch (e) {
      await fail(e);
    } finally {
      setBusy('');
    }
  };

  const request = view.kind === 'requested' ? view.request : null;

  const changeNotify = async (next: boolean) => {
    if (!request || busy) return;
    setBusy('notify');
    setError('');
    try {
      const res = await api.patch<{ request: { id: string; notify: boolean } }>(`/api/price-requests/${encodeURIComponent(request.id)}`, { notify: next });
      setMine((rows) => withRow(rows, { ...request, notify: !!res.request.notify }));
    } catch (e) {
      await fail(e);
    } finally {
      setBusy('');
    }
  };

  const withdraw = async () => {
    if (!request || busy) return;
    setBusy('withdraw');
    setError('');
    try {
      await api.delete(`/api/price-requests/${encodeURIComponent(request.id)}`);
      setMine((rows) => withRow(rows, { ...request, state: 'closed' }));
    } catch (e) {
      await fail(e);
    } finally {
      setBusy('');
    }
  };

  const blocked = view.kind === 'choose' || view.kind === 'loading';
  const cta = request ? (
    <p
      data-price-request-done
      className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-border-subtle bg-surface-selected px-4 text-[14px] font-bold text-text-primary"
    >
      <Check aria-hidden="true" className="size-4 shrink-0 text-success" />
      {s.requested}
    </p>
  ) : (
    <button
      type="button"
      data-price-request-cta={view.kind}
      onClick={() => void send()}
      aria-disabled={blocked || undefined}
      aria-busy={busy === 'send' || undefined}
      aria-describedby={view.kind === 'choose' ? helperId : undefined}
      aria-haspopup={view.kind === 'signed_out' ? 'dialog' : undefined}
      className="lv-button lv-button-primary min-h-12 w-full text-[15px] aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
    >
      {busy === 'send' || view.kind === 'loading' ? <Spinner size="sm" delayMs={0} decorative /> : <Tag aria-hidden="true" className="size-4" />}
      {s.request}
    </button>
  );

  return (
    <div data-price-request={view.kind} className="space-y-2.5">
      {request ? (
        <>
          <div role="status" aria-live="polite" className="min-w-0">
            <p className="flex items-center gap-2 text-[14px] font-bold text-text-primary">
              <Check aria-hidden="true" className="size-4 shrink-0 text-success" />
              {s.requested}
            </p>
            <p className="mt-0.5 ps-6 text-[12.5px] leading-relaxed text-text-secondary">{request.notify ? s.willTell : s.recorded}</p>
          </div>
          <Switch checked={request.notify} onChange={(next) => void changeNotify(next)} label={s.notifyMe} busy={busy === 'notify'} />
          <button
            type="button"
            data-price-request-withdraw
            onClick={() => void withdraw()}
            aria-busy={busy === 'withdraw' || undefined}
            className="lv-button lv-button-ghost lv-button-sm -ms-2 text-text-secondary"
          >
            {busy === 'withdraw' ? <Spinner size="sm" delayMs={0} decorative /> : null}
            {s.withdraw}
          </button>
        </>
      ) : (
        <>
          {view.kind === 'choose' ? (
            <p id={helperId} className="text-[12.5px] leading-relaxed text-text-secondary">
              {s.chooseFirst}
            </p>
          ) : null}
          {view.kind === 'ready' || view.kind === 'loading' ? (
            <Switch checked={notify} onChange={setNotify} label={s.notifyMe} disabled={view.kind === 'loading'} />
          ) : null}
        </>
      )}

      {/* The 48 px action: in the phone's bottom bar when the page gives one, here otherwise. Once
          requested, the status line above IS the replacement here; only the bar keeps a chip in its place. */}
      {barSlot ? createPortal(cta, barSlot) : request ? null : cta}

      {error ? (
        <p role="alert" className="text-[12.5px] font-medium leading-relaxed text-danger">
          {error}
        </p>
      ) : null}

      {signInStarted ? (
      <Sheet
        open={signInOpen}
        onClose={() => setSignInOpen(false)}
        label={s.signInTitle}
        panelClassName="w-full sm:max-w-md"
        testId="price-request-signin"
      >
        <div className="px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-2">
          <h2 className="text-[16px] font-bold leading-snug text-text-primary">{s.signInTitle}</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-text-secondary">{s.signInBody}</p>
          <button type="button" onClick={toSignIn} data-price-request-signin className="lv-button lv-button-primary mt-4 min-h-12 w-full">
            {s.signIn}
          </button>
          <button type="button" onClick={() => setSignInOpen(false)} className="lv-button lv-button-ghost mt-2 w-full">
            {s.close}
          </button>
        </div>
      </Sheet>
      ) : null}
    </div>
  );
}
