/**
 * استيراد وتصدير — deterministic TXT template workflow (mandate §6, NO AI).
 *
 *  - DOWNLOAD (§6.1): blank template / worked example / export of the current
 *    product, through `downloadAdminTextFile` — an authenticated fetch that
 *    verifies the response before writing anything to disk and uses the
 *    blob + revoke-after-click pattern that actually saves on iPad Safari.
 *    A failed download says why; it never leaves a JSON error saved as .txt.
 *  - PREVIEW: paste or upload a completed TXT → POST /parse → sectioned
 *    preview/diff dialog. Parse WRITES NOTHING.
 *  - CONFIRM: POST /apply only on explicit confirm, in a sticky footer that
 *    cannot hide behind the sidebar or the on-screen keyboard. The server's
 *    confirm-once guard makes a double submission of the same batch resolve
 *    to one product; `already_applied` is reported as such, not as a new one.
 *  - REPORT (§6.1): every accepted and rejected row is listed with its
 *    reason — never a truncated "first five" — and can be copied as text.
 *  - ZIP: server parse-zip results per file; applying uses the locally
 *    unzipped text per file, so one bad file never hides the others.
 */

import React, { useState, useMemo, useEffect } from 'react';
import { unzipSync, strFromU8 } from 'fflate';
import {
  Download, Upload, FileText, AlertTriangle, Check, Plus, ClipboardCopy, RefreshCw,
} from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { downloadAdminTextFile, DownloadError } from './download';
import type {
  ParseResponse, ApplyResponse, ZipParseResponse, ZipFileResult, DuplicateChoice,
  NeedsReviewEntry, BrandResponse,
} from './types';
import { L, Section, Modal, inputCls, btnPrimary, btnSecondary } from './ui';

const NULL_TOKEN = '__NULL__';

