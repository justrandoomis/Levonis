/**
 * "طلباتي" — the customer's own requests, told as a story rather than a table.
 *
 * WHY THIS IS NOT `RequestList`. The public board renders what a stranger may
 * see about somebody's request; this renders what its OWNER needs: the estimate
 * Levonis produced, how many merchants answered, which one they picked and when
 * it was promised. Those come from an owner-scoped route
 * (`GET /api/marketplace/print/my-requests`) rather than from widening the
 * board's privacy whitelist — see the comment on that handler.
 *
 * "إعادة الطلب" copies a request into a NEW one and PUBLISHES it — the copy
 * goes through the same matching as a first publish, so the merchants who can
 * make it are told (audit 03 §10 E: copies used to land on the board unmatched).
 * It asks first, in a sheet, because it duplicates files, starts a fresh 30-day
 * clock and notifies merchants; then it takes the person to the copy. If the
 * publish step failed, the copy is a draft and the person is told so, with the
 * draft's own Publish button one tap away — never a success that was not one.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Loader2, PackageSearch, MapPin, Repeat2, FileBox, Link2, ChevronLeft,
  BadgeCheck, CalendarClock,
} from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useAuth } from '../../AuthContext';
import { UnauthorizedState } from '../ui/AsyncStates';
import { ApiError } from '../../lib/api';
import { GOVERNORATE_LABELS } from '../../lib/governorates';
import { printApi, priceRange, type MyRequestRow, type Confidence } from '../../lib/printApi';
import { useMoney } from '../../CurrencyContext';
import { apiRefusal } from '../../lib/refusalStrings';
import { asLang } from '../orders/format';
import ConfirmSheet from './ConfirmSheet';

const CONFIDENCE_TEXT: Record<Confidence, [string, string]> = {
  high: ['دقة عالية', 'High confidence'],
  medium: ['دقة متوسطة', 'Medium confidence'],
  low: ['تقدير مبدئي', 'Rough estimate'],
};

const STATE_TEXT: Record<string, [string, string]> = {
  draft: ['مسودة', 'Draft'],
  open: ['مفتوح', 'Open'],
  receiving_offers: ['يستقبل العروض', 'Receiving offers'],
  awarded: ['تم اختيار تاجر', 'Merchant chosen'],
  in_progress: ['قيد التنفيذ', 'In progress'],
  completed: ['مكتمل', 'Completed'],
  cancelled: ['ملغى', 'Cancelled'],
  expired: ['منتهي', 'Expired'],
};

export default function MyRequestsList({ onOpen }: { onOpen: (id: string) => void }) {
  const { money } = useMoney();
  const { loc, lang } = useLanguage();
  const { isAuthenticated } = useAuth();
  const [rows, setRows] = useState<MyRequestRow[] | null>(null);
  const [repeating, setRepeating] = useState('');
  const [error, setError] = useState('');
  /** The request the customer asked to repeat — the sheet confirms it. */
  const [asking, setAsking] = useState<MyRequestRow | null>(null);
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    if (!isAuthenticated) {
      setRows([]);
      return;
    }
    printApi
      .myRequests()
      .then((d) => setRows(d.requests))
      .catch(() => setRows([]));
  }, [isAuthenticated]);

  useEffect(load, [load]);

  async function repeat(row: MyRequestRow) {
    setRepeating(row.id);
    setError('');
    setNotice('');
    try {
      const d = await printApi.repeat(row.id);
      setAsking(null);
      load();
      if (!d.published) {
        // W5-A: a repeat is always a DRAFT — reviewed, then published.
        // OWNER: Sorani to be written by hand.
        setNotice(
          loc(
            'نُسخ الطلب مسودةً — راجعه (الموعد والكمية) ثم انشره.',
            'The request was copied as a draft — review it (deadline, quantity), then publish it.'
          )
        );
      }
      onOpen(d.request_id);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? apiRefusal(e, asLang(lang), loc('تعذّرت إعادة الطلب', 'Could not repeat the request', 'نەتوانرا دووبارە بکرێتەوە'))
          : loc('تعذّرت إعادة الطلب', 'Could not repeat the request', 'نەتوانرا دووبارە بکرێتەوە')
      );
    } finally {
      setRepeating('');
    }
  }

  if (rows === null) {
    return (
      <div className="py-12 flex justify-center">
        <Loader2 className="w-5 h-5 text-gold animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) return <UnauthorizedState next="/requests" />;

  if (!rows.length) {
    return (
      <div className="py-14 text-center">
        <PackageSearch className="w-9 h-9 text-zinc-600 mx-auto mb-3" />
        <p className="text-zinc-400 text-[13px]">
          {loc('لم تنشئ أي طلب بعد', 'You have not created a request yet', 'هێشتا داواکاریت دروست نەکردووە')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-my-requests>
      {notice && (
        <p
          role="status"
          className="rounded-2xl border border-amber-500/25 bg-amber-500/10 px-3.5 py-2.5 text-[12.5px] text-amber-200"
        >
          {notice}
        </p>
      )}

      <ConfirmSheet
        open={!!asking}
        testId="repeat-request"
        // OWNER: Sorani to be written by hand.
        title={loc('إعادة هذا الطلب؟', 'Repeat this request?')}
        confirmLabel={loc('إعادة الطلب', 'Repeat', 'دووبارە')}
        // OWNER: Sorani to be written by hand.
        busyLabel={loc('جارٍ النسخ…', 'Copying…')}
        busy={!!asking && repeating === asking.id}
        error={error}
        onConfirm={() => asking && repeat(asking)}
        onClose={() => setAsking(null)}
      >
        {/* OWNER: Sorani to be written by hand. */}
        {asking &&
          loc(
            `سيُنشأ طلب جديد مسودةً بنفس تفاصيل «${asking.title}» وبنسخة من ملفاته. تراجعه وتختار موعدًا جديدًا، ثم تنشره ليصل إلى التجار المناسبين بتقدير سعر جديد.`,
            `A new DRAFT will be created with the same details as “${asking.title}” and a copy of its files. You review it and pick a new deadline, then publish it to the merchants who can make it, with a fresh estimate.`
          )}
      </ConfirmSheet>

      {rows.map((r) => {
        const st = STATE_TEXT[r.state];
        const p = r.print;
        return (
          <div
            key={r.id}
            data-my-request={r.id}
            className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden"
          >
            <button
              onClick={() => onOpen(r.id)}
              className="w-full text-start p-4 active:scale-[0.995] transition-transform"
            >
              <div className="flex items-start gap-3">
                {/* The thumbnail slot is a shape, not a fetched image: the
                    preview object is private and reaching it needs the
                    authorised file route. An icon that says WHAT the request
                    carries is more honest than a broken <img>. */}
                <div className="w-12 h-12 rounded-xl border border-white/10 bg-white/[0.04] flex items-center justify-center shrink-0">
                  {p?.source_kind === 'link' ? (
                    <Link2 className="w-5 h-5 text-gold/70" />
                  ) : (
                    <FileBox className="w-5 h-5 text-gold/70" />
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-white font-semibold text-[14px] leading-snug truncate">{r.title}</h3>
                    <span className="shrink-0 text-[10.5px] font-semibold px-2 py-0.5 rounded-full border border-white/15 bg-white/[0.04] text-zinc-300">
                      {st ? loc(st[0], st[1]) : r.state}
                    </span>
                  </div>

                  <p className="text-[11px] text-zinc-500 mt-0.5" dir="ltr">
                    {r.created_at.slice(0, 10)}
                    {p?.primary_file_name ? ` · ${p.primary_file_name}` : ''}
                  </p>

                  {p && (p.estimate_low_iqd !== null || p.estimate_high_iqd !== null) && (
                    <p className="mt-2 text-gold font-bold text-[13.5px]" dir="ltr" data-my-request-estimate>
                      {priceRange(p.estimate_low_iqd, p.estimate_high_iqd, money)}
                      {p.estimate_confidence && (
                        <span className="ms-2 text-[10.5px] font-semibold text-zinc-400" dir="auto">
                          {loc(...CONFIDENCE_TEXT[p.estimate_confidence])}
                        </span>
                      )}
                    </p>
                  )}

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11.5px] text-zinc-500 mt-2">
                    {(p?.material_id || r.material) && (
                      <span className="uppercase">{p?.material_id || r.material}</span>
                    )}
                    {p?.color_hex && (
                      <span className="flex items-center gap-1.5">
                        <span
                          className="w-3 h-3 rounded-full border border-white/25"
                          style={{ background: p.color_hex }}
                        />
                        {p.color_name || p.color_hex}
                      </span>
                    )}
                    {r.quantity > 1 && <span dir="ltr">×{r.quantity}</span>}
                    {r.governorate && (
                      <span className="flex items-center gap-1">
                        <MapPin className="w-3 h-3" />
                        {GOVERNORATE_LABELS[r.governorate]?.[lang === 'ckb' ? 'ckb' : lang] ?? r.governorate}
                      </span>
                    )}
                    <span className="ms-auto text-gold/80 font-semibold">
                      {loc(`${r.offer_count} عرض`, `${r.offer_count} offers`, `${r.offer_count} ئۆفەر`)}
                    </span>
                  </div>

                  {r.accepted && (
                    <div className="mt-2.5 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] px-3 py-2">
                      <p className="text-emerald-300 text-[12px] font-semibold flex items-center gap-1.5">
                        <BadgeCheck className="w-3.5 h-3.5" />
                        {r.accepted.merchant_name}
                        {r.accepted.price_iqd !== null && (
                          <span className="ms-auto" dir="ltr">{money(r.accepted.price_iqd)}</span>
                        )}
                      </p>
                      {r.accepted.completion_days !== null && r.accepted.completion_days > 0 && (
                        <p className="text-[11px] text-emerald-200/70 mt-0.5 flex items-center gap-1.5">
                          <CalendarClock className="w-3 h-3" />
                          {loc(
                            `التسليم خلال ${r.accepted.completion_days} يوم`,
                            `Delivery in ${r.accepted.completion_days} days`,
                            `گەیاندن لە ${r.accepted.completion_days} ڕۆژدا`
                          )}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </button>

            <div className="flex border-t border-white/[0.07]">
              <button
                onClick={() => onOpen(r.id)}
                className="flex-1 min-h-[42px] text-[12.5px] font-semibold text-zinc-300 flex items-center justify-center gap-1.5"
              >
                {loc('فتح الطلب', 'Open request', 'کردنەوە')}
                <ChevronLeft className="w-3.5 h-3.5 rotate-180 rtl:rotate-0" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setError('');
                  setAsking(r);
                }}
                disabled={repeating === r.id}
                data-my-request-repeat={r.id}
                className="flex-1 min-h-[42px] border-s border-white/[0.07] text-[12.5px] font-semibold text-gold flex items-center justify-center gap-1.5 disabled:opacity-60"
              >
                {repeating === r.id ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Repeat2 className="w-3.5 h-3.5" />
                )}
                {loc('إعادة الطلب', 'Repeat', 'دووبارە')}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
