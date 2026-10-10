/**
 * Price protection (returns.ts §6.8): within seven days of delivery, a
 * price drop on a bought item can be claimed and the difference credited to
 * the wallet after review.
 *
 * The CLAIM is one request — POST /api/price-protection/claims { orderItemId }
 * — and the server does every comparison. This section lists what already
 * exists for the order, offers the button while the window is open, and
 * shows the server's refusal word for word when it declines (no drop found,
 * window closed, claim already pending).
 */
import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, Clock } from 'lucide-react';
import { api } from '../../lib/api';
import type { ApiOrder } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import Spinner from '../ui/Spinner';
import { asLang, daysLeftLabel, formatDate } from './format';
import { apiRefusal } from '../../lib/refusalStrings';
import { useMoney } from '../../CurrencyContext';
import { StatusChip } from '../ui/Badge';

interface Claim {
  id: string;
  order_id: string;
  order_item_id: string;
  original_unit_iqd: number;
  observed_unit_iqd: number;
  qty: number;
  credited_iqd: number;
  /** Owner decision 6: what the claim covers per unit when part of the fall came from the exchange rate. */
  eligible_unit_iqd?: number | null;
  state: 'requested' | 'approved' | 'rejected' | 'credited' | string;
  requested_at: string;
  decided_at: string | null;
  item?: { name: string; variant: string };
}

const WINDOW_MS = 7 * 86_400_000;

const STRINGS = {
  ar: {
    title: 'حماية السعر',
    intro: 'إذا انخفض سعر منتج اشتريته خلال 7 أيام من التسليم، يمكنك المطالبة بالفرق ليُقيَّد في محفظتك بعد المراجعة.',
    loading: 'جارٍ تحميل المطالبات…',
    loadError: 'تعذر تحميل مطالبات حماية السعر.',
    retry: 'إعادة المحاولة',
    claim: 'مطالبة',
    claiming: 'جارٍ الإرسال…',
    pending: 'مطالبة قيد المراجعة',
    closed: 'انتهت نافذة حماية السعر (7 أيام من التسليم).',
    states: { requested: 'قيد المراجعة', approved: 'مقبولة', rejected: 'مرفوضة', credited: 'قُيِّدت' } as Record<string, string>,
    paid: 'دفعت',
    observed: 'السعر الملاحَظ',
    credited: 'المقيَّد',
    requestedAt: 'قُدِّمت في',
    covered: (n: string) => `المشمول: ${n} — والباقي من تغيّر سعر الصرف`,
  },
  en: {
    title: 'Price protection',
    intro: 'If the price of an item you bought drops within 7 days of delivery, you can claim the difference — credited to your wallet after review.',
    loading: 'Loading claims…',
    loadError: 'Price-protection claims could not be loaded.',
    retry: 'Retry',
    claim: 'Claim',
    claiming: 'Submitting…',
    pending: 'Claim under review',
    closed: 'The 7-day price-protection window (from delivery) has closed.',
    states: { requested: 'Under review', approved: 'Approved', rejected: 'Rejected', credited: 'Credited' } as Record<string, string>,
    paid: 'You paid',
    observed: 'Observed price',
    credited: 'Credited',
    requestedAt: 'Requested',
    covered: (n: string) => `Covered: ${n} — the rest came from the exchange rate`,
  },
  ckb: {
    title: 'پاراستنی نرخ',
    intro: 'ئەگەر نرخی کاڵایەک کە کڕیوتە لە ماوەی ٧ ڕۆژ لە گەیاندن دابەزێت، دەتوانیت داوای جیاوازییەکە بکەیت — دوای پێداچوونەوە بۆ جزدانەکەت.',
    loading: 'بارکردنی داواکان…',
    loadError: 'داواکانی پاراستنی نرخ بار نەکران.',
    retry: 'هەوڵدانەوە',
    claim: 'داواکردن',
    claiming: 'ناردن…',
    pending: 'داوا لە پێداچوونەوەدایە',
    closed: 'ماوەی پاراستنی نرخ (٧ ڕۆژ لە گەیاندن) تەواو بووە.',
    states: { requested: 'لە پێداچوونەوەدایە', approved: 'پەسەندکراوە', rejected: 'ڕەتکراوەتەوە', credited: 'دراوە' } as Record<string, string>,
    paid: 'دراوە',
    observed: 'نرخی بینراو',
    credited: 'دراوە',
    requestedAt: 'داواکراوە لە',
    covered: (n: string) => `ئەوەی دەگرێتەوە: ${n} — ئەوی تر لە گۆڕانی نرخی ئاڵوگۆڕەوە هات`,
  },
} as const;

