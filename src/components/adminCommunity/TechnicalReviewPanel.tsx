/**
 * «المراجعة الفنية» — THE TECHNICAL REVIEW QUEUE (plan P1-05, docs/
 * DECISIONS.md row 267, D9). Lazy, inside the admin request board.
 *
 * The queue is the published requests made of parts whose summary asks for a
 * technical review (a part in several materials, several colours some not
 * chosen, parts in different technologies). A reviewer opens one, reads each
 * part — its materials, colours, measured or stated size and why it is
 * flagged — and confirms or reopens. The decision sends back each part with
 * the `updated_at` this read gave, so a customer edit in between answers
 * REQUEST_CHANGED and the reviewer reads again. Nothing here moves a revision
 * or an offer.
 *
 * Every word in Arabic, English and Sorani (not the board two-language `t`).
 */
import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, Loader2 } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { ApiError } from '../../lib/api';
import { refusalText } from '../../lib/refusalStrings';
import { adminCommunityApi, type AdminRequestRow, type AdminReviewPart } from '../../lib/merchant';
import { Button } from '../ui/Button';
import { StatusChip } from '../ui/Badge';
import { toast } from '../ui/Toast';
import { colourWord, materialWord, reviewAge } from './reviewWords';

type Loc = (ar: string, en: string, ckb?: string) => string;

const reasonWord = (r: string, loc: Loc) =>
  r === 'multi_material'
    ? loc('قطعة من أكثر من مادة', 'one part in more than one material', 'یەک پارچە لە زیاتر لە یەک کەرەستە')
    : r === 'multicolor_unspecified'
      ? loc('ألوان متعددة بعضها غير محدد', 'several colours, some not chosen', 'چەند ڕەنگێک، هەندێکیان دیاری نەکراون')
      : r === 'mixed_process'
        ? loc('قطع بتقنيات طباعة مختلفة (FDM وريزن)', 'parts in different print technologies (FDM and resin)', 'پارچەکان بە تەکنیکی چاپی جیاواز (FDM و ڕێزن)')
        : r;

