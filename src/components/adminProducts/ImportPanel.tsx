/**
 * ONE IMPORT / EXPORT WINDOW, three formats, and no import before a check.
 *
 * The window used to be two tabs with different vocabularies: a section
 * template panel (CSV/ZIP) and, behind a second tab, the older TXT tools. An
 * admin had to know which tab their file belonged to before the window could
 * help them, and the TXT half was reachable only by guessing. So the first
 * thing this asks is the only thing that actually decides everything else:
 *
 *   1. WHICH FORMAT — CSV, ZIP or TXT, each with one line saying what it is
 *      for. Everything below reshapes itself around that answer; nothing from
 *      the other two lanes stays on screen.
 *   2. WHERE IT GOES — product type and section, as one compact row. The type
 *      decides the columns, the section decides where the products are filed.
 *      TXT carries its own classification inside the file, so it only uses the
 *      type, and only to scaffold the spec sheet in the blank template.
 *   3. THE TEMPLATE — one clearly named download per lane, plus the export of
 *      what is already there, which is the intended bulk-EDIT path.
 *   4. THE FILE, THEN THE CHECK. The check is mandatory: the import button
 *      does not exist until a check has answered, and it stays disabled while
 *      anything is blocking. Both checks write nothing — CSV/ZIP through
 *      /import/preview, TXT through /template/parse (or /parse-zip) — and the
 *      panel says so where the button is, not in a footnote.
 *
 * WHAT THE CHECK REPORTS, because "the file has errors" is not usable: how
 * many products, how many will be created and updated, then four buckets the
 * owner asked for by name — errors, missing fields, missing images and
 * duplicates — with every entry naming its product, its line and its field.
 * The buckets are a grouping of the same list, never a filter of it: the full
 * error list is always there underneath, so a mis-grouped complaint is still
 * read. See ./importIssues.ts for how a complaint is located.
 *
 * NO IMPORT LOGIC LIVES HERE. Every lane posts to the endpoints that already
 * existed and shows what they answer. The panel decides nothing about what is
 * valid, what is a duplicate or what gets written.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { unzipSync, strFromU8 } from 'fflate';
import {
  Download, Upload, RefreshCw, CheckCircle2, AlertTriangle, FileText, FileSpreadsheet,
  FileArchive, Copy, Check, ChevronDown, ShieldCheck, XCircle, ImageOff, CopyX, ListChecks,
} from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { btnPrimary, btnSecondary, inputCls, ErrorBanner } from './ui';
import { downloadAdminFile, DownloadError } from './download';
import { readIssueText, readIssueEntry, bucketise, issueWhere, type ImportIssue } from './importIssues';
import type { ParseResponse, ApplyResponse, ApplySpecReport, ZipParseResponse, DuplicateChoice } from './types';
import { applyFailure, applyOutcome, verificationLine, type ApplyOutcome, type VerificationWords } from './applyResult';

// ------------------------------------------------------------------ strings

const STRINGS = {
  ar: {
    step1: '١. اختر صيغة الملف',
    csvName: 'CSV',
    csvWhat: 'جدول واحد بكل المنتجات. الأسرع للإضافة والتعديل الجماعي — بلا صور داخل الملف (روابط الصور مقبولة).',
    zipName: 'ZIP',
    zipWhat: 'نفس جدول CSV + مجلد images/ بالصور. هذا هو المسار الوحيد لرفع صور من جهازك مع المنتجات.',
    txtName: 'TXT',
    txtWhat: 'ملف نصي لكل منتج — للمنتجات التفصيلية ذات الحقول المتكررة (خيارات، ألوان، مواصفات، خطط ضمان) بلا حد ثابت. يقبل ملفاً واحداً أو ZIP يضم عدة ملفات .txt.',

    step2: '٢. النوع والقسم',
    step2HintTable: 'النوع يحدد أعمدة القالب، والقسم يحدد أين يُحفظ المنتج.',
    step2HintTxt: 'ملف TXT يحمل تصنيفه بداخله. اختر النوع والقسم هنا لتوليد صفوف مواصفات مطابقة للقسم في القالب الفارغ.',
    typeColumns: '{n} حقل مواصفات',
    sectionColumns: 'قالب هذا القسم: {n} حقل مواصفات',
    sectionNarrowed: 'أقل بـ {n} حقلاً من «{type}» — الحقول التي لا تخص هذا القسم محذوفة.',
    sectionSame: 'كل حقول «{type}» — هذا القسم لا يضيّق القائمة.',
    sectionGroups: 'المجموعات:',
    anyType: 'كل الأنواع',
    pickTypeFirst: 'اختر نوع المنتج أولًا.',
    sectionPlaceholder: 'اختر قسمًا…',
    sectionOptional: 'اختياري للاستيراد، لكنه يخصص صفوف قالب TXT حسب القسم.',
    noFamily: 'هذا القسم بلا عائلة قالب. حدّدها (أجهزة أو مواد) من إدارة الأقسام أولًا.',

    step3: '٣. نزّل القالب',
    tplCsv: 'تنزيل قالب CSV',
    tplZip: 'تنزيل قالب ZIP',
    tplTxt: 'تنزيل قالب TXT',
    tplTxtExample: 'مثال TXT معبّأ',
    exportCsv: 'تصدير منتجات القسم (CSV)',
    exportZip: 'تصدير منتجات القسم (ZIP)',
    tplHintTable: 'القالب يحمل كل حقول نموذج المنتج: الخيارات والألوان والتوليفات والصور وشحن الطلب المسبق والمواصفات والشارات وخطط الضمان وكتل المحتوى وخطوات الدليل. الإدخال بالإنجليزية فقط، والترجمة تتم محليًا على الخادم بلا ذكاء اصطناعي.',
    tplHintTxt: 'القالب الفارغ يشرح كل حقل، والمجموعات المتكررة معطّلة بعلامة # حتى تحتاجها. كرّر options.1 ثم options.2 وهكذا — لا عدد ثابت للحقول المتكررة (حتى ٥٠٠ عنصر لكل مجموعة). المثال ملف صالح يُنشئ مسودة فقط.',

    step4: '٤. ارفع الملف ثم افحصه',
    pickCsv: 'اختر ملف CSV',
    pickZip: 'اختر ملف ZIP',
    pickTxt: 'اختر ملف TXT أو ZIP يضم ملفات .txt',
    orPaste: 'أو الصق نص القالب هنا',
    check: 'افحص الملف',
    checking: 'جارٍ الفحص…',
    noWrite: 'الفحص لا يكتب أي شيء في قاعدة البيانات.',
    mustCheck: 'الاستيراد معطّل حتى ينتهي الفحص ويظهر تقريره.',
    pickFileFirst: 'اختر ملفًا أولًا.',
    pickSectionFirst: 'اختر القسم أولًا.',

    checkTitle: 'نتيجة الفحص',
    statProducts: 'منتجات في الملف',
    statCreate: 'ستُنشأ',
    statUpdate: 'ستُحدَّث',
    statBlocked: 'موقوفة بأخطاء',
    bErrors: 'أخطاء',
    bMissing: 'حقول ناقصة',
    bImages: 'صور مفقودة',
    bDuplicates: 'تكرارات',
    bNoImages: 'منتجات بلا صورة',
    bWarnings: 'تنبيهات',
    allClear: 'لا أخطاء — الملف جاهز للاستيراد.',
    blocked: 'كل صف في هذا الملف موقوف بخطأ. عالج الأخطاء أدناه ثم أعد الفحص — الاستيراد معطّل بأمانة.',
    partial: 'سيُستورد {n} ويُتخطّى {b} موقوفًا بأخطاء. عالج الأخطاء وأعد الفحص لاستيراد الكل.',
    nothingToApply: 'لا يوجد منتج صالح في هذا الملف.',
    where: { product: 'المنتج', line: 'سطر', field: 'الحقل' },
    unknownCols: 'أعمدة غير معروفة في الملف (تُتجاهل): ',
    unknownKeys: 'مفاتيح غير معروفة (تُتجاهل): ',
    fileIssues: 'مشاكل عامة في الملف',
    showAll: 'عرض كل الـ {n}',
    rowsTitle: 'المنتجات',

    confirm: 'ابدأ الاستيراد',
    confirming: 'جارٍ التنفيذ…',
    report: 'تنزيل تقرير النتيجة (CSV)',
    downloading: 'جارٍ التنزيل…',
    started: 'بدأ تنزيل {name} ({size}).',
    startedNav: 'فُتح {name} في نافذة التنزيل ({size}).',
    summary: 'أُنشئ {c} — حُدِّث {u} — مُتخطّى {s} — فشل {f}',
    created: 'أُنشئ',
    updated: 'حُدِّث',
    skipped: 'مُتخطّى',
    failed: 'فشل',
    create: 'إنشاء',
    update: 'تحديث',
    blockedRow: 'موقوف',
    alreadyApplied: 'هذا الاستيراد نُفّذ من قبل — هذه نتيجته المحفوظة.',
    reviewNeeded: 'حقول بقيت بالإنجليزية وتحتاج مراجعة بشرية:',
    needsReview: 'بحاجة مراجعة — يمنع الاستيراد',
    dupTitle: 'يوجد منتج بنفس الاسم/الرابط — اختر كيف نكمل:',
    dupUpdate: 'تحديث الموجود',
    dupNew: 'إنشاء مسودة جديدة',
    inProgress: 'الدفعة نفسها قيد التنفيذ — انتظر النتيجة قبل إعادة المحاولة.',
    zipOverLimit: 'ملفات تجاوزت حد الأرشيف ({n}) ولم تُفحص:',
    zipNotTxt: 'مدخلات ليست ‎.txt وتم تجاهلها:',
    zipLocalFailed: 'تعذّر فك ضغط الأرشيف محليًا — نتائج الفحص ظاهرة لكن الاستيراد يحتاج رفع كل ملف على حدة.',

    // The apply result, read back from the database — never from the file.
    verifyTitle: 'ما حُفظ فعلًا (قراءة من قاعدة البيانات بعد التنفيذ):',
    verifyUnreported: 'الخادم لم يُبلّغ عن عدّادات القراءة — لا يمكن تأكيد ما حُفظ من هذه الشاشة.',
    vw: { groups: 'مجموعة', values: 'قيمة', colors: 'لون', links: 'ربط', images: 'صورة', specs: 'مواصفة', outside: 'ظاهرة في النموذج', outsideSection: 'خارج قالب القسم', variants: 'تركيبة', inventory: 'المخزون', unreported: 'بلا عدّادات من الخادم' },
    mismatched: 'لم يُحفظ قسم:',
    productExists: 'المنتج موجود:',
    fieldsLine: 'طُبّق {a} حقلًا · حُفظ كما هو {p} · مُسح {c}',
    warningsAtApply: 'تنبيهات التنفيذ:',
    unknownAtApply: 'مفاتيح لم يعرفها القالب ولم تُحفظ:',
    ackUnknown: 'أفهم أن {n} مفتاحًا غير معروف سيُتجاهل ({keys}) — استورد رغم ذلك',
    ackRequired: 'الملف يحمل مفاتيح غير معروفة — أكّد تجاهلها أولًا.',
    openInForm: 'افتح في النموذج',
    copyId: 'نسخ المعرّف',

    lookupsTitle: 'القيم المتاحة لأعمدة التصنيف',
    lookupsHint:
      'هذه هي القيم التي يقبلها الملف في أعمدة category و sub_category و brand و hashtags — كما هي الآن في صفحة التصنيفات. اضغط قيمة لنسخها. القالب المنزّل يحملها أيضًا في نهايته وفي lookups.csv.',
    lkCategory: 'القسم الرئيسي (category)',
    lkSub: 'القسم الفرعي (sub_category)',
    lkBrand: 'العلامة التجارية (brand)',
    lkHashtag: 'الهاشتاقات (hashtags)',
    lkEmpty: 'لا شيء بعد — أضف من صفحة التصنيفات.',
    lkHashtagFree: 'يمكن كتابة وسم جديد في الملف وسيُضاف إلى القائمة عند التنفيذ.',
    copied: 'نُسخ',
  },
  en: {
    step1: '1. Choose the file format',
    csvName: 'CSV',
    csvWhat: 'One spreadsheet holding every product. The fastest way to add or bulk-edit — no image files inside (image URLs are accepted).',
    zipName: 'ZIP',
    zipWhat: 'The same CSV plus an images/ folder. This is the only way to bring image files from your device with the products.',
    txtName: 'TXT',
    txtWhat: 'One text file per product — for detail-rich products with repeated fields (options, colours, specifications, warranty plans) and no fixed count. Takes a single file or a ZIP of .txt files.',

    step2: '2. Type and section',
    step2HintTable: 'The type decides the template columns; the section decides where the product is filed.',
    step2HintTxt: 'A TXT file carries its own classification. Choose a type and section here to generate the matching specification rows in the blank template.',
    typeColumns: '{n} spec fields',
    sectionColumns: 'This section\u2019s template: {n} spec fields',
    sectionNarrowed: '{n} fewer than \u201c{type}\u201d — the fields that do not belong to this section are dropped.',
    sectionSame: 'Every field of \u201c{type}\u201d — this section does not narrow the list.',
    sectionGroups: 'Groups:',
    anyType: 'All types',
    pickTypeFirst: 'Choose a product type first.',
    sectionPlaceholder: 'Choose a section…',
    sectionOptional: 'Optional for import; selecting it tailors the TXT template rows to that section.',
    noFamily: 'This section has no template family. Set it to Devices or Materials in the sections admin first.',

    step3: '3. Download the template',
    tplCsv: 'Download CSV Template',
    tplZip: 'Download ZIP Template',
    tplTxt: 'Download TXT Template',
    tplTxtExample: 'Filled TXT example',
    exportCsv: 'Export this section (CSV)',
    exportZip: 'Export this section (ZIP)',
    tplHintTable: 'The template carries every field of the product form: options, colours, stock combinations, images, pre-order transports, specifications, badges, warranty plans, content blocks and guide steps. English input only; Arabic and Kurdish are generated locally on the server, with no AI.',
    tplHintTxt: 'The blank documents every field, and repeated groups ship commented out until you need them. Keep going with options.1, options.2, … — there is no fixed number of repeated fields (up to 500 items per group). The example is a valid file that only ever creates a draft.',

    step4: '4. Upload the file, then check it',
    pickCsv: 'Choose a CSV file',
    pickZip: 'Choose a ZIP file',
    pickTxt: 'Choose a .txt file, or a ZIP of .txt files',
    orPaste: 'or paste the template text here',
    check: 'Check the file',
    checking: 'Checking…',
    noWrite: 'The check writes nothing to the database.',
    mustCheck: 'Import stays disabled until the check has run and reported.',
    pickFileFirst: 'Choose a file first.',
    pickSectionFirst: 'Choose the section first.',

    checkTitle: 'Check result',
    statProducts: 'products in the file',
    statCreate: 'to create',
    statUpdate: 'to update',
    statBlocked: 'blocked by errors',
    bErrors: 'errors',
    bMissing: 'missing fields',
    bImages: 'missing images',
    bDuplicates: 'duplicates',
    bNoImages: 'products with no image',
    bWarnings: 'warnings',
    allClear: 'No errors — the file is ready to import.',
    blocked: 'Every row in this file is blocked by an error. Fix them below and check again — import is honestly disabled.',
    partial: '{n} will be imported and {b} skipped as blocked. Fix the errors and check again to import them all.',
    nothingToApply: 'No valid product in this file.',
    where: { product: 'product', line: 'line', field: 'field' },
    unknownCols: 'Columns the template does not define (ignored): ',
    unknownKeys: 'Keys the template does not define (ignored): ',
    fileIssues: 'File-level problems',
    showAll: 'Show all {n}',
    rowsTitle: 'Products',

    confirm: 'Start the import',
    confirming: 'Applying…',
    report: 'Download result report (CSV)',
    downloading: 'Downloading…',
    started: '{name} started downloading ({size}).',
    startedNav: '{name} opened in the download window ({size}).',
    summary: '{c} created — {u} updated — {s} skipped — {f} failed',
    created: 'created',
    updated: 'updated',
    skipped: 'skipped',
    failed: 'failed',
    create: 'create',
    update: 'update',
    blockedRow: 'blocked',
    alreadyApplied: 'This import was already applied — this is its stored result.',
    reviewNeeded: 'Fields kept in English and needing a human review:',
    needsReview: 'Needs review — blocks the import',
    dupTitle: 'A product with the same name/slug exists — choose how to continue:',
    dupUpdate: 'Update the existing one',
    dupNew: 'Create a new draft',
    inProgress: 'The same batch is being applied — wait for the result before retrying.',
    zipOverLimit: 'Files past the per-archive limit ({n}) and not checked:',
    zipNotTxt: 'Non-.txt entries, ignored:',
    zipLocalFailed: 'Could not unzip locally — the check results are shown, but importing needs each file uploaded on its own.',

    verifyTitle: 'What was actually stored (read back from the database after the apply):',
    verifyUnreported: 'The server reported no read-back counts — what was stored cannot be confirmed from this screen.',
    vw: { groups: 'groups', values: 'values', colors: 'colours', links: 'links', images: 'images', specs: 'spec fields', outside: 'visible in the form', outsideSection: 'outside the section template', variants: 'variants', inventory: 'inventory', unreported: 'no counts from the server' },
    mismatched: 'Section not stored:',
    productExists: 'the product exists:',
    fieldsLine: '{a} fields applied · {p} preserved · {c} cleared',
    warningsAtApply: 'Apply warnings:',
    unknownAtApply: 'Keys the template does not define and did not store:',
    ackUnknown: 'I understand that {n} unknown keys will be ignored ({keys}) — import anyway',
    ackRequired: 'The file carries unknown keys — acknowledge that they are ignored first.',
    openInForm: 'Open in form',
    copyId: 'Copy id',

    lookupsTitle: 'Accepted values for the classification columns',
    lookupsHint:
      'These are the values the file accepts in category, sub_category, brand and hashtags — exactly as they stand in the taxonomy page right now. Click a value to copy it. The downloaded template also carries them at its end and in lookups.csv.',
    lkCategory: 'Main section (category)',
    lkSub: 'Sub-section (sub_category)',
    lkBrand: 'Brand (brand)',
    lkHashtag: 'Hashtags (hashtags)',
    lkEmpty: 'Nothing yet — add from the taxonomy page.',
    lkHashtagFree: 'A new tag may be typed into the file; it joins the list on import.',
    copied: 'Copied',
  },
};
type Strings = typeof STRINGS.ar;
const pickStrings = (lang: string): Strings => (lang === 'en' ? (STRINGS.en as Strings) : STRINGS.ar);
const fill = (tpl: string, vars: Record<string, string | number>) =>
  tpl.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));

const humanBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

// -------------------------------------------------------------------- types

type Format = 'csv' | 'zip' | 'txt';
// Mirrors `ProductTypeId` in worker/lib/templateFamilies.ts. The VALUES arrive
// as JSON from /api/admin/import/types, so a stale union here does not break
// the build — it goes wrong later, when the first `switch` written against it
// silently misses a type the registry has and this line does not.
type ProductTypeId = 'printer' | 'parts' | 'filament' | 'accessory' | 'laser' | 'laser_material';

interface Catalog {
  id: string;
  parent_id: string | null;
  slug: string;
  name_ar: string;
  name_en: string;
  active: boolean;
  effective_template_family: 'devices' | 'materials' | null;
  product_type: ProductTypeId | null;
  product_count: number;
  /**
   * What THIS section's template actually carries, narrowed — not the product
   * type's union. See the note beside the section select: the panel used to
   * show only the type's number, and it never moved.
   */
  spec_columns?: number;
  spec_groups?: Array<{ id: string; label_ar: string; label_en: string; fields: number }>;
}

