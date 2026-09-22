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

interface Claim {
  id: string;
  order_id: string;
  order_item_id: string;
  original_unit_iqd: number;
  observed_unit_iqd: number;
  qty: number;
  credited_iqd: number;
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
  },
} as const;

export default function PriceProtection({ order }: { order: ApiOrder }) {
  const { money } = useMoney();
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
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4" aria-labelledby="pp-title" data-price-protection>
      <h3 id="pp-title" className="text-white font-bold text-[14px] inline-flex items-center gap-1.5">
        <ShieldCheck className="w-4 h-4 text-[#BAA369]" aria-hidden />
        {s.title}
      </h3>
      <p className="text-zinc-500 text-[12px] mt-1 leading-relaxed">{s.intro}</p>
      <p className={`mt-2 text-[12px] inline-flex items-center gap-1.5 ${windowOpen ? 'text-emerald-300' : 'text-zinc-500'}`}>
        <Clock className="w-3.5 h-3.5" aria-hidden />
        {windowOpen && daysLeft !== null ? daysLeftLabel(daysLeft, lang) : s.closed}
      </p>

      <div role="status" aria-live="polite" className="mt-3">
        {loadState === 'loading' && claims === null && (
          <p className="text-zinc-500 text-[12px] inline-flex items-center gap-2">
            <Spinner size="xs" delayMs={0} decorative /> {s.loading}
          </p>
        )}
        {loadState === 'failed' && (
          <p className="text-red-400 text-[12px]">
            {s.loadError}{' '}
            <button type="button" onClick={load} className="underline font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] rounded">
              {s.retry}
            </button>
          </p>
        )}
        {claims && claims.length > 0 && (
          <ul className="flex flex-col gap-2">
            {claims.map((c) => (
              <li key={c.id} data-pp-claim={c.state} className="rounded-xl border border-zinc-800 bg-black/30 p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-[12.5px] text-zinc-200 truncate min-w-0">
                    {c.item?.name ?? c.order_item_id} × {c.qty}
                  </p>
                  <span
                    className={`shrink-0 rounded-full border px-2 py-0.5 text-[10.5px] font-bold ${
                      c.state === 'rejected'
                        ? 'bg-red-500/10 text-red-300 border-red-500/20'
                        : c.state === 'credited' || c.state === 'approved'
                          ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20'
                          : 'bg-zinc-800 text-zinc-300 border-zinc-700'
                    }`}
                  >
                    {s.states[c.state] ?? c.state}
                  </span>
                </div>
                <p className="mt-1 text-[11.5px] text-zinc-500 tabular-nums">
                  {s.paid} {money(c.original_unit_iqd)} · {s.observed} {money(c.observed_unit_iqd)}
                  {c.credited_iqd > 0 && ` · ${s.credited} ${money(c.credited_iqd)}`}
                  {' · '}
                  {s.requestedAt} {formatDate(c.requested_at, lang)}
                </p>
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
                <p className="text-[12.5px] text-zinc-300 truncate min-w-0">{it.name}</p>
                {pending ? (
                  <span className="shrink-0 text-[11.5px] text-zinc-500">{s.pending}</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => claimFor(it.id)}
                    disabled={busyItem !== null || !it.product_id}
                    data-pp-claim-item={it.id}
                    className="shrink-0 inline-flex items-center gap-1.5 min-h-[36px] px-3 rounded-lg border border-zinc-700 text-zinc-200 text-[12px] font-bold hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] disabled:opacity-50"
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