export default function PriceProtection({ order }: { order: ApiOrder }) {
  // A price-protection credit lands in the wallet: a WALLET AMOUNT, at the wallet's own rate (Q5; FX-1 review #6).
  const { money, walletMoney } = useMoney();
  const { lang } = useLanguage();
  const s = STRINGS[asLang(lang)];
  const delivered = order.status === 'delivered';
  const deliveredMs = order.delivered_at ? Date.parse(order.delivered_at) : NaN;
  const daysLeft = Number.isFinite(deliveredMs) ? Math.max(0, Math.ceil((deliveredMs + WINDOW_MS - Date.now()) / 86_400_000)) : null;
  const windowOpen = daysLeft !== null && daysLeft > 0;

  const [claims, setClaims] = useState<Claim[] | null>(null);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoadState('loading');
    try {
      const res = await api.get<{ claims: Claim[] }>('/api/price-protection/claims');
      setClaims((res.claims || []).filter((c) => c.order_id === order.id));
      setLoadState('idle');
    } catch {
      setLoadState('failed');
    }
  }, [order.id]);

  useEffect(() => {
    if (delivered) load();
  }, [delivered, load]);

  const claimFor = async (orderItemId: string) => {
    if (busyItem) return;
    setBusyItem(orderItemId);
    setErrors((e) => ({ ...e, [orderItemId]: '' }));
    try {
      await api.post('/api/price-protection/claims', { orderItemId });
      await load();
    } catch (e) {
      setErrors((prev) => ({ ...prev, [orderItemId]: apiRefusal(e, asLang(lang), s.loadError) }));
    } finally {
      setBusyItem(null);
    }
  };

  if (!delivered) return null;
  // Nothing to say when the window is closed and no claim was ever filed —
  // the section does not appear only to announce its own absence.
  if (!windowOpen && (claims === null || claims.length === 0) && loadState !== 'loading') return null;

  return (
    <section className="lv-surface p-4" aria-labelledby="pp-title" data-price-protection>
      <h3 id="pp-title" className="text-text-primary font-bold text-[14px] inline-flex items-center gap-1.5">
        <ShieldCheck className="w-4 h-4 text-gold" aria-hidden />
        {s.title}
      </h3>
      <p className="text-text-muted text-[12px] mt-1 leading-relaxed">{s.intro}</p>
      <p className={`mt-2 text-[12px] inline-flex items-center gap-1.5 ${windowOpen ? 'text-emerald-300' : 'text-text-muted'}`}>
        <Clock className="w-3.5 h-3.5" aria-hidden />
        {windowOpen && daysLeft !== null ? daysLeftLabel(daysLeft, lang) : s.closed}
      </p>

      <div role="status" aria-live="polite" className="mt-3">
        {loadState === 'loading' && claims === null && (
          <p className="text-text-muted text-[12px] inline-flex items-center gap-2">
            <Spinner size="xs" delayMs={0} decorative /> {s.loading}
          </p>
        )}
        {loadState === 'failed' && (
          <p className="text-red-400 text-[12px]">
            {s.loadError}{' '}
            <button type="button" onClick={load} className="underline font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold rounded">
              {s.retry}
            </button>
          </p>
        )}
        {claims && claims.length > 0 && (
          <ul className="flex flex-col gap-2">
            {claims.map((c) => (
              <li key={c.id} data-pp-claim={c.state} className="rounded-lg bg-surface-raised p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-[12.5px] text-text-primary truncate min-w-0">
                    {c.item?.name ?? c.order_item_id} × {c.qty}
                  </p>
                  <StatusChip
                    className="shrink-0"
                    tone={c.state === 'rejected' ? 'danger' : c.state === 'credited' || c.state === 'approved' ? 'success' : 'neutral'}
                  >
                    {s.states[c.state] ?? c.state}
                  </StatusChip>
                </div>
                <p className="mt-1 text-[11.5px] text-text-muted tabular-nums">
                  {s.paid} {money(c.original_unit_iqd)} · {s.observed} {money(c.observed_unit_iqd)}
                  {c.credited_iqd > 0 && ` · ${s.credited} ${walletMoney(c.credited_iqd)}`}
                  {' · '}
                  {s.requestedAt} {formatDate(c.requested_at, lang)}
                </p>
                {/* Owner decision 6 (policy v5 §11.8): a part of the fall that was only the exchange rate is not covered. */}
                {typeof c.eligible_unit_iqd === 'number' && c.eligible_unit_iqd < c.original_unit_iqd - c.observed_unit_iqd && (
                  <p className="mt-1 text-[11.5px] text-amber-300/90 tabular-nums" data-pp-covered>
                    {s.covered(money(c.eligible_unit_iqd))}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {windowOpen && (
        <ul className="mt-3 flex flex-col gap-2">
          {order.items.map((it) => {
            const pending = claims?.some((c) => c.order_item_id === it.id && c.state === 'requested');
            const err = errors[it.id];
            return (
              <li key={it.id} className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-[12.5px] text-text-secondary truncate min-w-0">{it.name}</p>
                {pending ? (
                  <span className="shrink-0 text-[11.5px] text-text-muted">{s.pending}</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => claimFor(it.id)}
                    disabled={busyItem !== null || !it.product_id}
                    data-pp-claim-item={it.id}
                    className="lv-button lv-button-secondary lv-button-sm shrink-0"
                  >
                    {busyItem === it.id && <Spinner size="xs" delayMs={0} decorative />}
                    {busyItem === it.id ? s.claiming : s.claim}
                  </button>
                )}
                {err && (
                  <p role="alert" className="basis-full text-red-400 text-[12px]">
                    {err}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
