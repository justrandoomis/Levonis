/**
 * Customer-facing PRO BNPL account, backed only by authenticated server
 * reads/writes. The `activePro` prop controls presentation; every request is
 * independently authorised by the Worker and accepts no membership label.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Clock3, CreditCard, Loader2, RefreshCw, ShieldCheck, WalletCards } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useWallet } from '../../WalletContext';
import { api, newIdempotencyKey } from '../../lib/api';
import { apiRefusal, refusalText } from '../../lib/refusalStrings';
import { formatDate } from '../orders/format';
import { useMoney } from '../../CurrencyContext';
import { useBusy } from '../../lib/busy';

interface Eligibility {
  eligible: boolean;
  reason: string | null;
  account_state: 'none' | 'requested' | 'approved' | 'suspended' | string;
  credit_limit_iqd: number;
  outstanding_iqd: number;
  available_iqd: number;
  due_days: number;
  identity_verified: boolean;
  approved_address: boolean;
}

interface LedgerEntry {
  id: string;
  order_id: string | null;
  kind: 'charge' | 'repayment' | 'adjustment' | string;
  amount_iqd: number;
  due_at: string | null;
  note: string | null;
  created_at: string;
}

interface BnplResponse {
  eligibility: Eligibility;
  ledger: LedgerEntry[];
}

const COPY = {
  ar: {
    title: 'الدفع لاحقًا — PRO',
    subtitle: 'حد شراء فعلي وسجل سداد محمي. الأهلية والمبلغ يعاد التحقق منهما في الخادم عند كل طلب.',
    active: 'فعّال', requested: 'قيد المراجعة', suspended: 'موقوف', setup: 'إعداد الحساب',
    limit: 'الحد المعتمد', available: 'المتاح الآن', outstanding: 'المستحق',
    identity: 'هوية موثقة', address: 'عنوان افتراضي معتمد',
    request: 'طلب اعتماد حد الدفع لاحقًا', requesting: 'جارٍ إرسال الطلب…',
    requestOk: 'تم إرسال الطلب إلى فريق المراجعة.',
    requestedNote: 'طلب الحد الائتماني قيد المراجعة اليدوية.',
    suspendedNote: 'أوقف الحد بسبب قرار ائتماني أو قسط متأخر. يبقى السداد متاحًا.',
    support: 'مراجعة الحساب مع الدعم', requirements: 'أكمل متطلبات PRO أعلاه قبل إرسال الطلب.',
    repayTitle: 'سداد الرصيد من المحفظة', repayHint: 'لا يمكن أن يتجاوز المبلغ الرصيد المستحق.',
    amount: 'مبلغ السداد (د.ع)', repay: 'سداد', repaying: 'جارٍ السداد…', repayOk: 'تم تسجيل السداد وتحديث الرصيد.',
    history: 'سجل الشراء والسداد', purchase: 'شراء مؤجل', repayment: 'سداد', adjustment: 'تسوية طلب',
    due: 'الاستحقاق', order: 'الطلب', empty: 'لا توجد حركات بعد.',
    loadError: 'تعذر تحميل حساب الدفع لاحقًا.', retry: 'إعادة المحاولة',
  },
  en: {
    title: 'Buy Now, Pay Later — PRO',
    subtitle: 'A real purchase limit and protected repayment ledger. The server rechecks eligibility and amount on every order.',
    active: 'Active', requested: 'Under review', suspended: 'Suspended', setup: 'Set up account',
    limit: 'Approved limit', available: 'Available now', outstanding: 'Outstanding',
    identity: 'Verified identity', address: 'Approved default address',
    request: 'Request a BNPL limit', requesting: 'Sending request…', requestOk: 'Your request was sent for manual review.',
    requestedNote: 'Your credit-limit request is under manual review.',
    suspendedNote: 'The limit was paused by a credit decision or overdue instalment. Repayment remains available.',
    support: 'Review account with support', requirements: 'Complete the PRO requirements above before requesting a limit.',
    repayTitle: 'Repay from wallet', repayHint: 'The amount cannot exceed the outstanding balance.',
    amount: 'Repayment amount (IQD)', repay: 'Repay', repaying: 'Processing…', repayOk: 'Repayment recorded and balance updated.',
    history: 'Purchase and repayment history', purchase: 'Financed purchase', repayment: 'Repayment', adjustment: 'Order adjustment',
    due: 'Due', order: 'Order', empty: 'No entries yet.',
    loadError: 'Could not load your Buy Now, Pay Later account.', retry: 'Try again',
  },
  ckb: {
    title: 'ئێستا بکڕە و دواتر بدە — PRO',
    subtitle: 'سنووری کڕینی ڕاستەقینە و تۆماری دانەوەی پارێزراو. ڕاژەکار لە هەر داواکارییەکدا گونجاوی و بڕەکە دووبارە دەپشکنێت.',
    active: 'چالاک', requested: 'لە پێداچوونەوەدایە', suspended: 'ڕاگیراو', setup: 'ڕێکخستنی هەژمار',
    limit: 'سنووری پەسەندکراو', available: 'ئێستا بەردەستە', outstanding: 'ماوە بۆ دانەوە',
    identity: 'ناسنامەی پشتڕاستکراو', address: 'ناونیشانی بنەڕەتی پەسەندکراو',
    request: 'داواکردنی سنووری دانەوەی دواتر', requesting: 'داواکاری دەنێردرێت…', requestOk: 'داواکارییەکەت بۆ پێداچوونەوەی دەستی نێردرا.',
    requestedNote: 'داواکاری سنووری قەرزەکەت لە پێداچوونەوەی دەستیدایە.',
    suspendedNote: 'سنوورەکە بەهۆی بڕیاری قەرز یان دانەوەی دواخراو ڕاگیراوە. دانەوە هەر بەردەستە.',
    support: 'پێداچوونەوەی هەژمار لەگەڵ پشتگیری', requirements: 'پێش داواکردنی سنوور، داواکارییەکانی PRO ی سەرەوە تەواو بکە.',
    repayTitle: 'دانەوە لە جزدان', repayHint: 'بڕەکە نابێت لە قەرزی ماوە زیاتر بێت.',
    amount: 'بڕی دانەوە (د.ع)', repay: 'دانەوە', repaying: 'دانەوە ئەنجام دەدرێت…', repayOk: 'دانەوە تۆمار کرا و باڵانس نوێ کرایەوە.',
    history: 'مێژووی کڕین و دانەوە', purchase: 'کڕینی دواخراو', repayment: 'دانەوە', adjustment: 'ڕێکخستنی داواکاری',
    due: 'کاتی دانەوە', order: 'داواکاری', empty: 'هێشتا هیچ جووڵەیەک نییە.',
    loadError: 'هەژماری ئێستا بکڕە و دواتر بدە بار نەکرا.', retry: 'دووبارە هەوڵ بدە',
  },
} as const;

export function BnplPanel({ activePro }: { activePro: boolean }) {
  const { money } = useMoney();
  const { lang } = useLanguage();
  const { refreshWallet } = useWallet();
  const s = COPY[lang];
  const [data, setData] = useState<BnplResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'request' | 'repay' | null>(null);
  // A repayment moves wallet money: while it (or a limit request) is in
  // flight, the app-wide busy screen holds every other control.
  useBusy(busy !== null, 'subscribe');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [amount, setAmount] = useState('');
  const repaymentKey = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await api.get<BnplResponse>('/api/memberships/bnpl'));
    } catch (err) {
      setError(apiRefusal(err, lang, s.loadError));
    } finally {
      setLoading(false);
    }
  }, [lang, s.loadError]);

  useEffect(() => {
    void load();
  }, [load]);

  const eligibility = data?.eligibility;
  const hasHistory = !!data && (data.ledger.length > 0 || data.eligibility.account_state !== 'none' || data.eligibility.outstanding_iqd > 0);
  // Ordinary PLUS/PREMIUM members never see BNPL as a disabled benefit or
  // teaser. A former PRO with an existing account/debt keeps the repayment
  // door after expiry or downgrade, as the backend intentionally permits.
  if (!activePro && !hasHistory) return null;

  const requestLimit = async () => {
    if (busy) return;
    setBusy('request');
    setNote(null);
    try {
      await api.post('/api/memberships/bnpl/request', {});
      setNote({ ok: true, text: s.requestOk });
      await load();
    } catch (err) {
      setNote({ ok: false, text: apiRefusal(err, lang, s.loadError) });
    } finally {
      setBusy(null);
    }
  };

  const repay = async () => {
    if (busy || !eligibility) return;
    const amountIqd = Math.trunc(Number(amount));
    if (!Number.isFinite(amountIqd) || amountIqd < 1 || amountIqd > eligibility.outstanding_iqd) {
      setNote({ ok: false, text: refusalText('BNPL_REPAYMENT_EXCEEDS_DEBT', lang, s.repayHint) });
      return;
    }
    if (!repaymentKey.current) repaymentKey.current = newIdempotencyKey();
    setBusy('repay');
    setNote(null);
    try {
      await api.post('/api/memberships/bnpl/repay', { amount_iqd: amountIqd, idempotencyKey: repaymentKey.current });
      repaymentKey.current = null;
      setAmount('');
      setNote({ ok: true, text: s.repayOk });
      await Promise.all([load(), refreshWallet().catch(() => undefined)]);
    } catch (err) {
      setNote({ ok: false, text: apiRefusal(err, lang, s.repayHint) });
    } finally {
      setBusy(null);
    }
  };

  if (loading && !data) {
    return activePro ? (
      <div data-bnpl-panel className="lv-surface p-6 flex items-center justify-center gap-2 text-sm text-text-muted" aria-busy="true">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {s.title}
      </div>
    ) : null;
  }

  if (error && !data) {
    return (
      <div data-bnpl-panel role="alert" className="rounded-[24px] border border-red-500/25 bg-red-500/10 p-5 text-sm text-red-200">
        <p>{error}</p>
        <button type="button" onClick={() => void load()} className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-xl border border-red-400/30 px-3 font-bold">
          <RefreshCw className="h-4 w-4" aria-hidden /> {s.retry}
        </button>
      </div>
    );
  }

  if (!data || !eligibility) return null;
  const stateLabel = eligibility.eligible
    ? s.active
    : eligibility.account_state === 'requested'
      ? s.requested
      : eligibility.account_state === 'suspended'
        ? s.suspended
        : s.setup;
  const stateClass = eligibility.eligible
    ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
    : eligibility.account_state === 'suspended'
      ? 'border-red-400/30 bg-red-400/10 text-red-300'
      : 'border-amber-300/30 bg-amber-300/10 text-amber-200';
  const canRequest =
    activePro &&
    eligibility.identity_verified &&
    eligibility.approved_address &&
    eligibility.account_state !== 'approved' &&
    eligibility.account_state !== 'requested' &&
    eligibility.account_state !== 'suspended' &&
    eligibility.reason !== 'BNPL_DISABLED' &&
    eligibility.reason !== 'BNPL_RESTRICTED';

  return (
    <section data-bnpl-panel className="lv-surface overflow-hidden">
      <div className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border-subtle bg-surface-raised text-text-primary">
              <CreditCard className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <h3 className="font-black text-white">{s.title}</h3>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-zinc-400">{s.subtitle}</p>
            </div>
          </div>
          <span className={`rounded-full border px-3 py-1 text-[11px] font-black ${stateClass}`}>{stateLabel}</span>
        </div>

        {(eligibility.account_state !== 'none' || eligibility.outstanding_iqd > 0) && (
          <dl className="mt-5 grid grid-cols-1 gap-2.5 min-[430px]:grid-cols-3">
            {[
              [s.limit, eligibility.credit_limit_iqd],
              [s.available, eligibility.available_iqd],
              [s.outstanding, eligibility.outstanding_iqd],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-xl border border-border-subtle bg-surface-raised p-3">
                <dt className="text-[10px] font-bold text-zinc-500">{label}</dt>
                <dd className="mt-1 text-sm font-bold text-text-primary tabular-nums">{money(Number(value))}</dd>
              </div>
            ))}
          </dl>
        )}

        {activePro && !eligibility.eligible && eligibility.account_state !== 'suspended' && (
          <div className="mt-5 rounded-2xl border border-white/10 bg-black/20 p-4">
            <div className="grid gap-2 text-xs sm:grid-cols-2">
              <p className={`flex items-center gap-2 ${eligibility.identity_verified ? 'text-emerald-300' : 'text-amber-200'}`}>
                {eligibility.identity_verified ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <AlertTriangle className="h-4 w-4" aria-hidden />}
                {s.identity}
              </p>
              <p className={`flex items-center gap-2 ${eligibility.approved_address ? 'text-emerald-300' : 'text-amber-200'}`}>
                {eligibility.approved_address ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <AlertTriangle className="h-4 w-4" aria-hidden />}
                {s.address}
              </p>
            </div>
            {eligibility.account_state === 'requested' ? (
              <p className="mt-3 flex items-center gap-2 text-xs text-amber-100"><Clock3 className="h-4 w-4" aria-hidden /> {s.requestedNote}</p>
            ) : canRequest ? (
              <button type="button" disabled={busy !== null} onClick={() => void requestLimit()} className="mt-4 lv-button lv-button-primary lv-button-sm w-full sm:w-auto">
                {busy === 'request' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ShieldCheck className="h-4 w-4" aria-hidden />}
                {busy === 'request' ? s.requesting : s.request}
              </button>
            ) : (
              <p className="mt-3 text-xs text-zinc-400">{eligibility.reason ? refusalText(eligibility.reason, lang, s.requirements) : s.requirements}</p>
            )}
          </div>
        )}

        {eligibility.account_state === 'suspended' && (
          <div className="mt-5 rounded-2xl border border-red-400/25 bg-red-400/10 p-4 text-xs text-red-100">
            <p className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {s.suspendedNote}</p>
            <Link to="/support" className="mt-3 inline-flex min-h-10 items-center text-red-200 underline underline-offset-4">{s.support}</Link>
          </div>
        )}

        {eligibility.outstanding_iqd > 0 && (
          <div className="mt-5 rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.07] p-4">
            <h4 className="flex items-center gap-2 text-sm font-black text-white"><WalletCards className="h-4 w-4 text-emerald-300" aria-hidden /> {s.repayTitle}</h4>
            <p className="mt-1 text-[11px] text-zinc-400">{s.repayHint}</p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <label className="min-w-0 flex-1">
                <span className="sr-only">{s.amount}</span>
                <input
                  inputMode="numeric"
                  type="number"
                  min={1}
                  max={eligibility.outstanding_iqd}
                  value={amount}
                  onChange={(event) => { repaymentKey.current = null; setAmount(event.target.value); setNote(null); }}
                  placeholder={s.amount}
                  className="min-h-11 w-full rounded-xl border border-white/10 bg-black/35 px-3 text-sm text-white outline-none focus:border-emerald-400/50"
                  dir="ltr"
                />
              </label>
              <button type="button" disabled={busy !== null || !amount} onClick={() => void repay()} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-400 px-5 text-xs font-black text-emerald-950 disabled:opacity-50">
                {busy === 'repay' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <WalletCards className="h-4 w-4" aria-hidden />}
                {busy === 'repay' ? s.repaying : s.repay}
              </button>
            </div>
          </div>
        )}

        {note && <p role={note.ok ? 'status' : 'alert'} className={`mt-4 text-xs font-bold ${note.ok ? 'text-emerald-300' : 'text-red-300'}`}>{note.text}</p>}
      </div>

      <details className="border-t border-border-subtle/70 px-5 py-4 sm:px-6">
        <summary className="cursor-pointer select-none text-xs font-black text-zinc-300">{s.history} ({data.ledger.length})</summary>
        {data.ledger.length === 0 ? (
          <p className="py-4 text-xs text-zinc-500">{s.empty}</p>
        ) : (
          <ul className="mt-4 space-y-2">
            {data.ledger.map((entry) => {
              const signed = entry.kind === 'charge' ? entry.amount_iqd : entry.kind === 'repayment' ? -entry.amount_iqd : entry.amount_iqd;
              const label = entry.kind === 'charge' ? s.purchase : entry.kind === 'repayment' ? s.repayment : s.adjustment;
              return (
                <li key={entry.id} className="flex flex-wrap items-start justify-between gap-2 rounded-xl border border-white/7 bg-white/[0.025] p-3 text-xs">
                  <div>
                    <p className="font-bold text-zinc-200">{label}</p>
                    <p className="mt-0.5 text-[10px] text-zinc-500">
                      {formatDate(entry.created_at, lang)}
                      {entry.order_id ? ` · ${s.order} ${entry.order_id}` : ''}
                      {entry.due_at ? ` · ${s.due} ${formatDate(entry.due_at, lang)}` : ''}
                    </p>
                  </div>
                  <span className={`font-black ${signed > 0 ? 'text-red-300' : 'text-emerald-300'}`} dir="ltr">
                    {signed > 0 ? '+' : '−'}{money(Math.abs(signed))}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </details>
    </section>
  );
}

export default BnplPanel;