interface TypeChoice {
  id: ProductTypeId;
  label_ar: string;
  label_en: string;
  hint_ar: string;
  family: 'devices' | 'materials';
  spec_columns: number;
}

interface Lookups {
  sections: Array<{ id: string; slug: string; name_en: string; name_ar: string; parent_id: string | null; parent_name_en: string; family: string | null }>;
  brands: Array<{ id: string; slug: string; name_en: string; name_ar: string }>;
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
  /** Brands the confirm will ADD rather than refuse the rows naming them. */
  brands_to_create?: Array<{ name: string; slug: string }>;
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

/** One product the check found, whichever lane found it. */
interface CheckedItem {
  id: string;
  line: number | null;
  name: string;
  action: 'create' | 'update' | 'blocked';
  images: number;
  issues: ImportIssue[];
  /** Keys the template does not define. The apply IGNORES them, so the admin
   *  must acknowledge that before the import button works. */
  unknownKeys: string[];
  /** TXT only: the file's own text, so the import can re-post it verbatim. */
  text?: string;
  /**
   * §7.3 — WHAT THE APPLY WILL DO, said before anything is written.
   * `/parse` and `/parse-zip` both answer with the spec-sheet report and the
   * stock level the apply will derive; the check step used to receive them and
   * render neither, so the admin learned about an outside-template spec id and
   * a changed inventory level only after the write.
   */
  plan?: { specStored: number | null; specVisible: number | null; specOutside: string[]; inventoryMode: string | null };
}

/** The one shape the report card renders, for all three formats. */
interface CheckResult {
  format: Format;
  items: CheckedItem[];
  fileIssues: ImportIssue[];
  unknownColumns: string[];
  notes: string[];
  /** CSV / ZIP: the preview id the confirm endpoint takes. */
  importId?: string;
  /** TXT: whether this was one file or an archive. */
  txtMode?: 'single' | 'archive';
}

/** One row of the final result table, for all three formats. TXT rows carry
 *  the server's read-back verification; CSV/ZIP rows carry the report line. */
interface ResultRow {
  key: string;
  name: string;
  action: 'created' | 'updated' | 'skipped' | 'failed';
  detail: string;
  /** TXT only: the verified outcome (counts, warnings, unknown keys, fields). */
  outcome?: ApplyOutcome;
}

/** What an import run answers, whichever lane ran it. */
interface ImportResult {
  rows: ResultRow[];
  summary: ConfirmResponse['summary'];
  /** TXT only: files the server stopped on to ask the duplicate question. */
  duplicates?: string[];
  importId?: string;
  review?: string[];
}

// ---------------------------------------------------------------- helpers

/**
 * How many images a TXT template actually carries. Counted from the text
 * because neither /parse nor /parse-zip reports a count, and "this product has
 * no picture" is one of the things the owner asked the check to say. Commented
 * lines do not count — they are the blank template's disabled scaffold.
 */
export function countTxtImages(text: string): number {
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^images\.(\d+)\.url\s*=\s*(.*)$/.exec(line);
    if (m && m[2].trim() && m[2].trim() !== '__NULL__' && m[2].trim() !== '__CLEAR__') seen.add(m[1]);
  }
  return seen.size;
}