export default function TechnicalReviewPanel({ onBack }: { onBack: () => void }) {
  const { loc, lang } = useLanguage();
  const [rows, setRows] = useState<AdminRequestRow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    setRows(null);
    adminCommunityApi
      .requests('', '', 'needs_technical_review')
      .then((d) => setRows(d.requests))
      .catch(() => setRows([]));
  }, []);
  useEffect(load, [load]);

  if (open) return <ReviewDetail id={open} loc={loc} lang={lang} onBack={() => { setOpen(null); load(); }} />;

  return (
    <div className="space-y-3" data-technical-review="queue">
      <Button size="sm" variant="ghost" onClick={onBack} icon={<ChevronLeft aria-hidden="true" className="h-4 w-4 rtl:rotate-180" />}>
        {loc('رجوع', 'Back', 'گەڕانەوە')}
      </Button>
      <h3 className="text-[14px] font-bold text-text-primary">{loc('تحتاج مراجعة فنية', 'Needs a technical review', 'پێویستی بە پێداچوونەوەی تەکنیکی هەیە')}</h3>
      {rows === null && <Loader2 aria-hidden="true" className="mx-auto h-5 w-5 animate-spin text-gold" />}
      {rows !== null && !rows.length && (
        <p className="py-6 text-center text-[13px] text-text-muted">{loc('لا طلبات بانتظار المراجعة', 'No request awaits a review', 'هیچ داواکارییەک چاوەڕوانی پێداچوونەوە نییە')}</p>
      )}
      <ul className="space-y-2">
        {rows?.map((r) => (
          <li key={r.id}>
            <Button block variant="secondary" onClick={() => setOpen(r.id)} className="!h-auto !justify-start py-3 text-start" data-technical-review-row={r.id}>
              <span className="block min-w-0">
                <bdi className="block truncate text-[13.5px] font-semibold text-text-primary">{r.title}</bdi>
                <span className="mt-0.5 block text-[11.5px] text-text-muted">
                  {loc(`عدد القطع ${r.parts_count ?? 1}`, `${r.parts_count ?? 1} parts`, `${r.parts_count ?? 1} پارچە`)} · {reviewAge(r.created_at, loc)}
                </span>
                {!!r.review_reasons?.length && (
                  <span className="mt-0.5 block text-[11.5px] text-warning">{r.review_reasons.map((x) => reasonWord(x, loc)).join(lang === 'en' ? ', ' : '، ')}</span>
                )}
              </span>
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReviewDetail({ id, loc, lang, onBack }: { id: string; loc: Loc; lang: string; onBack: () => void }) {
  const [parts, setParts] = useState<AdminReviewPart[] | null>(null);
  // The files of the request, each a Worker route that re-checks the admin on every read (never a key).
  const [files, setFiles] = useState<Array<{ id: string; file_name: string; kind: string; url?: string }>>([]);
  const [fence, setFence] = useState<Array<{ id: string; updated_at: string }>>([]);
  const [state, setState] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState<'' | 'confirmed' | 'reopen'>('');
  const sep = lang === 'en' ? ', ' : '، ';
  const L = lang === 'en' || lang === 'ckb' ? lang : 'ar';

  const load = useCallback(() => {
    setParts(null);
    adminCommunityApi
      .request(id)
      .then((d) => {
        setTitle(String(d.request.title ?? ''));
        setParts(d.model?.parts ?? []);
        setFiles(d.files ?? []);
        setFence((d.review?.parts ?? []).map((p) => ({ id: p.id, updated_at: p.updated_at })));
        setState(d.review?.state ?? '');
      })
      .catch(() => setParts([]));
  }, [id]);
  useEffect(load, [load]);

  async function decide(decision: 'confirmed' | 'reopen') {
    setBusy(decision);
    try {
      const r = await adminCommunityApi.reviewRequest(id, decision, fence);
      setState(r.review_state);
      toast.success(decision === 'confirmed' ? loc('تمت المراجعة الفنية', 'Technical review done', 'پێداچوونەوەی تەکنیکی کرا') : loc('أُعيد الطلب إلى المراجعة', 'Back under review', 'گەڕایەوە بۆ پێداچوونەوە'));
      load();
    } catch (e) {
      const code = e instanceof ApiError ? e.code ?? '' : '';
      toast.error(refusalText(code, L) || loc('تعذّر حفظ القرار', 'The decision could not be saved', 'بڕیارەکە پاشەکەوت نەکرا'));
      if (code === 'REQUEST_CHANGED') load();
    } finally {
      setBusy('');
    }
  }

  const size = (p: AdminReviewPart) => (p.stated_dims ? `${p.stated_dims.x}×${p.stated_dims.y}×${p.stated_dims.z} mm` : p.measured_file_id ? loc('مقاس من الملف', 'measured from the file', 'لە فایلەکەوە پێوراوە') : '—');

  return (
    <div className="space-y-3" data-technical-review="detail">
      <Button size="sm" variant="ghost" onClick={onBack} icon={<ChevronLeft aria-hidden="true" className="h-4 w-4 rtl:rotate-180" />}>
        {loc('رجوع', 'Back', 'گەڕانەوە')}
      </Button>
      <div className="flex items-start justify-between gap-3">
        <bdi className="min-w-0 text-[15px] font-bold text-text-primary">{title}</bdi>
        {state === 'needs_technical_review' && <StatusChip tone="warning">{loc('تحتاج مراجعة فنية', 'Needs a technical review', 'پێویستی بە پێداچوونەوەی تەکنیکی هەیە')}</StatusChip>}
        {state === 'confirmed' && <StatusChip tone="success">{loc('تمت المراجعة الفنية', 'Technical review done', 'پێداچوونەوەی تەکنیکی کرا')}</StatusChip>}
      </div>
      {parts === null && <Loader2 aria-hidden="true" className="mx-auto h-5 w-5 animate-spin text-gold" />}
      <ul className="space-y-2">
        {parts?.map((p) => (
          <li key={p.id} className="lv-surface p-3" data-technical-review-part={p.id}>
            <div className="flex items-start justify-between gap-2">
              <bdi className="min-w-0 text-[13px] font-semibold text-text-primary">{p.name.trim() || loc(`القطعة ${p.position + 1}`, `Part ${p.position + 1}`, `پارچەی ${p.position + 1}`)}</bdi>
              <span className="shrink-0 text-[12px] tabular-nums text-text-muted" dir="ltr">×{p.quantity}</span>
            </div>
            <p className="mt-1 text-[12px] text-text-secondary" dir={L === 'en' ? 'ltr' : 'rtl'} data-technical-review-materials>
              {p.materials.map((m, i) => (
                <span key={m.id ?? i}>
                  {i > 0 && sep}
                  <bdi>{m.material_unsure || !m.material_id ? loc('مادة غير محددة', 'material open', 'کەرەستە دیاری نەکراوە') : materialWord(m.material_id, L)}</bdi>
                  {m.colors.length > 0 && ' · '}
                  {m.colors.length > 0 && <bdi>{m.colors.map((c) => colourWord(c, loc, L)).join(sep)}</bdi>}
                </span>
              ))}
            </p>
            <p className="mt-0.5 text-[11.5px] text-text-muted">
              {size(p)}
              {(() => {
                const measured = p.measured_file_id ? files.find((f) => f.id === p.measured_file_id && f.url) : undefined;
                return measured ? (
                  <>
                    {' · '}
                    <a href={measured.url} target="_blank" rel="noopener noreferrer" className="font-semibold text-gold underline-offset-4 hover:underline" data-technical-review-file={measured.id}>
                      <bdi>{measured.file_name}</bdi>
                    </a>
                  </>
                ) : null;
              })()}
            </p>
            {!!p.review_reasons.length && <p className="mt-0.5 text-[11.5px] text-warning">{p.review_reasons.map((x) => reasonWord(x, loc)).join(sep)}</p>}
            {p.notes && <p className="mt-0.5 text-[11.5px] text-text-secondary" dir="auto">{p.notes}</p>}
          </li>
        ))}
      </ul>
      {/* The references the customer gave: what «as in the reference» points at, opened from the review itself. */}
      {files.some((f) => f.url) && (
        <section className="lv-surface p-3" aria-label={loc('المرفقات', 'Attachments', 'هاوپێچەکان')}>
          <h4 className="text-[12.5px] font-semibold text-text-secondary">{loc('المرفقات', 'Attachments', 'هاوپێچەکان')}</h4>
          <ul className="mt-1 space-y-1">
            {files.filter((f) => f.url).map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-3 text-[12px]">
                <a href={f.url} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate font-semibold text-gold underline-offset-4 hover:underline" data-technical-review-file={f.id}>
                  <bdi>{f.file_name}</bdi>
                </a>
                <span className="shrink-0 text-text-muted" dir="ltr">{f.kind}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {!!parts?.length && (
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => decide('confirmed')} loading={busy === 'confirmed'} disabled={!!busy} data-technical-review-confirm>
            {loc('تأكيد المراجعة', 'Confirm the review', 'پشتڕاستکردنەوەی پێداچوونەوە')}
          </Button>
          <Button variant="secondary" onClick={() => decide('reopen')} loading={busy === 'reopen'} disabled={!!busy} data-technical-review-reopen>
            {loc('إعادة فتح المراجعة', 'Reopen the review', 'دووبارە کردنەوەی پێداچوونەوە')}
          </Button>
        </div>
      )}
    </div>
  );
}
