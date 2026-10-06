import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Zap } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api, ApiError, formatIqd } from '../../lib/api';

/**
 * «طلبات الشراء السريع» — the owner's window on Quick Buy sessions (owner
 * brief 2026-10-06 §14, docs/GIFTS_QUICK_BUY.md §3.2).
 *
 * READ-ONLY WHILE A SESSION IS COLLECTING. Nothing here confirms, prepares or
 * ships an open session: it becomes an ordinary order on the orders board the
 * moment its 30 minutes end, and that is where it is handled. The only two
 * actions are for a session the server could not submit after its retries
 * (`failed`) — its money is still held and its units still reserved, so the
 * owner either tries again or cancels it, which returns both.
 */

const STATES = ['open', 'failed', 'submitted', 'cancelled'] as const;
type SessionState = (typeof STATES)[number];

interface AdminQuickBuySession {
  id: string;
  user_id: string;
  user_name: string | null;
  user_email: string | null;
  state: SessionState;
  started_at: string;
  expires_at: string;
  order_id: string;
  total_iqd: number;
  held_iqd: number;
  shipping_iqd: number;
  lines: number;
  units: number;
  finalize_attempts: number;
  finalize_error: string | null;
  submitted_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
}

interface Summary {
  days: number;
  held_now: { sessions: number; iqd: number };
  captured: { n: number; iqd: number };
  released: { n: number; iqd: number };
  refunded: { n: number; iqd: number };
  orders_by_kind: Array<{ kind: string; n: number; iqd: number }>;
}

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export default function AdminQuickBuy() {
  const { loc } = useLanguage();
  const [state, setState] = useState<SessionState>('open');
  const [rows, setRows] = useState<AdminQuickBuySession[] | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .get<Summary>('/api/admin/quick-buy/summary?days=30')
      .then((res) => {
        if (alive) setSummary(res);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await api.get<{ sessions: AdminQuickBuySession[]; server_now: string }>(`/api/admin/quick-buy/sessions?state=${state}`);
      setOffset(Date.parse(res.server_now) - Date.now());
      setRows(res.sessions);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : loc('تعذّر التحميل', 'Could not load', 'بارنەکرا'));
      setRows([]);
    }
  }, [state, loc]);

  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);

  // The countdown is the server's clock, carried by the offset — never the device's.
  useEffect(() => {
    if (state !== 'open') return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [state]);

  const act = async (id: string, action: 'retry' | 'cancel') => {
    if (action === 'cancel' && !window.confirm(loc('إلغاء الطلب وإرجاع المبلغ المحجوز والكميات؟', 'Cancel and return the held money and units?', 'هەڵوەشاندنەوە و گەڕاندنەوەی پارە و بڕەکان؟'))) return;
    setBusy(id);
    setError('');
    try {
      await api.post(`/api/admin/quick-buy/sessions/${id}/${action}`, {});
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : loc('تعذّر التنفيذ', 'Action failed', 'جێبەجێ نەکرا'));
    } finally {
      setBusy(null);
    }
  };

  const label: Record<SessionState, string> = {
    open: loc('قيد التجميع', 'Collecting', 'لە کۆکردنەوەدا'),
    failed: loc('تعذّر الإرسال', 'Could not submit', 'نەنێردرا'),
    submitted: loc('أُرسلت', 'Submitted', 'نێردرا'),
    cancelled: loc('أُلغيت', 'Cancelled', 'هەڵوەشێنرایەوە'),
  };

  return (
    <div className="space-y-4" data-admin="quick-buy">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-white font-black text-[15px] flex items-center gap-2">
          <Zap className="w-4 h-4 text-amber-300" />
          {loc('طلبات الشراء السريع', 'Quick Buy orders', 'داواکارییەکانی کڕینی خێرا')}
        </h2>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-1.5 text-zinc-400 text-[12.5px] min-h-[36px] px-3 rounded-xl border border-zinc-700/50"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          {loc('تحديث', 'Refresh', 'نوێکردنەوە')}
        </button>
      </div>
      <p className="text-zinc-500 text-[12px] leading-relaxed">
        {loc(
          'الطلب قيد التجميع للعرض فقط: يصبح طلباً عادياً في لوحة الطلبات عند انتهاء الثلاثين دقيقة، وهناك يُؤكَّد ويُجهَّز. المبلغ المحجوز ليس إيراداً.',
          'A collecting order is view-only: it becomes an ordinary order on the orders board when its 30 minutes end, and is confirmed and prepared there. Held money is not revenue.',
          'داواکاری لە کۆکردنەوەدا تەنها بۆ بینینە: کاتێک سی خولەکەکەی تەواو دەبێت دەبێتە داواکارییەکی ئاسایی لە تەختەی داواکارییەکان. پارەی گیراو داهات نییە.'
        )}
      </p>
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[12px] rounded-2xl border border-zinc-700/50 bg-zinc-800/30 p-4" data-quick-buy-summary>
          <div>
            <p className="text-zinc-600 text-[11px]">{loc('محجوز الآن (ليس إيراداً)', 'Held now (not revenue)', 'ئێستا گیراوە (داهات نییە)')}</p>
            <p className="text-amber-300" dir="ltr">{formatIqd(summary.held_now.iqd)}</p>
          </div>
          <div>
            <p className="text-zinc-600 text-[11px]">{loc('حُصّل خلال 30 يوماً', 'Captured, 30 days', 'وەرگیراو، ٣٠ ڕۆژ')}</p>
            <p className="text-zinc-200" dir="ltr">{formatIqd(summary.captured.iqd)}</p>
          </div>
          <div>
            <p className="text-zinc-600 text-[11px]">{loc('حُرّر خلال 30 يوماً', 'Released, 30 days', 'ئازادکراو، ٣٠ ڕۆژ')}</p>
            <p className="text-zinc-200" dir="ltr">{formatIqd(summary.released.iqd)}</p>
          </div>
          <div>
            <p className="text-zinc-600 text-[11px]">{loc('مُسترد خلال 30 يوماً', 'Refunded, 30 days', 'گەڕێنراوە، ٣٠ ڕۆژ')}</p>
            <p className="text-zinc-200" dir="ltr">{formatIqd(summary.refunded.iqd)}</p>
          </div>
          {summary.orders_by_kind.map((k) => (
            <div key={k.kind}>
              <p className="text-zinc-600 text-[11px]">
                {k.kind === 'quick_buy'
                  ? loc('طلبات الشراء السريع', 'Quick Buy orders', 'داواکاری کڕینی خێرا')
                  : k.kind === 'gift'
                    ? loc('طلبات الهدايا', 'Gift orders', 'داواکاری دیاری')
                    : loc('طلبات السلة', 'Cart orders', 'داواکاری سەبەتە')}
              </p>
              <p className="text-zinc-200" dir="ltr">{`${k.n} · ${formatIqd(k.iqd)}`}</p>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-1.5 overflow-x-auto hide-scrollbar pb-1">
        {STATES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setState(s)}
            aria-pressed={state === s}
            className={`shrink-0 px-3.5 min-h-[36px] rounded-xl text-[12px] font-semibold border transition-colors ${
              state === s ? 'bg-amber-500/20 text-amber-200 border-amber-500/50' : 'bg-zinc-800/40 text-zinc-400 border-zinc-700/50'
            }`}
          >
            {label[s]}
          </button>
        ))}
      </div>
      {!!error && <p className="text-red-300 text-[12.5px]">{error}</p>}
      {rows === null && <p className="text-zinc-500 text-[12.5px]">{loc('جارٍ التحميل…', 'Loading…', 'بارکردن…')}</p>}
      {rows !== null && rows.length === 0 && (
        <p className="text-zinc-500 text-[12.5px]">{loc('لا توجد طلبات هنا', 'Nothing here', 'هیچ نییە')}</p>
      )}
      <div className="space-y-3">
        {(rows ?? []).map((r) => {
          const left = Date.parse(r.expires_at) - (now + offset);
          return (
            <div key={r.id} className="rounded-2xl border border-zinc-700/50 bg-zinc-800/30 p-4" data-quick-buy-session={r.id}>
              <div className="flex items-start justify-between gap-3 mb-2">
                <span className="text-white font-semibold text-[13.5px]">{r.user_name || r.user_email || r.user_id}</span>
                <span className="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-zinc-700/40 text-zinc-300" dir="ltr">
                  {r.state === 'open' ? `⚡ ${mmss(left)}` : label[r.state]}
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[12px] mb-3">
                <div>
                  <p className="text-zinc-600 text-[11px]">{loc('المنتجات', 'Items', 'بەرهەمەکان')}</p>
                  <p className="text-zinc-200" dir="ltr">{`${r.lines} / ${r.units}`}</p>
                </div>
                <div>
                  <p className="text-zinc-600 text-[11px]">{loc('المجموع', 'Total', 'کۆ')}</p>
                  <p className="text-zinc-200" dir="ltr">{formatIqd(r.total_iqd)}</p>
                </div>
                <div>
                  <p className="text-zinc-600 text-[11px]">{loc('محجوز (ليس إيراداً)', 'Held (not revenue)', 'گیراو (داهات نییە)')}</p>
                  <p className="text-amber-300" dir="ltr">{formatIqd(r.state === 'open' || r.state === 'failed' ? r.held_iqd : 0)}</p>
                </div>
                <div>
                  <p className="text-zinc-600 text-[11px]">{loc('رقم الطلب', 'Order', 'داواکاری')}</p>
                  <p className="text-zinc-200" dir="ltr">{r.state === 'submitted' ? r.order_id : '—'}</p>
                </div>
              </div>
              {r.state === 'failed' && (
                <>
                  <p className="text-red-300 text-[12.5px] mb-3" dir="auto">
                    {loc('سبب التعذّر', 'Reason', 'هۆکار')}: {r.finalize_error || '—'} ({r.finalize_attempts})
                  </p>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      disabled={busy === r.id}
                      onClick={() => void act(r.id, 'retry')}
                      className="shrink-0 px-3.5 min-h-[36px] rounded-xl text-[12px] font-semibold border transition-colors bg-amber-500/20 text-amber-200 border-amber-500/50"
                    >
                      {loc('إعادة المحاولة', 'Try again', 'دووبارە هەوڵ بدەرەوە')}
                    </button>
                    <button
                      type="button"
                      disabled={busy === r.id}
                      onClick={() => void act(r.id, 'cancel')}
                      className="shrink-0 px-3.5 min-h-[36px] rounded-xl text-[12px] font-semibold border transition-colors bg-zinc-800/40 text-zinc-400 border-zinc-700/50"
                    >
                      {loc('إلغاء وإرجاع المبلغ', 'Cancel and refund', 'هەڵوەشاندنەوە و گەڕاندنەوە')}
                    </button>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