/** The product name a TXT file claims, for the report table. */
function txtName(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^name_(?:ar|en)\s*=\s*(.+)$/.exec(line);
    if (m && m[1].trim()) return m[1].trim();
  }
  return '';
}

// --------------------------------------------------------------- component

export default function ImportPanel({
  onApplied,
  onDirtyChange,
  onOpenProduct,
}: {
  onApplied?: () => void;
  /** Unapplied pasted text is "dirty" for the host dialog. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Offered on every applied row so the admin can verify, in the form, that
   *  the same two endpoints render what the result table counted. */
  onOpenProduct?: (productId: string) => void;
}) {
  const { lang } = useLanguage();
  const t = pickStrings(lang);

  const [format, setFormat] = useState<Format>('csv');
  const [catalogs, setCatalogs] = useState<Catalog[]>([]);
  const [types, setTypes] = useState<TypeChoice[]>([]);
  const [typeId, setTypeId] = useState<ProductTypeId | ''>('');
  const [sectionId, setSectionId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [pasted, setPasted] = useState('');
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [duplicates, setDuplicates] = useState<string[]>([]);
  // Unknown keys are dropped by the apply. Importing over them is a decision
  // the admin takes explicitly, per check — never a default.
  const [ackUnknown, setAckUnknown] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [lookups, setLookups] = useState<Lookups | null>(null);

  useEffect(() => {
    api
      .get<{ catalogs: Catalog[] }>('/api/admin/taxonomy/catalogs')
      .then((r) => setCatalogs(r.catalogs ?? []))
      .catch((e) => setErr(e instanceof ApiError ? e.message : String(e)));
    api.get<Lookups>('/api/admin/import/lookups').then(setLookups).catch(() => setLookups(null));
    api
      .get<{ types: TypeChoice[] }>('/api/admin/import/types')
      .then((r) => setTypes(r.types ?? []))
      .catch(() => setTypes([]));
  }, []);

  // Pasted-but-unchecked text is work the host dialog must not discard silently.
  useEffect(() => {
    onDirtyChange?.(pasted.trim().length > 0);
  }, [pasted, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  /** Any change to what would be imported invalidates the check that allowed it. */
  const invalidate = useCallback(() => {
    setCheck(null);
    setResult(null);
    setDuplicates([]);
    setAckUnknown(false);
  }, []);

  const options = useMemo(
    () => catalogs.filter((c) => c.active && c.effective_template_family && (!typeId || c.product_type === typeId)),
    [catalogs, typeId]
  );
  const byId = useMemo(() => new Map(catalogs.map((c) => [c.id, c])), [catalogs]);
  const section = sectionId ? byId.get(sectionId) : undefined;
  const effectiveType: ProductTypeId | '' = typeId || section?.product_type || '';
  const isTable = format !== 'txt';

  const label = (c: Catalog) => {
    const parent = c.parent_id ? byId.get(c.parent_id) : undefined;
    const own = lang === 'en' ? c.name_en || c.name_ar : c.name_ar || c.name_en;
    const head = parent ? `${lang === 'en' ? parent.name_en || parent.name_ar : parent.name_ar || parent.name_en} › ` : '';
    return `${head}${own}`;
  };

  // ------------------------------------------------------------ downloads

  const download = async (key: string, path: string, fallback: string, kind: 'csv' | 'zip' | 'txt') => {
    setBusy(key);
    setErr(null);
    setNote(null);
    try {
      const out = await downloadAdminFile(path, fallback, {
        accept: kind === 'zip' ? 'application/zip' : kind === 'csv' ? 'text/csv' : 'text/plain',
        ext: kind,
        type:
          kind === 'zip' ? 'application/zip' : kind === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8',
      });
      setNote(fill(out.method === 'navigation' ? t.startedNav : t.started, { name: out.filename, size: humanBytes(out.bytes) }));
    } catch (e) {
      setErr(e instanceof DownloadError ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const dlBtn = (
    key: string,
    path: string,
    fallback: string,
    text: string,
    { kind = 'csv', disabled = false, primary = false }: { kind?: 'csv' | 'zip' | 'txt'; disabled?: boolean; primary?: boolean } = {}
  ) => (
    <button
      type="button"
      data-import={key}
      disabled={busy !== '' || disabled}
      onClick={() => download(key, path, fallback, kind)}
      className={(primary ? btnPrimary : btnSecondary) + ' disabled:opacity-40'}
    >
      {busy === key ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
      <span className="truncate">{busy === key ? t.downloading : text}</span>
    </button>
  );

  // ---------------------------------------------------------------- check

  const runCheck = async () => {
    setErr(null);
    setNote(null);
    setResult(null);
    setDuplicates([]);
    setAckUnknown(false);
    if (isTable && !sectionId) { setErr(t.pickSectionFirst); return; }
    if (!file && !pasted.trim()) { setErr(t.pickFileFirst); return; }
    setBusy('check');
    try {
      setCheck(isTable ? await checkTable(file!, sectionId, t) : await checkTxt(file, pasted, t));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
      setCheck(null);
    } finally {
      setBusy('');
    }
  };

  // --------------------------------------------------------------- import

  /**
   * `dupChoice` means "the admin has answered the duplicate question", and it
   * re-applies ONLY the files that were waiting on that answer. Re-running the
   * whole batch would post files that already succeeded a second time — and
   * with a different duplicate_choice the confirm-once fingerprint no longer
   * matches, so the guard would not catch it and the catalogue would gain a
   * second copy of every product in the archive.
   */
  const runImport = async (dupChoice?: DuplicateChoice) => {
    if (!check) return;
    const ready = check.items.filter(
      (i) => i.action !== 'blocked' && (!dupChoice || duplicates.includes(i.id))
    );
    if (ready.length === 0) { setErr(t.nothingToApply); return; }
    if (unknownKeysPending.length > 0 && !ackUnknown) { setErr(t.ackRequired); return; }
    setBusy('confirm');
    setErr(null);
    setDuplicates([]);
    try {
      if (check.format === 'txt') {
        const out = await applyTxt(ready, t, dupChoice);
        setDuplicates(out.duplicates);
        setResult((prev) => mergeResults(prev, out));
      } else {
        setResult(await applyTable(check.importId!, t, (msg) => setNote(msg)));
      }
      onApplied?.();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  // ----------------------------------------------------------------- view

  const stem = section ? section.slug : effectiveType || 'section';
  const templateQuery = `type=${encodeURIComponent(effectiveType)}${sectionId ? `&category=${encodeURIComponent(sectionId)}` : ''}`;
  const buckets = check ? bucketise(check.items.flatMap((i) => i.issues).concat(check.fileIssues)) : null;
  const noImages = check ? check.items.filter((i) => i.images === 0).length : 0;
  const blocked = check ? check.items.filter((i) => i.action === 'blocked').length : 0;
  const importable = check ? check.items.filter((i) => i.action !== 'blocked').length : 0;
  // A blocked row is SKIPPED, not a veto over the file: /confirm applies the
  // rows the check accepted and leaves the rest, and refusing the whole file
  // would make one bad row hold ninety-nine good ones hostage. What the check
  // guarantees is that nothing is imported before the admin has seen this.
  // Unknown keys the apply would ignore, across the rows that would be
  // imported. The TXT lane is the one whose keys the server reports per file.
  const unknownKeysPending = check
    ? [...new Set(check.items.filter((i) => i.action !== 'blocked').flatMap((i) => i.unknownKeys))]
    : [];
  const canImport = importable > 0 && (unknownKeysPending.length === 0 || ackUnknown);

  return (
    <div className="min-w-0 text-sm" data-panel="import-v2">
      <ErrorBanner text={err} />
      {note && <div className="bg-sky-500/10 border border-sky-500/30 text-sky-200 rounded-xl p-2.5 mb-3 text-[11px]">{note}</div>}

      {/* 1 — the one question that reshapes everything below ------------- */}
      <Step title={t.step1}>
        <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]" data-import="formats" role="radiogroup" aria-label={t.step1}>
          {(
            [
              ['csv', t.csvName, t.csvWhat, <FileSpreadsheet key="i" className="w-4 h-4" aria-hidden />],
              ['zip', t.zipName, t.zipWhat, <FileArchive key="i" className="w-4 h-4" aria-hidden />],
              ['txt', t.txtName, t.txtWhat, <FileText key="i" className="w-4 h-4" aria-hidden />],
            ] as Array<[Format, string, string, React.ReactNode]>
          ).map(([id, name, what, icon]) => {
            const on = format === id;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={on}
                data-import-format={id}
                onClick={() => {
                  if (on) return;
                  setFormat(id);
                  setFile(null);
                  setPasted('');
                  invalidate();
                }}
                className={`min-w-0 text-start rounded-xl border p-2.5 transition-colors ${
                  on ? 'border-violet-500 bg-violet-500/10 text-white' : 'border-zinc-800 bg-zinc-900/40 text-zinc-300 hover:border-zinc-600'
                }`}
              >
                <span className="flex items-center gap-1.5 text-[13px] font-bold">
                  {icon}
                  <span dir="ltr">{name}</span>
                  {on && <Check className="w-3.5 h-3.5 ms-auto text-violet-300" aria-hidden />}
                </span>
                <span className="block text-[11px] leading-relaxed text-zinc-500 mt-1">{what}</span>
              </button>
            );
          })}
        </div>
      </Step>

      {/* 2 — where it goes, on one compact row --------------------------- */}
      <Step title={t.step2} hint={isTable ? t.step2HintTable : t.step2HintTxt}>
        <div className="flex flex-wrap gap-1.5" data-import="types">
          <TypeChip on={typeId === ''} onClick={() => { setTypeId(''); invalidate(); }} label={t.anyType} />
          {types.map((ty) => (
            <TypeChip
              key={ty.id}
              id={ty.id}
              on={typeId === ty.id}
              onClick={() => {
                const next = typeId === ty.id ? '' : ty.id;
                setTypeId(next);
                if (next && section && section.product_type !== next) setSectionId('');
                invalidate();
              }}
              label={lang === 'en' ? ty.label_en : ty.label_ar}
              sub={fill(t.typeColumns, { n: ty.spec_columns })}
            />
          ))}
        </div>
        <div className="mt-2">
          <select
            data-import="section"
            value={sectionId}
            onChange={(e) => { setSectionId(e.target.value); invalidate(); }}
            className={inputCls + ' w-full sm:w-auto sm:min-w-[18rem] max-w-full'}
          >
            <option value="">{t.sectionPlaceholder}</option>
            {options.map((c) => (
              <option key={c.id} value={c.id}>{label(c)}</option>
            ))}
          </select>
        </div>
        {/*
            WHAT THE CHOSEN SECTION ACTUALLY DOES TO THE TEMPLATE.
            The panel used to show one number — the product TYPE's «47 حقل
            مواصفات» — and nothing else moved when a section was picked. So
            choosing «طابعات Resin» looked identical to choosing «طابعات FDM»,
            and the owner reported that the template does not change by
            section. It does: 47 fields become 39 and 30, and the two sets
            differ by 25 fields. This says so, from the same narrowing the
            download runs, before anything is downloaded.
        */}
        {section && typeof section.spec_columns === 'number' && (
          <div className="mt-2 rounded-xl border border-border-subtle bg-black/20 p-2.5" data-import="section-shape">
            <p className="text-[12px] font-bold text-white">
              {fill(t.sectionColumns, { n: section.spec_columns })}
            </p>
            {(() => {
              const typeDef = types.find((x) => x.id === section.product_type);
              if (!typeDef) return null;
              const typeName = lang === 'en' ? typeDef.label_en : typeDef.label_ar;
              const dropped = typeDef.spec_columns - section.spec_columns;
              return (
                <p className="text-[11px] text-zinc-400 mt-0.5">
                  {dropped > 0
                    ? fill(t.sectionNarrowed, { n: dropped, type: typeName })
                    : fill(t.sectionSame, { type: typeName })}
                </p>
              );
            })()}
            {section.spec_groups && section.spec_groups.length > 0 && (
              <p className="text-[11px] text-zinc-400 mt-1.5">
                <span className="text-zinc-500">{t.sectionGroups} </span>
                {section.spec_groups
                  .map((g) => `${lang === 'en' ? g.label_en : g.label_ar} (${g.fields})`)
                  .join(lang === 'en' ? ', ' : ' · ')}
              </p>
            )}
          </div>
        )}
        {!isTable && <p className="text-[11px] text-zinc-500 mt-2">{t.sectionOptional}</p>}
        {catalogs.length > 0 && options.length === 0 && <p className="text-amber-300/90 text-[11px] mt-2">{t.noFamily}</p>}
        {lookups && <LookupsBox lookups={lookups} section={section} lang={lang} t={t} />}
      </Step>

      {/* 3 — the template, named for what it is -------------------------- */}
      <Step title={t.step3} hint={isTable ? t.tplHintTable : t.tplHintTxt}>
        <div className="flex flex-wrap gap-2">
          {format === 'csv' && (
            <>
              {dlBtn('template-csv', `/api/admin/import/template?${templateQuery}&format=csv`, `levonis-template-${stem}.csv`, t.tplCsv, { kind: 'csv', primary: true, disabled: !effectiveType })}
              {dlBtn('export-csv', `/api/admin/import/export?category=${encodeURIComponent(sectionId)}&format=csv`, `levonis-export-${stem}.csv`, t.exportCsv, { kind: 'csv', disabled: !sectionId })}
            </>
          )}
          {format === 'zip' && (
            <>
              {dlBtn('template-zip', `/api/admin/import/template?${templateQuery}&format=zip`, `levonis-template-${stem}.zip`, t.tplZip, { kind: 'zip', primary: true, disabled: !effectiveType })}
              {dlBtn('export-zip', `/api/admin/import/export?category=${encodeURIComponent(sectionId)}&format=zip`, `levonis-export-${stem}.zip`, t.exportZip, { kind: 'zip', disabled: !sectionId })}
            </>
          )}
          {format === 'txt' && (
            <>
              {dlBtn(
                'template-txt',
                `/api/admin/template/blank${effectiveType ? `?${templateQuery}` : ''}`,
                `levonis-product-template${effectiveType ? `-${stem}` : ''}.txt`,
                t.tplTxt,
                { kind: 'txt', primary: true }
              )}
              {dlBtn('template-txt-example', '/api/admin/template/example', 'levonis-product-template-example.txt', t.tplTxtExample, { kind: 'txt' })}
            </>
          )}
        </div>
        {isTable && !effectiveType && <p className="text-amber-300/90 text-[11px] mt-2">{t.pickTypeFirst}</p>}
      </Step>

      {/* 4 — the file, then the mandatory check -------------------------- */}
      <Step title={t.step4} hint={t.noWrite}>
        <div className="flex flex-wrap items-center gap-2">
          <label className={btnSecondary + ' cursor-pointer max-w-full'}>
            <Upload className="w-4 h-4 shrink-0" />
            <span className="truncate max-w-[15rem]">
              {file ? file.name : format === 'csv' ? t.pickCsv : format === 'zip' ? t.pickZip : t.pickTxt}
            </span>
            <input
              type="file"
              accept={format === 'csv' ? '.csv,text/csv' : format === 'zip' ? '.zip,application/zip' : '.txt,.zip,text/plain,application/zip'}
              data-import="file"
              className="hidden"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                if (e.target.files?.[0]) setPasted('');
                invalidate();
              }}
            />
          </label>
          <button
            type="button"
            data-import="check"
            disabled={busy !== '' || (isTable ? !sectionId || !file : !file && !pasted.trim())}
            onClick={runCheck}
            className={btnPrimary + ' disabled:opacity-40'}
          >
            {busy === 'check' ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
            {busy === 'check' ? t.checking : t.check}
          </button>
        </div>
        {format === 'txt' && (
          <>
            {/* The box is forced LTR because template keys are ASCII and a
                pasted template must not be reordered; so the Arabic label sits
                ABOVE it and the placeholder inside it is a template line. */}
            <label className="block text-[11px] text-zinc-500 mt-2 mb-1" htmlFor="import-paste">{t.orPaste}</label>
            <textarea
              id="import-paste"
              data-import="paste"
              value={pasted}
              onChange={(e) => { setPasted(e.target.value); if (e.target.value.trim()) setFile(null); invalidate(); }}
              dir="ltr"
              placeholder="name_ar=…"
              className={inputCls + ' h-24 font-mono text-[11px]'}
            />
          </>
        )}
        {!check && <p className="text-[11px] text-zinc-500 mt-2">{t.mustCheck}</p>}
      </Step>

      {/* the check report ------------------------------------------------ */}
      {check && !result && buckets && (
        <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3" data-import="check-report">
          <h4 className="text-xs font-bold text-white mb-2 flex items-center gap-1.5">
            <ListChecks className="w-4 h-4 text-violet-400" aria-hidden /> {t.checkTitle}
          </h4>

          <div className="grid gap-1.5 [grid-template-columns:repeat(auto-fit,minmax(120px,1fr))] mb-2">
            <Stat label={t.statProducts} value={check.items.length} tone="info" testId="count-products" />
            <Stat label={t.statCreate} value={check.items.filter((i) => i.action === 'create').length} tone="good" testId="count-create" />
            <Stat label={t.statUpdate} value={check.items.filter((i) => i.action === 'update').length} tone="info" testId="count-update" />
            <Stat label={t.statBlocked} value={blocked} tone={blocked ? 'bad' : 'muted'} testId="count-blocked" />
          </div>
          <div className="grid gap-1.5 [grid-template-columns:repeat(auto-fit,minmax(120px,1fr))]">
            <Stat label={t.bErrors} value={buckets.errors.length} tone={buckets.errors.length ? 'bad' : 'muted'} icon={<XCircle className="w-3 h-3" />} testId="count-errors" />
            <Stat label={t.bMissing} value={buckets.missing.length} tone={buckets.missing.length ? 'warn' : 'muted'} testId="count-missing" />
            <Stat label={t.bImages} value={buckets.images.length} tone={buckets.images.length ? 'warn' : 'muted'} icon={<ImageOff className="w-3 h-3" />} testId="count-images" />
            <Stat label={t.bDuplicates} value={buckets.duplicates.length} tone={buckets.duplicates.length ? 'warn' : 'muted'} icon={<CopyX className="w-3 h-3" />} testId="count-duplicates" />
            <Stat label={t.bNoImages} value={noImages} tone={noImages ? 'warn' : 'muted'} testId="count-no-images" />
            <Stat label={t.bWarnings} value={buckets.warnings.length} tone={buckets.warnings.length ? 'warn' : 'muted'} testId="count-warnings" />
          </div>

          {check.notes.map((n, i) => (
            <p key={i} className="text-[11px] text-amber-300/90 mt-2 break-words">{n}</p>
          ))}
          {check.unknownColumns.length > 0 && (
            <p className="text-[11px] text-amber-300/90 mt-2" dir="ltr">
              {check.format === 'txt' ? t.unknownKeys : t.unknownCols}
              {check.unknownColumns.join(', ')}
            </p>
          )}

          <IssueList title={t.fileIssues} issues={check.fileIssues} t={t} tone="bad" />
          <IssueList title={t.bErrors} issues={buckets.errors.filter((i) => i.product !== null)} t={t} tone="bad" />
          <IssueList title={t.bWarnings} issues={buckets.warnings} t={t} tone="warn" />

          <ItemTable items={check.items} t={t} />

          {unknownKeysPending.length > 0 && (
            <label className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-200 cursor-pointer" data-import="ack-unknown">
              <input
                type="checkbox"
                className="mt-0.5 shrink-0"
                checked={ackUnknown}
                onChange={(e) => setAckUnknown(e.target.checked)}
                data-import="ack-unknown-input"
              />
              <span className="break-words">
                {fill(t.ackUnknown, { n: unknownKeysPending.length, keys: unknownKeysPending.slice(0, 8).join(', ') + (unknownKeysPending.length > 8 ? ', …' : '') })}
              </span>
            </label>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-3">
            <button
              type="button"
              data-import="confirm"
              disabled={busy !== '' || !canImport}
              onClick={() => runImport()}
              className={btnPrimary + ' disabled:opacity-40'}
            >
              {busy === 'confirm' ? <RefreshCw className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              {busy === 'confirm' ? t.confirming : t.confirm}
            </button>
            <span className={`text-[11px] ${blocked ? 'text-amber-300' : 'text-emerald-300'}`}>
              {check.items.length === 0
                ? t.nothingToApply
                : blocked === 0
                  ? t.allClear
                  : importable === 0
                    ? t.blocked
                    : fill(t.partial, { n: importable, b: blocked })}
            </span>
          </div>

        </div>
      )}

      {/* the duplicate question — asked, never answered for the admin ----- */}
      {duplicates.length > 0 && (
        <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-2.5" data-import="duplicate">
          <p className="text-[11px] font-bold text-amber-200 mb-1.5">{t.dupTitle}</p>
          <ul className="text-[11px] text-amber-200/90 mb-2 space-y-0.5" dir="ltr">
            {duplicates.map((d) => <li key={d}>{d}</li>)}
          </ul>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy !== ''} className={btnSecondary} data-import="dup-update" onClick={() => runImport('update_existing')}>
              {t.dupUpdate}
            </button>
            <button type="button" disabled={busy !== ''} className={btnSecondary} data-import="dup-new" onClick={() => runImport('create_hidden_draft_new_identity')}>
              {t.dupNew}
            </button>
          </div>
        </div>
      )}

      {/* the result ------------------------------------------------------ */}
      {result && (
        <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3" data-import="result">
          <p className="text-xs text-zinc-200 mb-2 font-bold">
            {fill(t.summary, { c: result.summary.created, u: result.summary.updated, s: result.summary.skipped, f: result.summary.failed })}
          </p>
          <ResultTable rows={result.rows} t={t} onOpenProduct={onOpenProduct} />
          {(result.review?.length ?? 0) > 0 && (
            <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2">
              <p className="text-[11px] font-bold text-amber-300 mb-1 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> {t.reviewNeeded}
              </p>
              <ul className="text-[11px] text-amber-200 space-y-0.5" dir="ltr">
                {result.review!.slice(0, 20).map((x, n) => <li key={n}>{x}</li>)}
              </ul>
            </div>
          )}
          {result.importId && (
            <div className="mt-3">
              {dlBtn('report', `/api/admin/import/${encodeURIComponent(result.importId)}/report?format=csv`, `levonis-import-${result.importId}.csv`, t.report)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------- lane: table

/** CSV and ZIP: one POST to the preview endpoint, normalised. */
async function checkTable(file: File, sectionId: string, t: Strings): Promise<CheckResult> {
  const form = new FormData();
  form.set('file', file);
  form.set('category', sectionId);
  const res = await api.post<PreviewResponse>('/api/admin/import/preview', form);
  const columns = res.columns ?? [];
  return {
    format: file.name.toLowerCase().endsWith('.zip') ? 'zip' : 'csv',
    importId: res.import_id,
    unknownColumns: res.unknown_columns ?? [],
    // The same line the TXT check shows for a brand it will add — once per
    // brand at the top, however many rows name it (each row also says so).
    notes: (res.brands_to_create ?? []).map((b) => `${t.create}: ${t.lkBrand} «${b.name}» → ${b.slug}`),
    fileIssues: (res.file_issues ?? []).map((i) =>
      readIssueText(i.message, { severity: i.severity === 'warning' ? 'warning' : 'error', columns, line: i.line })
    ),
    items: (res.rows ?? []).map((r) => ({
      id: r.key,
      line: r.line,
      name: r.name,
      action: r.action === 'failed' ? 'blocked' : r.action,
      images: r.images,
      unknownKeys: [],
      issues: [
        ...r.errors.map((m) => readIssueText(m, { product: r.key, severity: 'error', columns })),
        ...r.warnings.map((m) => readIssueText(m, { product: r.key, severity: 'warning', columns })),
      ],
    })),
  };
}

async function applyTable(importId: string, t: Strings, note: (m: string) => void) {
  const res = await api.post<ConfirmResponse>('/api/admin/import/confirm', { import_id: importId });
  if (res.already_applied) note(t.alreadyApplied);
  return {
    importId: res.import_id,
    summary: res.summary,
    review: res.translation_review_needed,
    rows: (res.rows ?? []).map<ResultRow>((r) => ({
      key: r.key,
      name: r.name,
      action: r.action,
      detail: r.reason || r.product_id,
    })),
  };
}

// ---------------------------------------------------------------- lane: txt

/**
 * TXT: one file through /parse, or an archive through /parse-zip. The archive
 * is ALSO unzipped locally, because /apply takes the template text and the
 * server's per-file results do not carry it back.
 */
/** The pre-flight statement of a parse answer, or null when the server said
 *  nothing — never a zero the server did not state. */
function planOf(spec: ApplySpecReport | null | undefined, mode: string | undefined): CheckedItem['plan'] {
  if (!spec && !mode) return undefined;
  return {
    specStored: typeof spec?.stored === 'number' ? spec.stored : null,
    specVisible: typeof spec?.visible_in_form === 'number' ? spec.visible_in_form : null,
    specOutside: Array.isArray(spec?.outside_section) ? spec!.outside_section : [],
    inventoryMode: mode ?? null,
  };
}

async function checkTxt(file: File | null, pasted: string, t: Strings): Promise<CheckResult> {
  if (file && file.name.toLowerCase().endsWith('.zip')) return checkTxtArchive(file, t);

  const text = file ? await file.text() : pasted;
  const res = await api.post<ParseResponse>('/api/admin/template/parse', { text });
  const issues: ImportIssue[] = [
    ...res.errors.map((e) => readIssueEntry(e, { product: file?.name ?? 'template', severity: 'error' })),
    ...(res.validation_error ? [readIssueEntry({ line: 0, key: '', message: res.validation_error.message }, { product: file?.name ?? 'template' })] : []),
    ...res.needs_review.map((n) =>
      readIssueEntry({ line: n.line, key: n.key, message: `${t.needsReview}: ${n.message} «${n.value}»` }, { product: file?.name ?? 'template' })
    ),
    /**
     * THE HALF THAT IS NOT ON THE SERVER. `brands_to_create` is the check
     * step's disclosure that this file will ADD a brand rather than be refused
     * for naming one that does not exist. Dropping it here would put the owner
     * back where they started — pressing «ابدأ الاستيراد» and finding out
     * afterwards. It is a note, never a block, and it is spelled out of the
     * panel's own words so no new sentence has to be translated.
     */
    ...(res.brands_to_create ?? []).map((b) =>
      readIssueEntry(
        { key: 'brand', message: `${t.create}: ${t.lkBrand} «${b.name}» → ${b.slug}` },
        { product: file?.name ?? 'template', severity: 'warning' }
      )
    ),
    ...res.warnings.map((w) => readIssueEntry({ key: '', message: w }, { product: file?.name ?? 'template', severity: 'warning' })),
  ];
  const blocked = issues.some((i) => i.severity === 'error');
  return {
    format: 'txt',
    txtMode: 'single',
    unknownColumns: res.unknown_keys ?? [],
    notes: [],
    fileIssues: [],
    items: [
      {
        id: file?.name ?? 'template',
        line: null,
        name: txtName(text),
        action: blocked ? 'blocked' : res.is_create ? 'create' : 'update',
        images: countTxtImages(text),
        unknownKeys: res.unknown_keys ?? [],
        issues,
        text,
        plan: planOf(res.spec_fields, res.inventory_mode),
      },
    ],
  };
}

async function checkTxtArchive(file: File, t: Strings): Promise<CheckResult> {
  // Local unzip first: without the per-file text there is nothing to apply.
  const texts = new Map<string, string>();
  const notes: string[] = [];
  try {
    const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
    for (const [name, data] of Object.entries(entries)) {
      if (name.endsWith('/') || !name.toLowerCase().endsWith('.txt')) continue;
      texts.set(name, strFromU8(data));
    }
  } catch {
    notes.push(t.zipLocalFailed);
  }

  const form = new FormData();
  form.append('file', file);
  const res = await api.post<ZipParseResponse>('/api/admin/template/parse-zip', form);

  if (res.skipped_entries?.length) notes.push(`${t.zipNotTxt} ${res.skipped_entries.join('، ')}`);
  if (res.skipped_over_limit?.length) {
    notes.push(`${fill(t.zipOverLimit, { n: res.counts?.limit ?? '' })} ${res.skipped_over_limit.join('، ')}`);
  }

  // Two files in one archive naming the same product would import as two
  // products, or as one silently overwriting the other. Named, not hidden.
  const seen = new Map<string, string>();
  const items: CheckedItem[] = res.files.map((f) => {
    const text = texts.get(f.name) ?? '';
    const issues: ImportIssue[] = [
      ...f.errors.map((e) => readIssueEntry(e, { product: f.name, severity: 'error' })),
      ...(f.validation_error ? [readIssueEntry({ line: 0, key: '', message: f.validation_error.message }, { product: f.name })] : []),
      ...f.needs_review.map((n) =>
        readIssueEntry({ line: n.line, key: n.key, message: `${t.needsReview}: ${n.message} «${n.value}»` }, { product: f.name })
      ),
      // Per file, for the same reason as the single-file lane above.
      ...(f.brands_to_create ?? []).map((b) =>
        readIssueEntry(
          { key: 'brand', message: `${t.create}: ${t.lkBrand} «${b.name}» → ${b.slug}` },
          { product: f.name, severity: 'warning' }
        )
      ),
      ...f.warnings.map((w) => readIssueEntry({ key: '', message: w }, { product: f.name, severity: 'warning' })),
    ];
    const name = f.summary?.name_en || f.summary?.name_ar || txtName(text);
    if (name) {
      const first = seen.get(name.toLowerCase());
      if (first && first !== f.name) {
        issues.push(
          readIssueEntry({ key: 'name', message: `مكرر: نفس اسم المنتج في «${first}» / duplicate: the same product name as "${first}"` }, { product: f.name })
        );
      } else seen.set(name.toLowerCase(), f.name);
    }
    const ok = f.ready_to_apply && !!text && !issues.some((i) => i.severity === 'error');
    return {
      id: f.name,
      line: null,
      name,
      action: ok ? (f.is_create === false ? 'update' : 'create') : 'blocked',
      images: countTxtImages(text),
      unknownKeys: f.unknown_keys ?? [],
      issues,
      text,
      plan: planOf(f.spec_fields, f.inventory_mode),
    };
  });

  // The archive's unknown keys, so the check report names them like the
  // single-file lane does instead of hiding them inside each file.
  const unknownColumns = [...new Set(items.flatMap((i) => i.unknownKeys))];
  return { format: 'txt', txtMode: 'archive', unknownColumns, notes, fileIssues: [], items };
}

/**
 * Sequential on purpose: rate-limit friendly, and each file's outcome stays
 * attributable to its own name in the report. A duplicate stops the run and
 * asks — the choice is the admin's, never a default.
 */
async function applyTxt(ready: CheckedItem[], t: Strings, choice: DuplicateChoice | undefined) {
  const rows: ResultRow[] = [];
  const duplicates: string[] = [];
  const summary = { created: 0, updated: 0, skipped: 0, failed: 0 };
  for (const item of ready) {
    if (!item.text) {
      rows.push({ key: item.id, name: item.name, action: 'failed', detail: t.zipLocalFailed });
      summary.failed += 1;
      continue;
    }
    // The row is what the server READ BACK, never what the file said: a 200
    // whose `mismatches` is non-empty is a failure named by section, and the
    // counts shown come from `relations` / `spec_fields` / `images` of the
    // response (applyResult.ts), so "0 groups" is only ever written when the
    // server stated 0.
    let outcome: ApplyOutcome;
    try {
      const out = await applyTxtItem({
        text: item.text,
        mode: item.action === 'update' ? 'update' : 'draft',
        confirm: true,
        duplicate_choice: choice,
      });
      outcome = applyOutcome(out, { alreadyApplied: t.alreadyApplied, mismatched: t.mismatched });
    } catch (e) {
      outcome = applyFailure(e, { duplicate: t.dupTitle, inProgress: t.inProgress, productExists: t.productExists });
      if (e instanceof ApiError && e.code === 'DUPLICATE') duplicates.push(item.id);
    }
    rows.push({ key: item.id, name: item.name, action: outcome.action, detail: outcome.detail, outcome });
    summary[outcome.action] += 1;
  }
  return { summary, rows, duplicates, review: undefined as string[] | undefined, importId: undefined as string | undefined };
}

interface ApplyStatusResponse {
  success: true;
  state: 'applying' | 'applied' | 'retry';
  retry_after_ms?: number;
}

const APPLY_STATUS_FALLBACK_MS = 1500;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A TXT apply can legitimately outlive the API client's ordinary 20-second
 * interaction deadline while remote images are fetched and converted. Keep
 * that request alive, and if this browser is recovering a request that was
 * already accepted, follow the server's read-only status until the same POST
 * can return its verified result. The fingerprint fence still owns all write
 * safety; the browser never guesses that a timed-out write failed.
 */
async function applyTxtItem(payload: {
  text: string;
  mode: 'draft' | 'update';
  confirm: true;
  duplicate_choice: DuplicateChoice | undefined;
}): Promise<ApplyResponse> {
  for (;;) {
    try {
      return await api.post<ApplyResponse>('/api/admin/template/apply', payload, { timeoutMs: 0 });
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'APPLY_IN_PROGRESS') throw error;
      const fingerprint = typeof error.body?.fingerprint === 'string' ? error.body.fingerprint : '';
      if (!/^[a-f0-9]{32}$/.test(fingerprint)) throw error;

      for (;;) {
        const status = await api.get<ApplyStatusResponse>(
          `/api/admin/template/apply-status/${encodeURIComponent(fingerprint)}`,
          { mascot: 'silent' }
        );
        if (status.state !== 'applying') break;
        const retryAfter =
          typeof status.retry_after_ms === 'number' && Number.isFinite(status.retry_after_ms)
            ? Math.max(500, Math.min(5000, status.retry_after_ms))
            : APPLY_STATUS_FALLBACK_MS;
        await wait(retryAfter);
      }
      // `applied` is replayed by /apply with the authoritative read-back;
      // `retry` means the previous owner released/expired without a result.
      // Both safely converge by posting the identical fingerprint once more.
    }
  }
}

/**
 * A second pass answers the duplicate question for the files that asked it,
 * so its rows REPLACE those files' earlier "failed — duplicate" rows rather
 * than being appended beside them.
 */
function mergeResults(prev: ImportResult | null, next: ImportResult): ImportResult {
  if (!prev) return next;
  const replaced = new Set(next.rows.map((r) => r.key));
  const kept = prev.rows.filter((r) => !replaced.has(r.key));
  const summary = { created: 0, updated: 0, skipped: 0, failed: 0 };
  for (const r of [...kept, ...next.rows]) summary[r.action] += 1;
  return { ...next, rows: [...kept, ...next.rows], summary, importId: next.importId ?? prev.importId };
}

// ------------------------------------------------------------------- pieces

function Step({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mt-3 first:mt-0">
      <h4 className="text-[12px] font-bold text-white mb-1">{title}</h4>
      {hint && <p className="text-[11px] leading-relaxed text-zinc-500 mb-1.5">{hint}</p>}
      {children}
    </section>
  );
}

function TypeChip({ id, on, onClick, label, sub }: { id?: string; on: boolean; onClick: () => void; label: string; sub?: string }) {
  return (
    <button
      type="button"
      data-import-type={id}
      aria-pressed={on}
      onClick={onClick}
      title={sub}
      className={`min-h-9 px-2.5 rounded-lg border text-[12px] font-bold transition-colors ${
        on ? 'border-violet-500 bg-violet-500/10 text-white' : 'border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:border-zinc-600'
      }`}
    >
      {label}
      {sub && <span className="text-[10px] font-medium text-zinc-500 ms-1.5">{sub}</span>}
    </button>
  );
}

const TONE = {
  good: 'text-emerald-300 border-emerald-500/25 bg-emerald-500/5',
  bad: 'text-red-300 border-red-500/25 bg-red-500/5',
  warn: 'text-amber-300 border-amber-500/25 bg-amber-500/5',
  info: 'text-sky-300 border-sky-500/25 bg-sky-500/5',
  muted: 'text-zinc-500 border-zinc-800 bg-zinc-900/40',
};

function Stat({ label, value, tone, icon, testId }: { label: string; value: number; tone: keyof typeof TONE; icon?: React.ReactNode; testId: string }) {
  return (
    <div className={`min-w-0 rounded-lg border px-2 py-1.5 ${TONE[tone]}`} data-import-stat={testId}>
      <span className="flex items-center gap-1 text-[15px] font-bold leading-none">
        {icon}
        <span dir="ltr">{value}</span>
      </span>
      <span className="block text-[10px] leading-tight text-zinc-400 mt-1 truncate" title={label}>{label}</span>
    </div>
  );
}

/**
 * Every complaint, each naming its product, its line and its field. Long lists
 * collapse to the first ten with an explicit "show all N" — a truncation the
 * admin can undo, never one that quietly hides the eleventh error.
 */
function IssueList({ title, issues, t, tone }: { title: string; issues: ImportIssue[]; t: Strings; tone: 'bad' | 'warn' }) {
  const [all, setAll] = useState(false);
  if (issues.length === 0) return null;
  const shown = all ? issues : issues.slice(0, 10);
  const c = tone === 'bad' ? 'border-red-500/30 bg-red-500/10 text-red-200' : 'border-amber-500/30 bg-amber-500/10 text-amber-200';
  return (
    <div className={`mt-2 rounded-lg border p-2 ${c}`} data-import-issues={tone}>
      <p className="text-[11px] font-bold mb-1">{title} ({issues.length})</p>
      <ul className="text-[11px] space-y-1">
        {shown.map((i, n) => (
          <li key={n} className="break-words">
            <span className="opacity-70" dir="auto">{issueWhere(i, t.where)}</span>
            {issueWhere(i, t.where) && ' — '}
            <span dir="auto">{i.message}</span>
          </li>
        ))}
      </ul>
      {!all && issues.length > shown.length && (
        <button type="button" onClick={() => setAll(true)} className="mt-1 min-h-9 text-[11px] font-bold underline">
          {fill(t.showAll, { n: issues.length })}
        </button>
      )}
    </div>
  );
}

/** «5 spec fields (3 visible in the form) · outside the section template: 2
 *  (made_up_a, made_up_b) · inventory OPTION» — the check step's half of the
 *  same sentence the result row prints after the write, in the same words. */
function planLine(p: NonNullable<CheckedItem['plan']>, t: Strings): string {
  const w = t.vw as VerificationWords;
  const parts: string[] = [];
  if (p.specStored !== null) {
    parts.push(
      `${p.specStored} ${w.specs}` +
        (p.specVisible !== null && p.specVisible !== p.specStored ? ` (${p.specVisible} ${w.outside})` : '')
    );
  }
  if (p.specOutside.length > 0) parts.push(`${w.outsideSection}: ${p.specOutside.length} (${p.specOutside.join(', ')})`);
  if (p.inventoryMode) parts.push(`${w.inventory} ${p.inventoryMode}`);
  return parts.join(' · ');
}

function ItemTable({ items, t }: { items: CheckedItem[]; t: Strings }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-2 overflow-x-auto -mx-1 px-1">
      <p className="text-[11px] font-bold text-zinc-400 mb-1">{t.rowsTitle}</p>
      <table className="w-full text-[11px] border-collapse min-w-[24rem]">
        <tbody>
          {items.map((i) => (
            <tr key={i.id} className="border-t border-zinc-800/60 align-top">
              <td className="py-1 pe-2 font-mono text-zinc-300"><span dir="ltr">{i.id}</span></td>
              <td className="py-1 pe-2 text-zinc-300"><span dir="ltr">{i.name}</span></td>
              <td className={`py-1 pe-2 font-bold ${i.action === 'blocked' ? 'text-red-300' : i.action === 'create' ? 'text-emerald-300' : 'text-sky-300'}`}>
                {i.action === 'blocked' ? t.blockedRow : i.action === 'create' ? t.create : t.update}
              </td>
              <td className="py-1 text-zinc-500" dir="ltr">{i.images} img</td>
              <td className="py-1 ps-2 text-zinc-500" dir="ltr" data-import-plan={i.plan ? 'reported' : 'none'}>
                {i.plan ? planLine(i.plan, t) : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResultTable({ rows, t, onOpenProduct }: { rows: ResultRow[]; t: Strings; onOpenProduct?: (id: string) => void }) {
  if (rows.length === 0) return null;
  const word = { created: t.created, updated: t.updated, skipped: t.skipped, failed: t.failed };
  const tone = { created: 'text-emerald-300', updated: 'text-emerald-300', skipped: 'text-amber-300', failed: 'text-red-300' };
  return (
    <div className="overflow-x-auto -mx-1 px-1">
      <table className="w-full text-[11px] border-collapse min-w-[24rem]">
        <tbody>
          {rows.map((r, i) => (
            <React.Fragment key={`${r.key}-${i}`}>
              <tr className="border-t border-zinc-800/60 align-top" data-import-row={r.action}>
                <td className="py-1 pe-2 font-mono text-zinc-300"><span dir="ltr">{r.key}</span></td>
                <td className="py-1 pe-2 text-zinc-300"><span dir="ltr">{r.name}</span></td>
                <td className={`py-1 pe-2 font-bold ${tone[r.action]}`}>{word[r.action]}</td>
                <td className="py-1 text-zinc-400 break-words">
                  <span dir="auto">{r.detail}</span>
                  {onOpenProduct && r.outcome?.productId && (
                    <button
                      type="button"
                      className="ms-2 underline text-violet-300 hover:text-white"
                      onClick={() => onOpenProduct(r.outcome!.productId)}
                      data-import="open-product"
                    >
                      {t.openInForm}
                    </button>
                  )}
                </td>
              </tr>
              {r.outcome && <OutcomeDetails o={r.outcome} t={t} />}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Under each TXT row: the read-back counts (or the honest "unreported"), the
 * apply-time warnings and unknown keys, and the applied / preserved / cleared
 * tallies. Nothing here is computed from the file text.
 */
function OutcomeDetails({ o, t }: { o: ApplyOutcome; t: Strings }) {
  const v = o.verify;
  const line = verificationLine(v, t.vw as VerificationWords);
  const hasFields = o.appliedFields.length + o.preservedFields.length + o.clearedFields.length > 0;
  return (
    <tr className="align-top" data-import-outcome={o.action}>
      <td colSpan={4} className="pb-2 ps-2">
        <div className="text-[10.5px] text-zinc-400 space-y-0.5">
          <p data-import-verify={v.reported ? 'reported' : 'unreported'}>
            <span className="text-zinc-500">{t.verifyTitle} </span>
            <span dir="ltr" className={v.reported ? 'text-zinc-200' : 'text-amber-300'}>{line}</span>
            {v.reported && v.spec_outside.length > 0 && (
              <span className="text-amber-300" dir="ltr"> — {t.vw.outsideSection}: {v.spec_outside.length} ({v.spec_outside.join(', ')})</span>
            )}
          </p>
          {!v.reported && o.action !== 'failed' && <p className="text-amber-300">{t.verifyUnreported}</p>}
          {hasFields && (
            <p dir="auto">{fill(t.fieldsLine, { a: o.appliedFields.length, p: o.preservedFields.length, c: o.clearedFields.length })}</p>
          )}
          {o.unknownKeys.length > 0 && (
            <p className="text-amber-300" data-import-unknown-keys>
              {t.unknownAtApply} <span dir="ltr">{o.unknownKeys.join(', ')}</span>
            </p>
          )}
          {o.issues.length > 0 && (
            <ul className="text-red-300 list-disc ms-4" data-import-apply-issues>
              {o.issues.map((m, n) => <li key={n} dir="auto" className="break-words">{m}</li>)}
            </ul>
          )}
          {o.warnings.length > 0 && (
            <>
              <p className="text-zinc-500">{t.warningsAtApply}</p>
              <ul className="text-amber-200/90 list-disc ms-4" data-import-apply-warnings>
                {o.warnings.map((w, n) => <li key={n} dir="auto" className="break-words">{w}</li>)}
              </ul>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

/**
 * The accepted values of the classification columns, as copyable chips. It
 * RENDERS nothing while closed rather than hiding a laid-out list: the four
 * lists run to a couple of hundred values, and this window is meant to be the
 * uncrowded one.
 */
function LookupsBox({ lookups, section, lang, t }: { lookups: Lookups; section?: Catalog; lang: string; t: Strings }) {
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
  return (
    <div className="mt-2 rounded-xl border border-zinc-800 bg-zinc-900/40" data-import="lookups">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-import="lookups-toggle"
        className="w-full flex items-center gap-2 px-3 min-h-10 text-[11px] font-bold text-white text-start"
      >
        <ChevronDown className={`w-4 h-4 shrink-0 transition-transform ${open ? '' : '-rotate-90 rtl:rotate-90'}`} aria-hidden />
        <span className="min-w-0 truncate">{t.lookupsTitle}</span>
      </button>
      {!open ? null : (
        <div className="px-3 pb-3 space-y-3 max-h-72 overflow-y-auto">
          <p className="text-[11px] text-zinc-500">{t.lookupsHint}</p>
          <div role="status" aria-live="polite" className="sr-only">{copied ? `${t.copied}: ${copied}` : ''}</div>
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
            <h5 className="text-[11px] font-bold text-zinc-300 mb-1">{t.lkHashtag}</h5>
            {chips(lookups.hashtags.map((h) => ({ key: h.tag, value: h.tag, label: h.name_ar || undefined })), 'hashtags')}
            <p className="text-[10px] text-zinc-500 mt-1">{t.lkHashtagFree}</p>
          </div>
        </div>
      )}
    </div>
  );
}
