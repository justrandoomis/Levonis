import { useState, useEffect, useCallback } from 'react';
import { useLanguage } from '../../LanguageContext';
import { api, ApiError } from '../../lib/api';
import { RefreshCw, ExternalLink, Tag } from 'lucide-react';

/**
 * «شكاوى الأسعار» — THE SCREEN THAT WAS MISSING ENTIRELY.
 *
 * WHAT WAS BROKEN. `worker/routes/priceReports.ts` has shipped a complete
 * owner-side API for some time — `GET /api/admin/price-reports` with the gap
 * already computed both ways, `PATCH /api/admin/price-reports/:id` with an
 * audited decision and a review stamp taken from the session — and `src/`
 * referenced NEITHER of them. The only caller anywhere in the app was the
 * CUSTOMER's `POST` in src/components/product/CheaperElsewhereSheet.tsx. So
 * every «لكيتها أرخص» a customer filed went into `price_reports` and was never
 * read by anybody: an admin API with no door.
 *
 * WHY THE ROW SHOWS TWO OF OUR PRICES. `our_price_iqd` is frozen at the moment
 * the customer filed; `product.price_now_iqd` is what the catalogue charges
 * today. The two differing is the single most useful fact on the screen — it
 * means the price already moved and the gap on the row is history, not a
 * standing problem — so both are printed and the difference is called out
 * rather than left for the reader to spot.
 *
 * THE LINK IS TEXT, NOT A FETCH. The server's own note says nothing follows
 * these URLs; this screen keeps that true. It renders an `<a>` the admin may
 * choose to open, with `rel="noreferrer"` so the competitor never learns which
 * admin of which shop clicked, and it never requests the URL itself.
 *
 * LANGUAGE. `loc(ar, en)` with no third argument hands a Kurdish-reading admin
 * the ARABIC sentence, which is this repository's fallback. No Sorani is
 * invented here — these labels are the owner's to write by hand.
 */

const STATES = ['new', 'reviewed', 'actioned', 'rejected'] as const;
type ReportState = (typeof STATES)[number];

interface AdminPriceReport {
  id: string;
  product: {
    id: string | null;
    slug: string | null;
    name_ar: string;
    name_en: string;
    price_now_iqd: number | null;
  };
  our_price_iqd: number;
  their_price_iqd: number;
  gap_iqd: number;
  gap_percent: number | null;
  seller_name: string;
  url: string;
  note: string;
  state: ReportState;
  admin_note: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  reported_by: { id: string; name: string; username: string };
  created_at: string;
}

const iqd = (n: number) => `${n.toLocaleString('en-US')} د.ع`;