const STRINGS = {
  ar: {
    sectionTitle: 'استيراد وتصدير',
    intro: 'القالب النصي هو المسار الرسمي للترجمات والاستيراد الجماعي — بلا أي ذكاء اصطناعي، ومعاينة قبل أي كتابة.',
    blank: 'قالب فارغ',
    example: 'مثال معبّأ',
    exportOne: 'تصدير هذا المنتج',
    downloading: 'جارٍ التنزيل…',
    started: 'بدأ تنزيل «{name}» ({size}). ابحث عنه في تطبيق الملفات إن لم يظهر فوراً.',
    startedNav: 'فُتح «{name}» عبر تنزيل مباشر — احفظه من المتصفح.',
    downloadHint: 'القالب الفارغ يشرح كل حقل؛ المجموعات المتكررة معطّلة بعلامة # حتى تحتاجها. المثال ملف صالح يُنشئ مسودة فقط.',
    pasteLabel: 'قالب TXT مكتمل',
    pasteHint: 'الصق النص أو ارفع ملف .txt — لن يُكتب شيء قبل المعاينة والتأكيد',
    upload: 'رفع ملف TXT',
    preview: 'معاينة',
    previewing: 'جارٍ التحليل…',
    parseFailed: 'فشل التحليل',
    modalTitle: 'معاينة القالب قبل التطبيق',
    createDraft: 'إنشاء منتج جديد (مسودة)',
    updateExisting: 'تحديث منتج موجود',
    counts: 'سيُطبق {a} · يُمسح {c} · يُحافَظ على {p}',
    errorsTitle: 'أخطاء — يمنع التطبيق',
    validationTitle: 'خطأ تحقق',
    needsReviewTitle: 'بحاجة لمراجعة — يمنع التطبيق',
    unknownTitle: 'مفاتيح غير معروفة (تُتجاهل)',
    warningsTitle: 'تنبيهات',
    diffTitle: 'الفروقات (قبل ← بعد)',
    noChanges: 'لا تغييرات',
    field: 'الحقل',
    before: 'قبل',
    after: 'بعد',
    confirmCreate: 'تأكيد الإنشاء كمسودة',
    confirmUpdate: 'تأكيد التحديث',
    applying: 'جارٍ التطبيق…',
    cancel: 'إلغاء',
    blockedHint: 'عالج الأخطاء وبنود المراجعة أولاً — التطبيق معطّل بأمانة.',
    applyFailed: 'فشل التطبيق',
    dupTitle: 'يوجد منتج بنفس الاسم/الرابط — اختر طريقة المتابعة',
    dupUpdate: 'تحديث المنتج الموجود',
    dupNew: 'إنشاء مسودة جديدة بهوية جديدة',
    zipTitle: 'استيراد جماعي (ZIP)',
    zipHint: 'كل ملف يُحلَّل ويُطبَّق على حدة — ملف خاطئ لا يخفي البقية',
    zipUpload: 'رفع ملف ZIP',
    zipFailed: 'فشل رفع ZIP',
    zipLocalFailed: 'تعذّر فك الضغط محلياً — تظهر نتائج التحليل لكن التطبيق يتطلب رفع كل ملف عبر مسار الملف المفرد.',
    skippedNotTxt: 'تم تجاهل ملفات ليست ‎.txt',
    skippedOverLimit: 'تجاوزت الحد الأقصى — لم تُحلَّل',
    applyAllReady: 'تطبيق كل الجاهز ({n})',
    notReady: 'غير جاهز',
    applyDraft: 'تطبيق (مسودة)',
    applyUpdate: 'تطبيق التحديث',
    createdDraft: 'أُنشئت مسودة',
    updated: 'حُدّث',
    alreadyApplied: 'مطبَّقة مسبقاً — لم يُنشأ منتج ثانٍ',
    reportTitle: 'تقرير الاستيراد الكامل',
    reportHint: 'كل صف مقبول ومرفوض مع سببه — بلا اقتصار على أول خمسة.',
    accepted: 'مقبول',
    rejected: 'مرفوض',
    pending: 'بانتظار التأكيد',
    copyReport: 'نسخ التقرير',
    copied: 'نُسخ',
    line: 'سطر',
    inProgress: 'الدفعة نفسها قيد التطبيق — انتظر النتيجة قبل إعادة المحاولة.',
  },
  en: {
    sectionTitle: 'Import & export (TXT template)',
    intro: 'The TXT template is the official path for translations and bulk import — no AI, and a preview before any write.',
    blank: 'Blank template',
    example: 'Filled example',
    exportOne: 'Export this product',
    downloading: 'Downloading…',
    started: 'Download of "{name}" started ({size}). Check the Files app if it does not appear.',
    startedNav: '"{name}" opened as a direct download — save it from the browser.',
    downloadHint: 'The blank documents every field; repeated groups ship commented out until you need them. The example is a valid file that only ever creates a draft.',
    pasteLabel: 'Completed TXT template',
    pasteHint: 'Paste the text or upload a .txt file — nothing is written before preview and confirm',
    upload: 'Upload TXT',
    preview: 'Preview',
    previewing: 'Parsing…',
    parseFailed: 'Parse failed',
    modalTitle: 'Template preview & diff',
    createDraft: 'Create new product (draft)',
    updateExisting: 'Update existing product',
    counts: '{a} applied · {c} cleared · {p} preserved',
    errorsTitle: 'Errors (blocking)',
    validationTitle: 'Validation error',
    needsReviewTitle: 'Needs review (blocking)',
    unknownTitle: 'Unknown keys (ignored)',
    warningsTitle: 'Warnings',
    diffTitle: 'Diff (before → after)',
    noChanges: 'No changes',
    field: 'Field',
    before: 'Before',
    after: 'After',
    confirmCreate: 'Confirm create draft',
    confirmUpdate: 'Confirm update',
    applying: 'Applying…',
    cancel: 'Cancel',
    blockedHint: 'Fix the errors and review items first — apply is honestly disabled.',
    applyFailed: 'Apply failed',
    dupTitle: 'A product with the same name/slug exists — choose how to proceed',
    dupUpdate: 'Update the existing product',
    dupNew: 'Create a new draft with a new identity',
    zipTitle: 'Bulk import (ZIP of .txt)',
    zipHint: 'Each file is parsed and applied on its own — one bad file never hides the rest',
    zipUpload: 'Upload ZIP',
    zipFailed: 'ZIP upload failed',
    zipLocalFailed: 'Could not unzip locally — parse results are shown, but applying needs each file through the single-file flow.',
    skippedNotTxt: 'Skipped non-.txt entries',
    skippedOverLimit: 'Over the per-archive limit — not parsed',
    applyAllReady: 'Apply all ready ({n})',
    notReady: 'Not ready',
    applyDraft: 'Apply (draft)',
    applyUpdate: 'Apply update',
    createdDraft: 'Draft created',
    updated: 'Updated',
    alreadyApplied: 'Already applied — no second product was created',
    reportTitle: 'Full import report',
    reportHint: 'Every accepted and rejected row with its reason — never just the first five.',
    accepted: 'Accepted',
    rejected: 'Rejected',
    pending: 'Awaiting confirm',
    copyReport: 'Copy report',
    copied: 'Copied',
    line: 'line',
    inProgress: 'The same batch is being applied — wait for the result before retrying.',
  },
  ckb: {
    sectionTitle: 'هاوردە و ناردنی دەرەوە (قاڵبی TXT)',
    intro: 'قاڵبی دەقی ڕێگای فەرمییە بۆ وەرگێڕان و هاوردەی کۆمەڵ — بەبێ AI، و پێشبینین پێش هەر نووسینێک.',
    blank: 'قاڵبی بەتاڵ',
    example: 'نموونەی پڕکراوە',
    exportOne: 'ناردنی ئەم بەرهەمە',
    downloading: 'داگرتن…',
    started: 'داگرتنی «{name}» دەستیپێکرد ({size}).',
    startedNav: '«{name}» بە داگرتنی ڕاستەوخۆ کرایەوە — لە وێبگەڕ پاشەکەوتی بکە.',
    downloadHint: 'قاڵبی بەتاڵ هەموو خانەیەک ڕوون دەکاتەوە؛ نموونەکە تەنها ڕەشنووس دروست دەکات.',
    pasteLabel: 'قاڵبی TXT ی تەواوکراو',
    pasteHint: 'دەقەکە بلکێنە یان فایلی .txt باربکە — هیچ نانووسرێت پێش پێشبینین و پشتڕاستکردنەوە',
    upload: 'بارکردنی TXT',
    preview: 'پێشبینین',
    previewing: 'شیکردنەوە…',
    parseFailed: 'شیکردنەوە شکستی هێنا',
    modalTitle: 'پێشبینینی قاڵب پێش جێبەجێکردن',
    createDraft: 'دروستکردنی بەرهەمی نوێ (ڕەشنووس)',
    updateExisting: 'نوێکردنەوەی بەرهەمی هەبوو',
    counts: '{a} جێبەجێ · {c} سڕاوە · {p} پارێزراو',
    errorsTitle: 'هەڵەکان — ڕێگری لە جێبەجێکردن',
    validationTitle: 'هەڵەی پشکنین',
    needsReviewTitle: 'پێویستی بە پێداچوونەوەیە — ڕێگری',
    unknownTitle: 'کلیلی نەناسراو (پشتگوێ دەخرێن)',
    warningsTitle: 'ئاگادارییەکان',
    diffTitle: 'جیاوازییەکان (پێش ← دوای)',
    noChanges: 'هیچ گۆڕانکارییەک نییە',
    field: 'خانە',
    before: 'پێش',
    after: 'دوای',
    confirmCreate: 'پشتڕاستکردنەوەی دروستکردن وەک ڕەشنووس',
    confirmUpdate: 'پشتڕاستکردنەوەی نوێکردنەوە',
    applying: 'جێبەجێکردن…',
    cancel: 'پاشگەزبوونەوە',
    blockedHint: 'سەرەتا هەڵەکان چارەسەر بکە — جێبەجێکردن ناچالاکە.',
    applyFailed: 'جێبەجێکردن شکستی هێنا',
    dupTitle: 'بەرهەمێک بە هەمان ناو/بەستەر هەیە — ڕێگا هەڵبژێرە',
    dupUpdate: 'نوێکردنەوەی بەرهەمی هەبوو',
    dupNew: 'دروستکردنی ڕەشنووسی نوێ بە ناسنامەی نوێ',
    zipTitle: 'هاوردەی کۆمەڵ (ZIP)',
    zipHint: 'هەر فایلێک بە جیا شی دەکرێتەوە — فایلێکی هەڵە ئەوانی تر نائاشکرا ناکات',
    zipUpload: 'بارکردنی ZIP',
    zipFailed: 'بارکردنی ZIP شکستی هێنا',
    zipLocalFailed: 'نەتوانرا لە ناوخۆ بکرێتەوە — ئەنجامی شیکردنەوە دیارە بەڵام جێبەجێکردن پێویستی بە ڕێگای تاکە فایلە.',
    skippedNotTxt: 'فایلە ناـ.txt ەکان پشتگوێ خران',
    skippedOverLimit: 'زیاتر لە سنوور — شی نەکرانەوە',
    applyAllReady: 'جێبەجێکردنی هەموو ئامادەکان ({n})',
    notReady: 'ئامادە نییە',
    applyDraft: 'جێبەجێکردن (ڕەشنووس)',
    applyUpdate: 'جێبەجێکردنی نوێکردنەوە',
    createdDraft: 'ڕەشنووس دروستکرا',
    updated: 'نوێکرایەوە',
    alreadyApplied: 'پێشتر جێبەجێکراوە — بەرهەمی دووەم دروست نەکرا',
    reportTitle: 'ڕاپۆرتی تەواوی هاوردە',
    reportHint: 'هەموو ڕیزێکی پەسەندکراو و ڕەتکراوە لەگەڵ هۆکارەکەی.',
    accepted: 'پەسەندکراو',
    rejected: 'ڕەتکراوە',
    pending: 'چاوەڕێی پشتڕاستکردنەوە',
    copyReport: 'کۆپیکردنی ڕاپۆرت',
    copied: 'کۆپی کرا',
    line: 'دێڕ',
    inProgress: 'هەمان کۆمەڵە لە جێبەجێکردندایە — چاوەڕێی ئەنجام بکە.',
  },
} as const;

