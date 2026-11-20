/**
 * «بلا ضمان — لا إرجاع مجاني» ON THE ADMIN ORDER WINDOW (owner, 2026-11-20; DECISIONS row 365).
 *
 * A printer sold through the printer services WITHOUT a warranty is not in the customer's return flow: their
 * order page shows no «طلب إرجاع» for it and the server refuses the request. Staff must see that fact on the
 * line — and the shop must still be able to honour a legal right or a goodwill case (a printer damaged on
 * arrival). So this block says the fact to every admin, and gives THE OWNER the one door that opens a return
 * for such a printer: an accepted reason, what was seen, and a written reason for the exception (five
 * characters at least; audited as `return.owner_exception`). The case then walks the ordinary returns
 * pipeline for the customer — nothing is approved or refunded here.
 *
 * Any other staff member reads that the exception is the owner's; the server refuses them in words anyway
 * (POST /api/returns/admin/exception → 403 OWNER_REQUIRED). Its own lazy chunk: only an order with such a
 * printer loads it.
 */
import { useState } from 'react';
import { api } from '../../lib/api';
import { apiRefusal, refusalLang } from '../../lib/refusalStrings';

type Loc = (ar: string, en: string, ckb?: string) => string;

const REASONS = ['shipping_damage', 'defective', 'manufacturing_fault', 'wrong_product', 'not_as_described'] as const;
type Reason = (typeof REASONS)[number];

