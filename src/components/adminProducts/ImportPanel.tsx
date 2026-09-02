/**
 * Devices / Materials import — the primary bulk flow (mandate §10).
 *
 * FOUR STEPS, IN THIS ORDER, and none of them lies about the one before:
 *
 *   1. Pick a section. The columns follow it, so this comes first — there is
 *      no "generic" template to download.
 *   2. Download the template (CSV for a plain spreadsheet, ZIP when the file
 *      needs to carry images). Every download is an authenticated fetch that
 *      verifies the response BEFORE saving, so a 403 is never saved as a file.
 *   3. Upload the completed file and read the preview. The preview writes
 *      nothing; the panel says so, and the confirm button is the only thing
 *      that writes.
 *   4. Confirm, then read the report. The report is downloadable as CSV and
 *      names created / updated / skipped / failed with a reason for each.
 *
 * The section also carries an EXPORT: the same shape, filled with the
 * products already in that section. Exporting, editing in Excel and importing
 * back is the intended bulk-edit path, and the round-trip is covered by
 * tests/importCsv.test.ts and scripts/e2e-import.mjs.
 *
 * The older single TXT template is still reachable from the second tab of the
 * import dialog; it is no longer the default and no longer the only option.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Download, Upload, RefreshCw, CheckCircle2, AlertTriangle, FileText, Copy, Check, ChevronDown } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { btnPrimary, btnSecondary, inputCls, ErrorBanner } from './ui';
import { downloadAdminFile, DownloadError } from './download';

// ------------------------------------------------------------------ strings

const STRINGS = {
  ar: {
    step1: '١. اختر القسم',
    step1Hint: 'الأعمدة تتغير حسب القسم — لا يوجد قالب واحد لكل شيء.',
    sectionPlaceholder: 'اختر قسمًا…',
    noFamily: 'هذا القسم بلا عائلة قالب. حدّدها (أجهزة أو مواد) من إدارة الأقسام أولًا.',
    step2: '٢. نزّل القالب',
    csv: 'قالب CSV',
    zip: 'قالب ZIP (مع مجلد الصور)',
    exportCsv: 'تصدير منتجات القسم (CSV)',
    exportZip: 'تصدير منتجات القسم (ZIP)',
    step2Hint: 'الإدخال بالإنجليزية فقط. الترجمة إلى العربية والكردية تتم محليًا على الخادم بلا ذكاء اصطناعي.',
    step3: '٣. ارفع الملف وعاين',
    pick: 'اختر ملف CSV أو ZIP',
    preview: 'معاينة',
    previewing: 'جارٍ الفحص…',
    noWrite: 'المعاينة لا تكتب أي شيء في قاعدة البيانات.',
    step4: '٤. أكّد الاستيراد',
    confirm: 'تأكيد الاستيراد',
    confirming: 'جارٍ التنفيذ…',
    report: 'تنزيل تقرير النتيجة (CSV)',
    downloading: 'جارٍ التنزيل…',
    started: 'بدأ تنزيل {name} ({size}).',
    startedNav: 'فُتح {name} في نافذة التنزيل ({size}).',
    rowsTitle: 'الصفوف',
    colKey: 'المفتاح',
    colName: 'الاسم',
    colAction: 'النتيجة',
    colDetail: 'التفاصيل',
    create: 'إنشاء',
    update: 'تحديث',
    failed: 'مرفوض',
    created: 'أُنشئ',
    updated: 'حُدِّث',
    skipped: 'مُتخطّى',
    unknownCols: 'أعمدة غير معروفة في الملف (تُتجاهل): ',
    fileIssues: 'مشاكل عامة في الملف',
    summary: 'أُنشئ {c} — حُدِّث {u} — مُتخطّى {s} — فشل {f}',
    previewSummary: 'سيُنشأ {c} — سيُحدَّث {u} — مرفوض {f} (من {t})',
    reviewNeeded: 'حقول بقيت بالإنجليزية وتحتاج مراجعة بشرية:',
    pickFirst: 'اختر قسمًا وملفًا أولًا.',
    nothingToApply: 'لا يوجد صف صالح للتنفيذ.',
    alreadyApplied: 'هذا الاستيراد نُفّذ من قبل — هذه نتيجته المحفوظة.',
    lookupsTitle: 'القيم المتاحة لأعمدة التصنيف',
    lookupsHint:
      'هذه هي القيم التي يقبلها الملف في أعمدة category و sub_category و brand و facets و hashtags — كما هي الآن في صفحة التصنيفات. اضغط قيمة لنسخها. القالب المنزّل يحملها أيضًا في نهايته وفي lookups.csv.',
    lkCategory: 'القسم الرئيسي (category)',
    lkSub: 'القسم الفرعي (sub_category)',
    lkBrand: 'العلامة التجارية (brand)',
    lkFacet: 'الفلاتر (facets — بالـ slug)',
    lkHashtag: 'الهاشتاقات (hashtags)',
    lkEmpty: 'لا شيء بعد — أضف من صفحة التصنيفات.',
    lkHashtagFree: 'يمكن كتابة وسم جديد في الملف وسيُضاف إلى القائمة عند التأكيد.',
    copied: 'نُسخ',
  },
  en: {
    step1: '1. Choose the section',
    step1Hint: 'Columns follow the section — there is no one template for everything.',
    sectionPlaceholder: 'Choose a section…',
    noFamily: 'This section has no template family. Set it to Devices or Materials in the sections admin first.',
    step2: '2. Download the template',
    csv: 'CSV template',
    zip: 'ZIP template (with images folder)',
    exportCsv: 'Export this section (CSV)',
    exportZip: 'Export this section (ZIP)',
    step2Hint: 'English input only. Arabic and Kurdish are generated locally on the server, with no AI.',
    step3: '3. Upload and preview',
    pick: 'Choose a CSV or ZIP file',
    preview: 'Preview',
    previewing: 'Checking…',
    noWrite: 'The preview writes nothing to the database.',
    step4: '4. Confirm the import',
    confirm: 'Confirm import',
    confirming: 'Applying…',
    report: 'Download result report (CSV)',
    downloading: 'Downloading…',
    started: '{name} started downloading ({size}).',
    startedNav: '{name} opened in the download window ({size}).',
    rowsTitle: 'Rows',
    colKey: 'Key',
    colName: 'Name',
    colAction: 'Result',
    colDetail: 'Details',
    create: 'create',
    update: 'update',
    failed: 'rejected',
    created: 'created',
    updated: 'updated',
    skipped: 'skipped',
    unknownCols: 'Columns the template does not define (ignored): ',
    fileIssues: 'File-level problems',
    summary: '{c} created — {u} updated — {s} skipped — {f} failed',
    previewSummary: '{c} to create — {u} to update — {f} rejected (of {t})',
    reviewNeeded: 'Fields kept in English and needing a human review:',
    pickFirst: 'Choose a section and a file first.',
    nothingToApply: 'No valid row to apply.',
    alreadyApplied: 'This import was already applied — this is its stored result.',
    lookupsTitle: 'Accepted values for the classification columns',
    lookupsHint:
      'These are the values the file accepts in category, sub_category, brand, facets and hashtags — exactly as they stand in the taxonomy page right now. Click a value to copy it. The downloaded template also carries them at its end and in lookups.csv.',
    lkCategory: 'Main section (category)',
    lkSub: 'Sub-section (sub_category)',
    lkBrand: 'Brand (brand)',
    lkFacet: 'Filters (facets — by slug)',
    lkHashtag: 'Hashtags (hashtags)',
    lkEmpty: 'Nothing yet — add from the taxonomy page.',
    lkHashtagFree: 'A new tag may be typed into the file; it joins the list on confirm.',
    copied: 'Copied',
  },
};
const pick = (lang: string) => (lang === 'en' ? STRINGS.en : STRINGS.ar);
const fill = (tpl: string, vars: Record<string, string | number>) =>
  tpl.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));

const humanBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

// -------------------------------------------------------------------- types

interface Catalog {
  id: string;
  parent_id: string | null;
  slug: string;
  name_ar: string;
  name_en: string;
  active: boolean;
  effective_template_family: 'devices' | 'materials' | null;
  product_count: number;
}

interface Lookups {
  sections: Array<{ id: string; slug: string; name_en: string; name_ar: string; parent_id: string | null; parent_name_en: string; family: string | null }>;
  brands: Array<{ id: string; slug: string; name_en: string; name_ar: string }>;
  facets: Array<{ id: string; slug: string; name_en: string; name_ar: string; kind: string }>;
  hashtags: Array<{ tag: string; name_ar: string }>;
}

interface PreviewRow {
  key: string;
  line: number;
  action: 'create' | 'update' | 'failed';
  name: string;
  options: number;
  colors: number;
  links: number;
  images: number;
  errors: string[];
  warnings: string[];
}

interface PreviewResponse {
  success: true;
  import_id: string;
  section: { id: string; name_en: string; name_ar: string; family: string };
  columns: string[];
  unknown_columns: string[];
  file_issues: Array<{ line: number; severity: string; message: string }>;
  rows: PreviewRow[];
  summary: { total: number; create: number; update: number; failed: number };
  note: string;
}

interface ReportRow {
  key: string;
  line: number;
  action: 'created' | 'updated' | 'skipped' | 'failed';
  name: string;
  product_id: string;
  reason: string;
}

interface ConfirmResponse {
  success: true;
  import_id: string;
  already_applied?: boolean;
  summary: { created: number; updated: number; skipped: number; failed: number };
  rows: ReportRow[];
  translation_review_needed?: string[];
}

// --------------------------------------------------------------- component

export default function ImportPanel({ onApplied }: { onApplied?: () => void }) {
  const { lang } = useLanguage();
  const t = pick(lang);

  const [catalogs, setCatalogs] = useState<Catalog[]>([]);
  const [sectionId, setSectionId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [result, setResult] = useState<ConfirmResponse | null>(null);
  const [busy, setBusy] = useState<'' | 'preview' | 'confirm' | string>('');
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [lookups, setLookups] = useState<Lookups | null>(null);

  useEffect(() => {
    api
      .get<{ catalogs: Catalog[] }>('/api/admin/taxonomy/catalogs')
      .then((r) => setCatalogs(r.catalogs ?? []))
      .catch((e) => setErr(e instanceof ApiError ? e.message : String(e)));
    // The accepted classification values, read live so a section or brand
    // added a minute ago is already here.
    api
      .get<Lookups>('/api/admin/import/lookups')
      .then((r) => setLookups(r))
      .catch(() => setLookups(null));
  }, []);

  // Only sections that can actually produce a template are offered; a section
  // with no family would download a 400, and offering it is a broken button.
  const options = useMemo(
    () => catalogs.filter((c) => c.active && c.effective_template_family),
    [catalogs]
  );
  const byId = useMemo(() => new Map(catalogs.map((c) => [c.id, c])), [catalogs]);
  const section = sectionId ? byId.get(sectionId) : undefined;

  const label = (c: Catalog) => {
    const parent = c.parent_id ? byId.get(c.parent_id) : undefined;
    const own = lang === 'en' ? c.name_en || c.name_ar : c.name_ar || c.name_en;
    const head = parent ? `${lang === 'en' ? parent.name_en || parent.name_ar : parent.name_ar || parent.name_en} › ` : '';
    return `${head}${own} (${c.effective_template_family === 'devices' ? 'Devices' : 'Materials'})`;
  };

  const download = async (key: string, path: string, fallback: string, zip: boolean) => {
    setBusy(key);
    setErr(null);
    setNote(null);
    try {
      const out = await downloadAdminFile(path, fallback, {
        accept: zip ? 'application/zip' : 'text/csv',
        ext: zip ? 'zip' : 'csv',
        type: zip ? 'application/zip' : 'text/csv;charset=utf-8',
      });
      setNote(
        fill(out.method === 'navigation' ? t.startedNav : t.started, {
          name: out.filename,
          size: humanBytes(out.bytes),
        })
      );
    } catch (e) {
      setErr(e instanceof DownloadError ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const runPreview = async () => {
    if (!sectionId || !file) {
      setErr(t.pickFirst);
      return;
    }
    setBusy('preview');
    setErr(null);
    setNote(null);
    setResult(null);
    try {
      const form = new FormData();
      form.set('file', file);
      form.set('category', sectionId);
      const res = await api.post<PreviewResponse>('/api/admin/import/preview', form);
      setPreview(res);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
      setPreview(null);
    } finally {
      setBusy('');
    }
  };

  const runConfirm = async () => {
    if (!preview) return;
    if (preview.summary.create + preview.summary.update === 0) {
      setErr(t.nothingToApply);
      return;
    }
    setBusy('confirm');
    setErr(null);
    try {
      const res = await api.post<ConfirmResponse>('/api/admin/import/confirm', { import_id: preview.import_id });
      setResult(res);
      if (res.already_applied) setNote(t.alreadyApplied);
      onApplied?.();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const dlBtn = (key: string, path: string, fallback: string, text: string, zip = false) => (
    <button
      type="button"
      data-import={key}
      disabled={!sectionId || busy !== ''}
      onClick={() => download(key, path, fallback, zip)}
      className={btnSecondary + ' disabled:opacity-40'}
    >
      {busy === key ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
      {busy === key ? t.downloading : text}
    </button>
  );

  const stem = section ? section.slug : 'section';

  return (
    <div className="min-w-0 text-sm" data-panel="import-v2">
      <ErrorBanner text={err} />
      {note && (
        <div className="bg-sky-500/10 border border-sky-500/30 text-sky-200 rounded-xl p-3 mb-3 text-xs">{note}</div>
      )}

      {/* 1 ------------------------------------------------------------- */}
      <Section title={t.step1} hint={t.step1Hint}>
        <select
          data-import="section"
          value={sectionId}
          onChange={(e) => {
            setSectionId(e.target.value);
            setPreview(null);
            setResult(null);
          }}
          className={inputCls + ' w-full max-w-xl h-11'}
        >
          <option value="">{t.sectionPlaceholder}</option>
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {label(c)}
            </option>
          ))}
        </select>
        {catalogs.length > 0 && options.length === 0 && (
          <p className="text-amber-300/90 text-xs mt-2">{t.noFamily}</p>
        )}
        {lookups && <LookupsBox lookups={lookups} section={section} lang={lang} t={t} />}
      </Section>

      {/* 2 ------------------------------------------------------------- */}
      <Section title={t.step2} hint={t.step2Hint}>
        <div className="flex flex-wrap gap-2">
          {dlBtn('template-csv', `/api/admin/import/template?category=${encodeURIComponent(sectionId)}&format=csv`, `levonis-template-${stem}.csv`, t.csv)}
          {dlBtn('template-zip', `/api/admin/import/template?category=${encodeURIComponent(sectionId)}&format=zip`, `levonis-template-${stem}.zip`, t.zip, true)}
          {dlBtn('export-csv', `/api/admin/import/export?category=${encodeURIComponent(sectionId)}&format=csv`, `levonis-export-${stem}.csv`, t.exportCsv)}
          {dlBtn('export-zip', `/api/admin/import/export?category=${encodeURIComponent(sectionId)}&format=zip`, `levonis-export-${stem}.zip`, t.exportZip, true)}
        </div>
      </Section>

      {/* 3 ------------------------------------------------------------- */}
      <Section title={t.step3} hint={t.noWrite}>
        <div className="flex flex-wrap items-center gap-2">
          <label className={btnSecondary + ' cursor-pointer'}>
            <FileText className="w-4 h-4" />
            <span className="truncate max-w-[16rem]">{file ? file.name : t.pick}</span>
            <input
              type="file"
              accept=".csv,.zip,text/csv,application/zip"
              data-import="file"
              className="hidden"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setPreview(null);
                setResult(null);
              }}
            />
          </label>
          <button
            type="button"
            data-import="preview"
            disabled={!sectionId || !file || busy !== ''}
            onClick={runPreview}
            className={btnSecondary + ' disabled:opacity-40'}
          >
            {busy === 'preview' ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {busy === 'preview' ? t.previewing : t.preview}
          </button>
        </div>
      </Section>

      {preview && !result && (
        <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
          <p className="text-xs text-zinc-300 mb-2">
            {fill(t.previewSummary, {
              c: preview.summary.create,
              u: preview.summary.update,
              f: preview.summary.failed,
              t: preview.summary.total,
            })}
          </p>
          {preview.unknown_columns.length > 0 && (
            <p className="text-[11px] text-amber-300/90 mb-2" dir="ltr">
              {t.unknownCols}
              {preview.unknown_columns.join(', ')}
            </p>
          )}
          {preview.file_issues.length > 0 && (
            <div className="mb-2 rounded-lg border border-red-500/30 bg-red-500/10 p-2">
              <p className="text-[11px] font-bold text-red-300 mb-1">{t.fileIssues}</p>
              <ul className="text-[11px] text-red-200 space-y-0.5">
                {preview.file_issues.slice(0, 20).map((i, n) => (
                  <li key={n}>
                    #{i.line} — {i.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <RowTable
            rows={preview.rows.map((r) => ({
              key: r.key,
              name: r.name,
              tone: r.action === 'failed' ? 'bad' : r.action === 'create' ? 'good' : 'info',
              action: r.action === 'failed' ? t.failed : r.action === 'create' ? t.create : t.update,
              detail:
                r.errors.length > 0
                  ? r.errors.join(' · ')
                  : [
                      `${r.options} opt`,
                      `${r.colors} col`,
                      `${r.links} link`,
                      `${r.images} img`,
                      ...r.warnings,
                    ].join(' · '),
            }))}
            t={t}
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-import="confirm"
              disabled={busy !== ''}
              onClick={runConfirm}
              className={btnPrimary + ' disabled:opacity-40'}
            >
              {busy === 'confirm' ? <RefreshCw className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              {busy === 'confirm' ? t.confirming : t.confirm}
            </button>
            <span className="text-[11px] text-zinc-500">{t.noWrite}</span>
          </div>
        </div>
      )}

      {result && (
        <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
          <p className="text-xs text-zinc-200 mb-2 font-bold">
            {fill(t.summary, {
              c: result.summary.created,
              u: result.summary.updated,
              s: result.summary.skipped,
              f: result.summary.failed,
            })}
          </p>
          <RowTable
            rows={result.rows.map((r) => ({
              key: r.key,
              name: r.name,
              tone: r.action === 'failed' ? 'bad' : r.action === 'skipped' ? 'warn' : 'good',
              action:
                r.action === 'created'
                  ? t.created
                  : r.action === 'updated'
                    ? t.updated
                    : r.action === 'skipped'
                      ? t.skipped
                      : t.failed,
              detail: r.reason || r.product_id,
            }))}
            t={t}
          />
          {(result.translation_review_needed?.length ?? 0) > 0 && (
            <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2">
              <p className="text-[11px] font-bold text-amber-300 mb-1 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> {t.reviewNeeded}
              </p>
              <ul className="text-[11px] text-amber-200 space-y-0.5" dir="ltr">
                {result.translation_review_needed!.slice(0, 20).map((x, n) => (
                  <li key={n}>{x}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-3">
            {dlBtn(
              'report',
              `/api/admin/import/${encodeURIComponent(result.import_id)}/report?format=csv`,
              `levonis-import-${result.import_id}.csv`,
              t.report
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- pieces

/**
 * The accepted values of the classification columns, as copyable chips. The
 * sub-sections narrow to the chosen section's branch when one is chosen.
 */
function LookupsBox({ lookups, section, lang, t }: { lookups: Lookups; section?: Catalog; lang: string; t: typeof STRINGS.ar }) {
  // A disclosure that RENDERS nothing while closed, rather than a <details>
  // that only hides it: the four lists run to a couple of hundred values, and
  // a closed <details> still lays every one of them out — which is both waste
  // and a dialog full of controls the admin never asked to see.
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState('');
  const isEn = lang === 'en';
  const rootId = section ? (section.parent_id ?? section.id) : null;
  const roots = lookups.sections.filter((s) => !s.parent_id);
  const subs = lookups.sections.filter((s) => !!s.parent_id && (!rootId || s.parent_id === rootId));
  const copy = async (v: string) => {
    try {
      await navigator.clipboard.writeText(v);
      setCopied(v);
      window.setTimeout(() => setCopied((c) => (c === v ? '' : c)), 1200);
    } catch {
      /* clipboard unavailable: the value is still readable on the chip */
    }
  };
  const chips = (items: Array<{ key: string; value: string; label?: string; title?: string }>, group: string) =>
    items.length === 0 ? (
      <p className="text-[11px] text-zinc-500">{t.lkEmpty}</p>
    ) : (
      <div className="flex flex-wrap gap-1" data-lookup-group={group}>
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            onClick={() => void copy(it.value)}
            title={it.title ?? it.value}
            className={`inline-flex items-center gap-1 min-h-9 px-2.5 rounded-full border text-[11px] transition-colors ${
              copied === it.value ? 'border-emerald-500/50 text-emerald-300 bg-emerald-500/10' : 'border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:text-white'
            }`}
            data-lookup-value={it.value}
          >
            {copied === it.value ? <Check className="w-3 h-3" aria-hidden /> : <Copy className="w-3 h-3 opacity-60" aria-hidden />}
            <span dir="ltr">{it.value}</span>
            {it.label && <span className="text-zinc-500">· {it.label}</span>}
            {copied === it.value && <span className="sr-only">{t.copied}</span>}
          </button>
        ))}
      </div>
    );
  const facetKinds = [...new Set(lookups.facets.map((f) => f.kind))];
  return (
    <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-900/40" data-import="lookups">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-import="lookups-toggle"
        className="w-full flex items-center gap-2 px-3 min-h-10 text-xs font-bold text-white text-start"
      >
        <ChevronDown className={`w-4 h-4 shrink-0 transition-transform ${open ? '' : '-rotate-90 rtl:rotate-90'}`} aria-hidden />
        <span className="min-w-0 truncate">{t.lookupsTitle}</span>
      </button>
      {!open ? null : (
      <div className="px-3 pb-3 space-y-3 max-h-80 overflow-y-auto">
        <p className="text-[11px] text-zinc-500">{t.lookupsHint}</p>
        <div role="status" aria-live="polite" className="sr-only">
          {copied ? `${t.copied}: ${copied}` : ''}
        </div>
        <div>
          <h5 className="text-[11px] font-bold text-zinc-300 mb-1">{t.lkCategory}</h5>
          {chips(roots.map((s) => ({ key: s.id, value: s.slug, label: isEn ? s.name_en : s.name_ar || s.name_en })), 'category')}
        </div>
        <div>
          <h5 className="text-[11px] font-bold text-zinc-300 mb-1">{t.lkSub}</h5>
          {chips(subs.map((s) => ({ key: s.id, value: s.slug, label: rootId ? (isEn ? s.name_en : s.name_ar || s.name_en) : s.parent_name_en })), 'sub_category')}
        </div>
        <div>
          <h5 className="text-[11px] font-bold text-zinc-300 mb-1">{t.lkBrand}</h5>
          {chips(lookups.brands.map((b) => ({ key: b.id, value: b.slug, label: isEn ? b.name_en : b.name_ar || b.name_en })), 'brand')}
        </div>
        <div>
          <h5 className="text-[11px] font-bold text-zinc-300 mb-1">{t.lkFacet}</h5>
          {facetKinds.length === 0
            ? chips([], 'facets')
            : facetKinds.map((kind) => (
                <div key={kind} className="mb-1.5">
                  <span className="block text-[10px] text-zinc-500 mb-0.5" dir="ltr">
                    {kind}
                  </span>
                  {chips(lookups.facets.filter((f) => f.kind === kind).map((f) => ({ key: f.id, value: f.slug, label: isEn ? f.name_en : f.name_ar || f.name_en })), `facets:${kind}`)}
                </div>
              ))}
        </div>
        <div>
          <h5 className="text-[11px] font-bold text-zinc-300 mb-1">{t.lkHashtag}</h5>
          {chips(lookups.hashtags.map((h) => ({ key: h.tag, value: h.tag, label: h.name_ar || undefined })), 'hashtags')}
          <p className="text-[10px] text-zinc-500 mt-1">{t.lkHashtagFree}</p>
        </div>
      </div>
      )}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mt-4 first:mt-0">
      <h4 className="text-xs font-bold text-white mb-1">{title}</h4>
      {hint && <p className="text-[11px] text-zinc-500 mb-2">{hint}</p>}
      {children}
    </section>
  );
}

interface DisplayRow {
  key: string;
  name: string;
  action: string;
  detail: string;
  tone: 'good' | 'bad' | 'warn' | 'info';
}

const TONE = {
  good: 'text-emerald-300',
  bad: 'text-red-300',
  warn: 'text-amber-300',
  info: 'text-sky-300',
};

function RowTable({ rows, t }: { rows: DisplayRow[]; t: typeof STRINGS.ar }) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto -mx-1 px-1">
      <table className="w-full text-[11px] border-collapse min-w-[32rem]">
        <thead>
          <tr className="text-zinc-500 text-start">
            <th className="text-start font-bold py-1 pe-2">{t.colKey}</th>
            <th className="text-start font-bold py-1 pe-2">{t.colName}</th>
            <th className="text-start font-bold py-1 pe-2">{t.colAction}</th>
            <th className="text-start font-bold py-1">{t.colDetail}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.key}-${i}`} className="border-t border-zinc-800/60 align-top">
              {/* The cell keeps the table's direction so the columns stay
                  aligned; only the Latin text inside it is forced LTR. */}
              <td className="py-1 pe-2 font-mono text-zinc-300">
                <span dir="ltr">{r.key}</span>
              </td>
              <td className="py-1 pe-2 text-zinc-300">
                <span dir="ltr">{r.name}</span>
              </td>
              <td className={`py-1 pe-2 font-bold ${TONE[r.tone]}`}>{r.action}</td>
              <td className="py-1 text-zinc-400 break-words">{r.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