export default function PriceReportsPanel() {
  const { lang } = useLanguage();
  const loc = (ar: string, en: string, ckb?: string) => (lang === 'en' ? en : lang === 'ckb' ? ckb || ar : ar);

  const [rows, setRows] = useState<AdminPriceReport[] | null>(null);
  const [filter, setFilter] = useState<'all' | ReportState>('new');
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setError('');
    try {
      const d = await api.get<{ reports: AdminPriceReport[] }>(
        `/api/admin/price-reports?state=${filter}&limit=100`
      );
      setRows(d.reports);
      // The admin's own note comes back with the row, so an edit in progress
      // is not silently replaced by a refresh of somebody else's decision.
      setNotes((prev) => {
        const next = { ...prev };
        for (const r of d.reports) if (next[r.id] === undefined) next[r.id] = r.admin_note ?? '';
        return next;
      });
    } catch (e) {
      setRows([]);
      setError(e instanceof ApiError ? e.message : loc('تعذّر التحميل', 'Could not load'));
    }
    // `loc` is recreated every render; the request depends only on the filter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(report: AdminPriceReport, state: ReportState) {
    setBusyId(report.id);
    setError('');
    try {
      await api.patch(`/api/admin/price-reports/${report.id}`, {
        state,
        adminNote: (notes[report.id] ?? '').trim(),
      });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : loc('تعذّر الحفظ', 'Could not save'));
    } finally {
      setBusyId('');
    }
  }

  const stateLabel = (s: 'all' | ReportState) =>
    s === 'all'
      ? loc('الكل', 'All')
      : s === 'new'
        ? loc('جديدة', 'New')
        : s === 'reviewed'
          ? loc('روجعت', 'Reviewed')
          : s === 'actioned'
            ? loc('عُولجت', 'Actioned')
            : loc('مرفوضة', 'Rejected');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-white font-black text-[15px] flex items-center gap-2">
          <Tag className="w-4 h-4 text-amber-300" />
          {loc('شكاوى الأسعار', 'Price reports')}
        </h2>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-1.5 text-zinc-400 text-[12.5px] min-h-[36px] px-3 rounded-xl border border-zinc-700/50"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          {loc('تحديث', 'Refresh')}
        </button>
      </div>

      <p className="text-zinc-500 text-[12px] leading-relaxed">
        {loc(
          'بلاغات الزبائن بأن سعرًا لدينا أعلى من مكان آخر. الرابط نص فقط — لا يفتحه النظام ولا يجلبه.',
          'Customer reports that a price of ours is higher elsewhere. The link is text only — the system never fetches it.'
        )}
      </p>

      <div className="flex gap-1.5 overflow-x-auto hide-scrollbar pb-1">
        {(['all', ...STATES] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setFilter(s)}
            className={`shrink-0 px-3.5 min-h-[36px] rounded-xl text-[12px] font-semibold border transition-colors ${
              filter === s
                ? 'bg-amber-500/20 text-amber-200 border-amber-500/50'
                : 'bg-zinc-800/40 text-zinc-400 border-zinc-700/50'
            }`}
          >
            {stateLabel(s)}
          </button>
        ))}
      </div>

      {!!error && <p className="text-red-300 text-[12.5px]">{error}</p>}

      {rows === null && <p className="text-zinc-500 text-[12.5px]">{loc('جارٍ التحميل…', 'Loading…')}</p>}
      {rows !== null && rows.length === 0 && (
        <p className="text-zinc-500 text-[12.5px]">{loc('لا توجد بلاغات', 'No reports')}</p>
      )}

      <div className="space-y-3">
        {(rows ?? []).map((r) => {
          const moved = r.product.price_now_iqd !== null && r.product.price_now_iqd !== r.our_price_iqd;
          return (
            <div key={r.id} className="rounded-2xl border border-zinc-700/50 bg-zinc-800/30 p-4">
              <div className="flex items-start justify-between gap-3 mb-2">
                <span className="text-white font-semibold text-[13.5px]">
                  {lang === 'en' ? r.product.name_en || r.product.name_ar : r.product.name_ar || r.product.name_en}
                </span>
                <span className="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-zinc-700/40 text-zinc-300">
                  {stateLabel(r.state)}
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[12px] mb-3">
                <div>
                  <p className="text-zinc-600 text-[11px]">{loc('سعرنا وقت البلاغ', 'Our price when filed')}</p>
                  <p className="text-zinc-200" dir="ltr">{iqd(r.our_price_iqd)}</p>
                </div>
                <div>
                  <p className="text-zinc-600 text-[11px]">{loc('سعرهم', 'Their price')}</p>
                  <p className="text-zinc-200" dir="ltr">{iqd(r.their_price_iqd)}</p>
                </div>
                <div>
                  <p className="text-zinc-600 text-[11px]">{loc('الفارق', 'Gap')}</p>
                  <p className="text-amber-300" dir="ltr">
                    {iqd(r.gap_iqd)}
                    {r.gap_percent !== null ? ` · ${r.gap_percent}%` : ''}
                  </p>
                </div>
                <div>
                  <p className="text-zinc-600 text-[11px]">{loc('سعرنا الآن', 'Our price now')}</p>
                  <p className={moved ? 'text-sky-300' : 'text-zinc-200'} dir="ltr">
                    {r.product.price_now_iqd === null ? '—' : iqd(r.product.price_now_iqd)}
                  </p>
                </div>
              </div>

              {/* THE ROW'S MOST USEFUL FACT, said out loud rather than left to
                  the reader to notice by comparing two numbers. */}
              {moved && (
                <p className="text-sky-300/90 text-[11.5px] mb-2">
                  {loc(
                    'تغيّر سعرنا بعد هذا البلاغ — الفارق أعلاه تاريخ، لا وضعًا قائمًا.',
                    'Our price moved after this report — the gap above is history, not a standing problem.'
                  )}
                </p>
              )}

              <div className="text-[11.5px] text-zinc-500 space-y-1 mb-3">
                <p>
                  {loc('البائع', 'Seller')}: <span className="text-zinc-300">{r.seller_name || '—'}</span>
                </p>
                {!!r.url && (
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 text-sky-300 break-all"
                    dir="ltr"
                  >
                    <ExternalLink className="w-3 h-3 shrink-0" />
                    {r.url}
                  </a>
                )}
                {!!r.note && <p className="text-zinc-400 whitespace-pre-wrap">{r.note}</p>}
                <p>
                  {loc('من', 'From')}: {r.reported_by.name || r.reported_by.username || r.reported_by.id}
                </p>
              </div>

              <textarea
                value={notes[r.id] ?? ''}
                onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
                rows={2}
                maxLength={500}
                placeholder={loc('ملاحظة القرار (تُحفظ مع الحالة)', 'Decision note (saved with the state)')}
                className="w-full rounded-xl border border-zinc-700/50 bg-zinc-900/60 px-3 py-2 text-[12.5px] text-zinc-100 placeholder:text-zinc-600 mb-2"
              />

              <div className="flex flex-wrap gap-2">
                {STATES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={busyId === r.id || r.state === s}
                    onClick={() => void decide(r, s)}
                    className="px-3.5 min-h-[36px] rounded-xl text-[12px] font-semibold border border-zinc-700/50 bg-zinc-800/40 text-zinc-300 disabled:opacity-40"
                  >
                    {stateLabel(s)}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