export default function ReturnExceptionPanel({
  orderItemId,
  qty,
  delivered,
  viewerOwner,
  loc,
  lang,
}: {
  orderItemId: string;
  qty: number;
  /** The order is delivered: a return can exist only after that. */
  delivered: boolean;
  viewerOwner: boolean;
  loc: Loc;
  lang: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<Reason>('shipping_damage');
  const [count, setCount] = useState(1);
  const [seen, setSeen] = useState('');
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const reasonWord = (r: Reason): string =>
    r === 'shipping_damage' ? loc('وصلت تالفة (ضرر أثناء الشحن)', 'Arrived damaged (shipping damage)', 'بە زیانلێکەوتوویی گەیشت (زیانی گەیاندن)')
      : r === 'defective' ? loc('لا تعمل أو تعمل بخلل', 'Does not work, or works with a fault', 'کار ناکات یان بە کێشەوە کار دەکات')
        : r === 'manufacturing_fault' ? loc('عيب مصنعي', 'Manufacturing fault', 'کێشەی دروستکردن')
          : r === 'wrong_product' ? loc('وصل منتج غير المطلوب', 'The wrong product arrived', 'بەرهەمێکی هەڵە گەیشت')
            : loc('مخالفة للوصف', 'Not as described', 'جیاواز لە وەسفەکە');

  const whyOk = why.trim().length >= 5;

  const submit = async () => {
    if (busy || !whyOk) return;
    setBusy(true);
    setError('');
    try {
      await api.post('/api/returns/admin/exception', {
        orderItemId,
        qty: count,
        reason,
        description: seen.trim(),
        exception_reason: why.trim(),
      });
      setDone(true);
      setOpen(false);
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      setError(
        code === 'QTY_EXCEEDED'
          ? loc('لهذه الطابعة طلب إرجاع مفتوح أو مُنجز بالفعل — لا يُفتح آخر.', 'This printer already has an open or completed return — another one is not opened.', 'ئەم پرینتەرە پێشتر داواکاریی گەڕاندنەوەی کراوە یان تەواوکراوی هەیە — دانەیەکی تر ناکرێتەوە.')
          : apiRefusal(err, refusalLang(lang), loc('تعذّر فتح طلب الإرجاع — حاول مرة أخرى.', 'The return could not be opened — try again.', 'داواکاریی گەڕاندنەوە نەکرایەوە — دووبارە هەوڵ بدەرەوە.'))
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full min-w-0 rounded-xl border border-border-subtle bg-surface-selected p-3 space-y-2" data-return-exception={orderItemId}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="lv-chip [--chip:var(--color-warning)] rounded-full px-2 py-0.5 text-[11px] font-bold" data-return-no-warranty>
          {loc('بلا ضمان — لا إرجاع مجاني', 'No warranty — no free return', 'بێ گەرەنتی — بێ گەڕاندنەوەی بەخۆڕایی')}
        </span>
      </div>
      <p className="text-[12px] leading-relaxed text-text-secondary">
        {loc(
          'لا يستطيع الزبون طلب إرجاع هذه الطابعة من صفحة طلبه. إن وصلت تالفة أو كان له حق قانوني، يفتح المالك وحده طلب الإرجاع استثناءً مع سبب مكتوب.',
          'The customer cannot request a return of this printer from their order page. If it arrived damaged, or they hold a legal right, the owner alone opens the return as an exception, with a written reason.',
          'کڕیار ناتوانێت لە پەڕەی داواکارییەکەیەوە داوای گەڕاندنەوەی ئەم پرینتەرە بکات. ئەگەر بە زیانلێکەوتوویی گەیشتبێت یان مافێکی یاسایی هەبێت، تەنها خاوەن بە شێوەی ئاوارتە و بە هۆکارێکی نووسراو داواکاریی گەڕاندنەوەکە دەکاتەوە.'
        )}
      </p>

      {done ? (
        <p role="status" className="text-[12px] font-bold text-success" data-return-exception-done>
          {loc('فُتح طلب الإرجاع وسُجّل سببه — يتابعه الزبون من صفحة طلبه.', 'The return was opened and its reason recorded — the customer follows it on their order page.', 'داواکاریی گەڕاندنەوە کرایەوە و هۆکارەکەی تۆمار کرا — کڕیار لە پەڕەی داواکارییەکەیەوە بەدوایدا دەچێت.')}
        </p>
      ) : !delivered ? (
        <p className="text-[11.5px] text-text-secondary">{loc('يُفتح الإرجاع بعد تسليم الطلب.', 'A return can be opened once the order is delivered.', 'گەڕاندنەوە دوای ڕادەستکردنی داواکارییەکە دەکرێتەوە.')}</p>
      ) : !viewerOwner ? (
        <p className="text-[11.5px] font-bold text-text-secondary" data-return-exception-owner-only>{loc('هذا الاستثناء للمالك فقط.', 'This exception is the owner’s only.', 'ئەم ئاوارتەیە تەنها بۆ خاوەنە.')}</p>
      ) : !open ? (
        <button type="button" onClick={() => { setOpen(true); setError(''); }} className="lv-button lv-button-secondary lv-button-sm" data-return-exception-open>
          {loc('فتح إرجاع استثناءً', 'Open a return as an exception', 'کردنەوەی گەڕاندنەوە وەک ئاوارتە')}
        </button>
      ) : (
        <div className="space-y-2" data-return-exception-form>
          <div className={qty > 1 ? 'grid grid-cols-2 gap-3' : ''}>
            <label className="block">
              <span className="text-[11px] font-semibold text-text-secondary block mb-1">{loc('ما المشكلة؟', 'What is the problem?', 'کێشەکە چییە؟')}</span>
              <select className="lv-input text-xs" value={reason} onChange={(e) => setReason(e.target.value as Reason)}>
                {REASONS.map((r) => <option key={r} value={r}>{reasonWord(r)}</option>)}
              </select>
            </label>
            {qty > 1 ? (
              <label className="block">
                <span className="text-[11px] font-semibold text-text-secondary block mb-1">{loc('عدد الطابعات', 'Printers', 'ژمارەی پرینتەرەکان')}</span>
                <select className="lv-input text-xs" value={count} onChange={(e) => setCount(Number(e.target.value))}>
                  {Array.from({ length: qty }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            ) : null}
          </div>
          <label className="block">
            <span className="text-[11px] font-semibold text-text-secondary block mb-1">{loc('ما الذي شوهد؟ (يقرؤه فريق الإرجاع)', 'What was seen? (the returns team reads it)', 'چی بینرا؟ (تیمی گەڕاندنەوە دەیخوێنێتەوە)')}</span>
            <textarea className="lv-input py-2 text-xs leading-relaxed resize-y" rows={2} maxLength={3000} value={seen} onChange={(e) => setSeen(e.target.value)} />
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold text-text-secondary block mb-1">{loc('سبب الاستثناء (يُحفظ في السجل)', 'Reason for the exception (kept in the record)', 'هۆکاری ئاوارتەکە (لە تۆماردا هەڵدەگیرێت)')}</span>
            <textarea className="lv-input py-2 text-xs leading-relaxed resize-y" rows={2} maxLength={500} value={why} onChange={(e) => setWhy(e.target.value)} data-return-exception-why />
          </label>
          {error ? <p role="alert" className="text-[12px] text-danger" data-return-exception-error>{error}</p> : null}
          <div className="flex items-center gap-2">
            <button type="button" onClick={submit} disabled={busy || !whyOk} className="lv-button lv-button-primary lv-button-sm" data-return-exception-submit>
              {busy ? loc('جارٍ الفتح…', 'Opening…', 'دەکرێتەوە…') : loc('فتح طلب الإرجاع', 'Open the return', 'داواکاریی گەڕاندنەوە بکەرەوە')}
            </button>
            <button type="button" onClick={() => setOpen(false)} disabled={busy} className="lv-button lv-button-ghost lv-button-sm">
              {loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە')}
            </button>
          </div>
          {!whyOk ? <p className="text-[11px] text-text-secondary">{loc('اكتب سبب الاستثناء أولاً (خمسة أحرف على الأقل).', 'Write the reason for the exception first (at least five characters).', 'سەرەتا هۆکاری ئاوارتەکە بنووسە (لانیکەم پێنج پیت).')}</p> : null}
        </div>
      )}
    </div>
  );
}