type Strings = typeof STRINGS['ar'];

function useStrings(): Strings {
  const { lang } = useLanguage();
  return (STRINGS[lang] ?? STRINGS.ar) as Strings;
}

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k) => String(vars[k] ?? m));
}

function humanBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

function tokenLabel(v: string | null): React.ReactNode {
  if (v === null) return <span className="text-zinc-600 italic">غير موجود / absent</span>;
  if (v === NULL_TOKEN) return <span className="text-zinc-500 italic">فارغ (موروث) / null</span>;
  if (v === '') return <span className="text-zinc-600 italic">نص فارغ / empty</span>;
  return <span dir="auto" className="break-words">{v}</span>;
}

export default function TemplateTools({
  productId,
  onApplied,
  insideSection = true,
  onDirtyChange,
}: {
  productId?: string;
  onApplied: (productId: string) => void;
  insideSection?: boolean;
  /** Reports unapplied template text upward so the host dialog can warn
   *  before dismissing it (§6.2). */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const t = useStrings();
  const body = (
    <div>
      <DownloadRow productId={productId} />
      <SingleTxtFlow onApplied={onApplied} onDirtyChange={onDirtyChange} />
      <ZipFlow onApplied={onApplied} />
    </div>
  );
  if (!insideSection) return body;
  return (
    <Section ar={STRINGS.ar.sectionTitle} en={STRINGS.en.sectionTitle}>
      <p className="text-xs text-zinc-500 mb-4">{t.intro}</p>
      {body}
    </Section>
  );
}

// ---------------------------------------------------------------- downloads

type DlState =
  | { phase: 'idle' }
  | { phase: 'busy'; key: string }
  | { phase: 'done'; key: string; message: string }
  | { phase: 'error'; key: string; message: string };

function DownloadRow({ productId }: { productId?: string }) {
  const t = useStrings();
  const [state, setState] = useState<DlState>({ phase: 'idle' });

  const run = async (key: string, path: string, fallback: string) => {
    if (state.phase === 'busy') return;
    setState({ phase: 'busy', key });
    try {
      const out = await downloadAdminTextFile(path, fallback);
      setState({
        phase: 'done',
        key,
        message: fill(out.method === 'navigation' ? t.startedNav : t.started, {
          name: out.filename,
          size: humanBytes(out.bytes),
        }),
      });
    } catch (e) {
      setState({
        phase: 'error',
        key,
        message: e instanceof DownloadError ? e.message : t.parseFailed,
      });
    }
  };

  const btn = (key: string, path: string, fallback: string, label: string) => (
    <button
      type="button"
      onClick={() => run(key, path, fallback)}
      disabled={state.phase === 'busy'}
      className={btnSecondary}
    >
      {state.phase === 'busy' && state.key === key ? (
        <RefreshCw className="w-4 h-4 animate-spin" />
      ) : (
        <Download className="w-4 h-4" />
      )}
      {state.phase === 'busy' && state.key === key ? t.downloading : label}
    </button>
  );

  return (
    <div className="mb-5">
      <div className="flex flex-wrap gap-2">
        {btn('blank', '/api/admin/template/blank', 'levonis-product-template.txt', t.blank)}
        {btn('example', '/api/admin/template/example', 'levonis-product-template-example.txt', t.example)}
        {productId &&
          btn(
            'export',
            `/api/admin/template/export/${productId}`,
            `levonis-product-${productId}.txt`,
            t.exportOne
          )}
      </div>
      <p className="text-[11px] text-zinc-500 mt-2">{t.downloadHint}</p>
      {state.phase === 'done' && (
        <div className="text-emerald-400 text-xs mt-2" role="status">{state.message}</div>
      )}
      {state.phase === 'error' && (
        <div className="text-red-400 text-xs mt-2" role="alert">{state.message}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- single TXT

function SingleTxtFlow({
  onApplied, onDirtyChange,
}: {
  onApplied: (id: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const t = useStrings();
  const [text, setText] = useState('');
  const [parsing, setParsing] = useState(false);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [parseRes, setParseRes] = useState<ParseResponse | null>(null);
  const [open, setOpen] = useState(false);

  // Unapplied text is "dirty" for the host dialog (§6.2).
  useEffect(() => {
    onDirtyChange?.(text.trim().length > 0);
  }, [text, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const parse = async (src0?: string) => {
    const src = src0 ?? text;
    if (!src.trim() || parsing) return;
    setParsing(true); setParseErr(null);
    try {
      const res = await api.post<ParseResponse>('/api/admin/template/parse', { text: src });
      setParseRes(res);
      setOpen(true);
    } catch (e) {
      setParseErr(e instanceof ApiError ? e.message : t.parseFailed);
    } finally {
      setParsing(false);
    }
  };

  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-3 sm:p-4 mb-4">
      <L ar={STRINGS.ar.pasteLabel} en={STRINGS.en.pasteLabel} hint={t.pasteHint} />
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        dir="ltr"
        placeholder="name_ar=…"
        className={inputCls + ' h-32 font-mono text-xs'}
      />
      <div className="flex flex-wrap gap-2 mt-3">
        <label className={btnSecondary + ' cursor-pointer'}>
          <Upload className="w-4 h-4" /> {t.upload}
          <input type="file" className="hidden" accept=".txt,text/plain" onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            const content = await f.text();
            setText(content);
            parse(content);
          }} />
        </label>
        <button type="button" onClick={() => parse()} disabled={parsing || !text.trim()} className={btnPrimary}>
          <FileText className="w-4 h-4" /> {parsing ? t.previewing : t.preview}
        </button>
      </div>
      {parseErr && <div className="text-red-400 text-sm mt-2" role="alert">{parseErr}</div>}

      {open && parseRes && (
        <ParsePreviewModal
          text={text}
          res={parseRes}
          onReparse={() => parse()}
          onClose={() => setOpen(false)}
          onApplied={(id) => { setOpen(false); setText(''); setParseRes(null); onApplied(id); }}
        />
      )}
    </div>
  );
}

function ParsePreviewModal({
  text, res, onClose, onReparse, onApplied,
}: {
  text: string;
  res: ParseResponse;
  onClose: () => void;
  onReparse: () => void;
  onApplied: (id: string) => void;
}) {
  const t = useStrings();
  const [applying, setApplying] = useState(false);
  const [applyErr, setApplyErr] = useState<string | null>(null);
  const [dupPending, setDupPending] = useState(false);
  const [result, setResult] = useState<ApplyResponse | null>(null);

  const hasErrors = res.errors.length > 0 || !!res.validation_error;
  const blocked = hasErrors || res.needs_review.length > 0;
  const mode: 'draft' | 'update' = res.product_id ? 'update' : 'draft';

  const apply = async (choice?: DuplicateChoice) => {
    if (applying) return;
    setApplying(true); setApplyErr(null);
    try {
      const out = await api.post<ApplyResponse>('/api/admin/template/apply', {
        text, mode, confirm: true, duplicate_choice: choice,
      });
      setResult(out);
      // `already_applied` means the confirm-once guard recognised this batch;
      // the list still needs refreshing, but nothing new was created.
      onApplied(out.product_id);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DUPLICATE') {
        setDupPending(true);
      } else if (e instanceof ApiError && e.code === 'APPLY_IN_PROGRESS') {
        setApplyErr(t.inProgress);
      } else {
        setApplyErr(e instanceof ApiError ? e.message : t.applyFailed);
      }
    } finally {
      setApplying(false);
    }
  };

  const footer = dupPending ? (
    <DuplicateChoiceBox applying={applying} onChoice={(c) => apply(c)} onCancel={() => setDupPending(false)} />
  ) : (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={blocked || applying || !!result} onClick={() => apply()} className={btnPrimary}>
        <Check className="w-4 h-4" />
        {applying ? t.applying : res.is_create ? t.confirmCreate : t.confirmUpdate}
      </button>
      <button type="button" onClick={onClose} className={btnSecondary}>{t.cancel}</button>
      {blocked && <span className="text-[11px] text-amber-400">{t.blockedHint}</span>}
    </div>
  );

  return (
    <Modal wide titleAr={STRINGS.ar.modalTitle} titleEn={STRINGS.en.modalTitle} onClose={onClose} footer={footer}>
      <div className="flex flex-wrap items-center gap-2 mb-4 text-xs">
        <span className={`px-2 py-1 rounded-lg border font-bold ${res.is_create ? 'bg-sky-500/10 text-sky-400 border-sky-500/30' : 'bg-violet-500/10 text-violet-400 border-violet-500/30'}`}>
          {res.is_create ? t.createDraft : `${t.updateExisting} ${res.product_id}`}
        </span>
        <span className="text-zinc-500">
          {fill(t.counts, { a: res.applied_fields.length, c: res.cleared_fields.length, p: res.preserved_fields.length })}
        </span>
      </div>

      {result && (
        <div className={`rounded-xl p-3 mb-3 border text-xs ${result.already_applied ? 'bg-amber-500/10 border-amber-500/30 text-amber-300' : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'}`}>
          <span className="font-bold">
            {result.already_applied ? t.alreadyApplied : result.created ? t.createdDraft : t.updated}
          </span>
          <span className="font-mono mx-2" dir="ltr">{result.product_id}</span>
          {result.warnings.map((w, i) => <div key={i} className="mt-1 opacity-90">{w}</div>)}
        </div>
      )}

      {res.errors.length > 0 && (
        <Block tone="red" titleAr={STRINGS.ar.errorsTitle} titleEn={STRINGS.en.errorsTitle}>
          <ul className="list-disc ms-5 text-xs">
            {res.errors.map((e, i) => (
              <li key={`${e.line}-${e.key}-${i}`}>
                {t.line} {e.line} — <span className="font-mono">{e.key || '—'}</span>: {e.message}
              </li>
            ))}
          </ul>
        </Block>
      )}

      {res.validation_error && (
        <Block tone="red" titleAr={STRINGS.ar.validationTitle} titleEn={STRINGS.en.validationTitle}>
          <div className="text-xs">{res.validation_error.message}</div>
        </Block>
      )}

      {res.needs_review.length > 0 && (
        <NeedsReviewBlock entries={res.needs_review} onResolved={onReparse} />
      )}

      {res.unknown_keys.length > 0 && (
        <Block tone="amber" titleAr={STRINGS.ar.unknownTitle} titleEn={STRINGS.en.unknownTitle}>
          <div className="flex flex-wrap gap-1.5">
            {res.unknown_keys.map((k) => (
              <span key={k} className="font-mono text-[10px] bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-400">{k}</span>
            ))}
          </div>
        </Block>
      )}

      {res.warnings.length > 0 && (
        <Block tone="amber" titleAr={STRINGS.ar.warningsTitle} titleEn={STRINGS.en.warningsTitle}>
          <ul className="list-disc ms-5 text-xs">
            {res.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </Block>
      )}

      <div>
        <L ar={STRINGS.ar.diffTitle} en={STRINGS.en.diffTitle} />
        {res.diff.length === 0 ? (
          <div className="text-zinc-500 text-sm">{t.noChanges}</div>
        ) : (
          <div className="border border-zinc-800 rounded-xl overflow-hidden">
            <div className="max-h-72 overflow-y-auto overflow-x-auto overscroll-contain">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-zinc-900">
                  <tr className="text-zinc-500">
                    <th className="p-2 text-start font-bold">{t.field}</th>
                    <th className="p-2 text-start font-bold">{t.before}</th>
                    <th className="p-2 text-start font-bold">{t.after}</th>
                  </tr>
                </thead>
                <tbody>
                  {res.diff.map((d) => (
                    <tr key={d.field} className="border-t border-zinc-800/70 align-top">
                      <td className="p-2 font-mono text-zinc-400 whitespace-nowrap" dir="ltr">{d.field}</td>
                      <td className="p-2 text-zinc-500 min-w-0">{tokenLabel(d.before)}</td>
                      <td className="p-2 text-zinc-200 min-w-0">{tokenLabel(d.after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {applyErr && <div className="text-red-400 text-sm mt-3" role="alert">{applyErr}</div>}
    </Modal>
  );
}

function DuplicateChoiceBox({
  applying, onChoice, onCancel,
}: {
  applying: boolean;
  onChoice: (c: DuplicateChoice) => void;
  onCancel: () => void;
}) {
  const t = useStrings();
  return (
    <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3">
      <div className="text-amber-300 font-bold text-xs mb-2 flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        {t.dupTitle}
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={applying} onClick={() => onChoice('update_existing')} className={btnPrimary}>
          {t.dupUpdate}
        </button>
        <button type="button" disabled={applying} onClick={() => onChoice('create_hidden_draft_new_identity')} className={btnSecondary}>
          {t.dupNew}
        </button>
        <button type="button" disabled={applying} onClick={onCancel} className={btnSecondary}>
          {t.cancel}
        </button>
      </div>
    </div>
  );
}

function NeedsReviewBlock({ entries, onResolved }: { entries: NeedsReviewEntry[]; onResolved: () => void }) {
  const t = useStrings();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const createRef = async (entry: NeedsReviewEntry) => {
    const k = `${entry.key}:${entry.value}`;
    setBusyKey(k); setErr(null);
    try {
      if (entry.key === 'brand') {
        await api.post<BrandResponse>('/api/admin/products-v2/brands', { name_ar: entry.value, name_en: entry.value });
      } else if (entry.key === 'catalogs') {
        await api.post('/api/admin/products-v2/catalogs', { name_ar: entry.value, name_en: entry.value });
      }
      onResolved(); // re-parse; if the slug still mismatches, the entry stays visible
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'فشل الإنشاء / create failed');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <Block tone="amber" titleAr={STRINGS.ar.needsReviewTitle} titleEn={STRINGS.en.needsReviewTitle}>
      {err && <div className="text-red-400 text-xs mb-2" role="alert">{err}</div>}
      <ul className="flex flex-col gap-2">
        {entries.map((n, i) => (
          <li key={`${n.key}-${n.value}-${i}`} className="flex flex-wrap items-center gap-2 text-xs min-w-0">
            <span className="font-mono bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5">{n.key}</span>
            <span className="text-zinc-300" dir="auto">«{n.value}»</span>
            <span className="text-zinc-500">{n.message} ({t.line} {n.line})</span>
            {(n.key === 'brand' || n.key === 'catalogs') && (
              <button
                type="button"
                disabled={busyKey === `${n.key}:${n.value}`}
                onClick={() => createRef(n)}
                className="inline-flex items-center gap-1 text-[#6B46FF] font-bold hover:underline disabled:opacity-50"
              >
                <Plus className="w-3 h-3" />
                {n.key === 'brand' ? 'إنشاء العلامة ثم إعادة التحليل' : 'إنشاء التصنيف ثم إعادة التحليل'}
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="text-[10px] text-zinc-500 mt-2">
        الإنشاء فعلي ومسجَّل — إن بقي البند بعد إعادة التحليل فصحّح القيمة في القالب (لا إنشاء صامت أبداً).
      </p>
    </Block>
  );
}

function Block({ tone, titleAr, titleEn, children }: {
  tone: 'red' | 'amber';
  titleAr: string; titleEn: string;
  children: React.ReactNode;
}) {
  const cls = tone === 'red'
    ? 'bg-red-500/10 border-red-500/30 text-red-300'
    : 'bg-amber-500/10 border-amber-500/30 text-amber-300';
  return (
    <div className={`border rounded-xl p-3 mb-3 ${cls}`}>
      <div className="font-bold text-xs mb-2">{titleAr} <span className="opacity-60">{titleEn}</span></div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- ZIP flow

type ZipFileState =
  | { phase: 'idle' }
  | { phase: 'applying' }
  | { phase: 'applied'; productId: string; created: boolean; alreadyApplied: boolean }
  | { phase: 'duplicate' }
  | { phase: 'error'; message: string };

interface ReportRow {
  name: string;
  status: 'accepted' | 'rejected' | 'pending';
  detail: string;
  reasons: string[];
}

function ZipFlow({ onApplied }: { onApplied: (id: string) => void }) {
  const t = useStrings();
  const [uploading, setUploading] = useState(false);
  const [zipErr, setZipErr] = useState<string | null>(null);
  const [result, setResult] = useState<ZipParseResponse | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [states, setStates] = useState<Record<string, ZipFileState>>({});
  const [textsUnavailable, setTextsUnavailable] = useState(false);

  const setFileState = (name: string, s: ZipFileState) => setStates((m) => ({ ...m, [name]: s }));

  const handleZip = async (file: File) => {
    setUploading(true); setZipErr(null); setResult(null); setStates({}); setTexts({}); setTextsUnavailable(false);
    try {
      // Local unzip keeps each file's text so per-file apply is possible.
      try {
        const buf = new Uint8Array(await file.arrayBuffer());
        const entries = unzipSync(buf);
        const map: Record<string, string> = {};
        for (const [name, data] of Object.entries(entries)) {
          if (name.endsWith('/') || !name.toLowerCase().endsWith('.txt')) continue;
          map[name] = strFromU8(data);
        }
        setTexts(map);
      } catch {
        setTextsUnavailable(true);
      }
      const form = new FormData();
      form.append('file', file);
      const res = await api.post<ZipParseResponse>('/api/admin/template/parse-zip', form);
      setResult(res);
    } catch (e) {
      setZipErr(e instanceof ApiError ? e.message : t.zipFailed);
    } finally {
      setUploading(false);
    }
  };

  const applyFile = async (f: ZipFileResult, choice?: DuplicateChoice) => {
    const text = texts[f.name];
    if (!text) {
      setFileState(f.name, { phase: 'error', message: t.zipLocalFailed });
      return;
    }
    setFileState(f.name, { phase: 'applying' });
    try {
      const out = await api.post<ApplyResponse>('/api/admin/template/apply', {
        text,
        mode: f.product_id ? 'update' : 'draft',
        confirm: true,
        duplicate_choice: choice,
      });
      setFileState(f.name, {
        phase: 'applied',
        productId: out.product_id,
        created: out.created,
        alreadyApplied: out.already_applied === true,
      });
      onApplied(out.product_id);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DUPLICATE') {
        setFileState(f.name, { phase: 'duplicate' });
      } else if (e instanceof ApiError && e.code === 'APPLY_IN_PROGRESS') {
        setFileState(f.name, { phase: 'error', message: t.inProgress });
      } else {
        setFileState(f.name, { phase: 'error', message: e instanceof ApiError ? e.message : t.applyFailed });
      }
    }
  };

  const readyFiles = (result?.files ?? []).filter(
    (f) => f.ready_to_apply && (states[f.name]?.phase ?? 'idle') === 'idle' && !!texts[f.name]
  );

  const applyAll = async () => {
    for (const f of readyFiles) {
      // Sequential on purpose: rate-limit friendly, and each file's outcome
      // stays attributable in the report.
      // eslint-disable-next-line no-await-in-loop
      await applyFile(f);
    }
  };

  // EVERY entry of the archive is accounted for — parsed files (accepted /
  // rejected / pending), non-.txt entries and entries past the limit.
  const report = useMemo<ReportRow[]>(() => {
    if (!result) return [];
    const rows: ReportRow[] = result.files.map((f) => {
      const st = states[f.name] ?? { phase: 'idle' as const };
      const reasons: string[] = [
        ...f.errors.map((e) => `${t.line} ${e.line} — ${e.key || '—'}: ${e.message}`),
        ...(f.validation_error ? [f.validation_error.message] : []),
        ...f.needs_review.map((n) => `${n.key} «${n.value}»: ${n.message}`),
        ...f.warnings,
      ];
      if (st.phase === 'error') reasons.push(st.message);
      if (st.phase === 'applied') {
        return {
          name: f.name,
          status: 'accepted',
          detail: st.alreadyApplied ? t.alreadyApplied : `${st.created ? t.createdDraft : t.updated} · ${st.productId}`,
          reasons,
        };
      }
      if (st.phase === 'duplicate') {
        return { name: f.name, status: 'pending', detail: t.dupTitle, reasons };
      }
      if (!f.ready_to_apply || st.phase === 'error') {
        return { name: f.name, status: 'rejected', detail: t.notReady, reasons };
      }
      return { name: f.name, status: 'pending', detail: t.pending, reasons };
    });
    for (const name of result.skipped_entries) {
      rows.push({ name, status: 'rejected', detail: t.skippedNotTxt, reasons: [] });
    }
    for (const name of result.skipped_over_limit) {
      rows.push({ name, status: 'rejected', detail: t.skippedOverLimit, reasons: [] });
    }
    return rows;
  }, [result, states, t]);

  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-3 sm:p-4">
      <L ar={STRINGS.ar.zipTitle} en={STRINGS.en.zipTitle} hint={t.zipHint} />
      <label className={btnSecondary + ' cursor-pointer w-fit'}>
        <Upload className="w-4 h-4" /> {uploading ? t.previewing : t.zipUpload}
        <input type="file" className="hidden" accept=".zip,application/zip" disabled={uploading} onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) handleZip(f);
        }} />
      </label>
      {zipErr && <div className="text-red-400 text-sm mt-2" role="alert">{zipErr}</div>}
      {textsUnavailable && result && (
        <div className="text-amber-400 text-xs mt-2">{t.zipLocalFailed}</div>
      )}

      {result && (
        <div className="mt-4">
          {result.skipped_entries.length > 0 && (
            <div className="text-zinc-500 text-xs mb-2 break-words">
              {t.skippedNotTxt}: {result.skipped_entries.join('، ')}
            </div>
          )}
          {result.skipped_over_limit.length > 0 && (
            <div className="text-amber-400 text-xs mb-2 break-words">
              {t.skippedOverLimit} ({result.counts?.limit ?? ''}): {result.skipped_over_limit.join('، ')}
            </div>
          )}

          {readyFiles.length > 1 && (
            <button type="button" onClick={applyAll} className={btnPrimary + ' mb-3'}>
              {fill(t.applyAllReady, { n: readyFiles.length })}
            </button>
          )}

          <div className="flex flex-col gap-2">
            {result.files.map((f) => {
              const st = states[f.name] ?? { phase: 'idle' as const };
              return (
                <div key={f.name} className="border border-zinc-800 rounded-xl p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm text-zinc-200 font-mono truncate" dir="ltr">{f.name}</div>
                      <div className="text-[11px] text-zinc-500">
                        {f.summary ? `${f.summary.name_ar || f.summary.name_en} · ${f.summary.price_iqd} IQD` : ''}
                        {f.product_id ? ` · ${t.updateExisting} ${f.product_id}` : ` · ${t.createDraft}`}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {st.phase === 'applied' ? (
                        <span className={`text-xs font-bold flex items-center gap-1 ${st.alreadyApplied ? 'text-amber-400' : 'text-emerald-400'}`}>
                          <Check className="w-4 h-4" />
                          {st.alreadyApplied ? t.alreadyApplied : st.created ? t.createdDraft : t.updated} · {st.productId}
                        </span>
                      ) : st.phase === 'applying' ? (
                        <span className="text-zinc-400 text-xs">{t.applying}</span>
                      ) : f.ready_to_apply ? (
                        <button
                          type="button"
                          disabled={!texts[f.name]}
                          onClick={() => applyFile(f)}
                          className={btnSecondary + ' !py-1.5 !min-h-9 text-xs'}
                        >
                          {f.product_id ? t.applyUpdate : t.applyDraft}
                        </button>
                      ) : (
                        <span className="text-amber-400 text-xs font-bold">{t.notReady}</span>
                      )}
                    </div>
                  </div>

                  {st.phase === 'duplicate' && (
                    <div className="mt-2">
                      <DuplicateChoiceBox
                        applying={false}
                        onChoice={(c) => applyFile(f, c)}
                        onCancel={() => setFileState(f.name, { phase: 'idle' })}
                      />
                    </div>
                  )}
                  {st.phase === 'error' && (
                    <div className="text-red-400 text-xs mt-2" role="alert">{st.message}</div>
                  )}

                  {(f.errors.length > 0 || f.needs_review.length > 0 || f.validation_error || f.unknown_keys.length > 0 || f.warnings.length > 0) && (
                    <div className="mt-2 text-[11px] flex flex-col gap-1">
                      {f.errors.map((e, i) => (
                        <div key={`e-${i}`} className="text-red-400">{t.line} {e.line} — {e.key || '—'}: {e.message}</div>
                      ))}
                      {f.validation_error && <div className="text-red-400">{f.validation_error.message}</div>}
                      {f.needs_review.map((n, i) => (
                        <div key={`n-${i}`} className="text-amber-400">{n.key} «{n.value}»: {n.message}</div>
                      ))}
                      {f.unknown_keys.length > 0 && (
                        <div className="text-zinc-500">{t.unknownTitle}: {f.unknown_keys.join('، ')}</div>
                      )}
                      {f.warnings.map((w, i) => (
                        <div key={`w-${i}`} className="text-amber-400/80">{w}</div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <ImportReport rows={report} />
        </div>
      )}
    </div>
  );
}

/** Complete accepted/rejected ledger — every row, every reason (§6.1). */
function ImportReport({ rows }: { rows: ReportRow[] }) {
  const t = useStrings();
  const [copied, setCopied] = useState(false);
  if (rows.length === 0) return null;

  const accepted = rows.filter((r) => r.status === 'accepted').length;
  const rejected = rows.filter((r) => r.status === 'rejected').length;
  const pending = rows.filter((r) => r.status === 'pending').length;

  const asText = () =>
    rows
      .map((r) => {
        const head = `[${r.status.toUpperCase()}] ${r.name} — ${r.detail}`;
        return r.reasons.length ? `${head}\n${r.reasons.map((x) => `    - ${x}`).join('\n')}` : head;
      })
      .join('\n');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(asText());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  };

  const tone: Record<ReportRow['status'], string> = {
    accepted: 'text-emerald-400',
    rejected: 'text-red-400',
    pending: 'text-amber-400',
  };
  const label: Record<ReportRow['status'], string> = {
    accepted: t.accepted,
    rejected: t.rejected,
    pending: t.pending,
  };

  return (
    <div className="mt-4 border border-zinc-800 rounded-xl overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-zinc-800/30 border-b border-zinc-800">
        <div className="min-w-0">
          <div className="text-sm font-bold text-white">{t.reportTitle}</div>
          <div className="text-[11px] text-zinc-500">{t.reportHint}</div>
        </div>
        <div className="flex items-center gap-3 shrink-0 text-xs">
          <span className="text-emerald-400 font-bold">{t.accepted} {accepted}</span>
          <span className="text-red-400 font-bold">{t.rejected} {rejected}</span>
          <span className="text-amber-400 font-bold">{t.pending} {pending}</span>
          <button type="button" onClick={copy} className="inline-flex items-center gap-1 text-zinc-300 hover:text-white">
            <ClipboardCopy className="w-4 h-4" /> {copied ? t.copied : t.copyReport}
          </button>
        </div>
      </div>
      <ul className="divide-y divide-zinc-800/70 max-h-80 overflow-y-auto overscroll-contain">
        {rows.map((r) => (
          <li key={`${r.status}-${r.name}`} className="px-3 py-2 text-xs">
            <div className="flex flex-wrap items-baseline gap-2 min-w-0">
              <span className={`font-bold ${tone[r.status]}`}>{label[r.status]}</span>
              <span className="font-mono text-zinc-300 break-all" dir="ltr">{r.name}</span>
              <span className="text-zinc-500 break-words">{r.detail}</span>
            </div>
            {r.reasons.length > 0 && (
              <ul className="list-disc ms-5 mt-1 text-[11px] text-zinc-400">
                {r.reasons.map((x, i) => <li key={i} className="break-words">{x}</li>)}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
