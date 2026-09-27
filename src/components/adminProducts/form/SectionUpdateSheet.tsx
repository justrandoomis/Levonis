/**
 * «تحديث البيانات» — a saved product's specifications and extra content,
 * updated from a file (owner, 2026-09-27).
 *
 *   1. نزّل بيانات المنتج — the section as a TXT, or a CSV for a spreadsheet
 *      (GET /api/admin/template/section-export/:id).
 *   2. ارفع ملف التحديث — the edited file (or the full export; anything outside
 *      the section is dropped by the server, never here).
 *   3. قارن — every changed field of the section, before → after, and what the
 *      file says elsewhere, named as NOT saved (POST …/section-preview).
 *   4. حفظ — POST …/apply with `scope: specs_content`: the server cuts the file
 *      again, writes only the section, and refuses if the product changed after
 *      the comparison.
 *
 * The comparison is the server's; this sheet only lays it out. After a save
 * the editor reads the product back and keeps the admin's unsaved edits in
 * every other section (ProductForm `reloadKeepingEdits`).
 */
import React, { useCallback, useRef, useState } from 'react';
import { AlertTriangle, Check, Download, FileUp, RefreshCw } from 'lucide-react';
import { Modal } from '../ui';
import { api, ApiError } from '../../../lib/api';
import { downloadAdminFile, DownloadError } from '../download';
import { btnGhost, btnPrimary } from './formUi';

interface Change {
  field: string;
  before: string | null;
  after: string | null;
}

interface Preview {
  updated_at: string | null;
  errors: Array<{ line: number; key: string; message: string }>;
  warnings: string[];
  validation_error: { message: string; errors?: unknown[] } | null;
  lines: number;
  changes: Change[];
  ignored_keys: string[];
  ignored_changes: Change[];
}

/** A spec field's own name, from the section's template (ProductForm's `tplGroups`). */
export interface SpecFieldName {
  id: string;
  label_ar: string;
  unit?: string;
}

const PART: Record<string, string> = {
  id: 'المعرّف',
  kind: 'النوع',
  body_ar: 'النص (عربي)',
  body_en: 'النص (إنجليزي)',
  body_ckb: 'النص (كردي)',
  caption_ar: 'التعليق (عربي)',
  caption_en: 'التعليق (إنجليزي)',
  caption_ckb: 'التعليق (كردي)',
  alt_ar: 'النص البديل (عربي)',
  alt_en: 'النص البديل (إنجليزي)',
  alt_ckb: 'النص البديل (كردي)',
  title_ar: 'العنوان (عربي)',
  title_en: 'العنوان (إنجليزي)',
  title_ckb: 'العنوان (كردي)',
  label_ar: 'الاسم (عربي)',
  label_en: 'الاسم (إنجليزي)',
  label_ckb: 'الاسم (كردي)',
  value_ar: 'القيمة (عربي)',
  value_en: 'القيمة (إنجليزي)',
  value_ckb: 'القيمة (كردي)',
  text_ar: 'النص (عربي)',
  text_en: 'النص (إنجليزي)',
  text_ckb: 'النص (كردي)',
  unit: 'الوحدة',
  url: 'الرابط',
  media_key: 'مفتاح الملف',
  visible: 'ظاهرة',
  order: 'الترتيب',
};

const GROUP: Record<string, string> = {
  content_blocks: 'كتلة المحتوى',
  spec_groups: 'مجموعة المواصفات',
  labels: 'الشارة',
  usage_steps: 'خطوة الدليل',
};

/** The field in the owner's words; the key itself is shown beside it. */
export function sectionFieldLabel(key: string, specs: readonly SpecFieldName[]): string {
  if (key.startsWith('spec.')) {
    const id = key.slice(5);
    const f = specs.find((s) => s.id === id);
    return f ? (f.unit ? `${f.label_ar} (${f.unit})` : f.label_ar) : id;
  }
  if (key === 'usage_official_url') return 'رابط الدليل الرسمي';
  if (key === 'how_to_use_ar') return 'طريقة الاستخدام (عربي)';
  if (key === 'how_to_use_en' || key === 'how_to_use') return 'طريقة الاستخدام (إنجليزي)';
  if (key === 'how_to_use_ckb') return 'طريقة الاستخدام (كردي)';
  const m = /^([a-z_]+)\.(\d+)\.(?:rows\.(\d+)\.)?(.+)$/.exec(key);
  if (!m || !GROUP[m[1]]) return key;
  const row = m[3] ? ` · صف ${m[3]}` : '';
  return `${GROUP[m[1]]} ${m[2]}${row} · ${PART[m[4]] ?? m[4]}`;
}

const shown = (v: string | null) => (v === null || v === '' || v === '__NULL__' ? '—' : v);

/** An Arabic count in its own grammar: 1, 2, 3–10, 11+. */
function arCount(n: number, one: string, two: string, few: string, many: string): string {
  if (n === 1) return one;
  if (n === 2) return two;
  if (n >= 3 && n <= 10) return `${n} ${few}`;
  return `${n} ${many}`;
}
const changesText = (n: number) => arCount(n, 'تغيير واحد', 'تغييران', 'تغييرات', 'تغييرًا');
const linesText = (n: number) => arCount(n, 'سطر واحد', 'سطران', 'أسطر', 'سطرًا');

export default function SectionUpdateSheet({
  productId,
  specs,
  formDirty,
  onClose,
  onSaved,
}: {
  productId: string;
  specs: readonly SpecFieldName[];
  /** The editor holds unsaved edits — they are kept; only this section takes the file's values. */
  formDirty: boolean;
  onClose: () => void;
  /** After a save: the editor reloads the product (keeping its other unsaved edits) and shows this line. */
  onSaved: (note: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [downloading, setDownloading] = useState<'txt' | 'csv' | null>(null);
  const [downloadNote, setDownloadNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [file, setFile] = useState<{ name: string; text: string; format: 'txt' | 'csv' } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [showIgnored, setShowIgnored] = useState(false);

  const download = async (format: 'txt' | 'csv') => {
    setDownloading(format);
    setDownloadNote(null);
    try {
      const out = await downloadAdminFile(
        `/api/admin/template/section-export/${encodeURIComponent(productId)}${format === 'csv' ? '?format=csv' : ''}`,
        `levonis-specs-${productId}.${format}`,
        format === 'csv'
          ? { accept: 'text/csv', ext: 'csv', type: 'text/csv;charset=utf-8' }
          : { accept: 'text/plain', ext: 'txt', type: 'text/plain;charset=utf-8' }
      );
      setDownloadNote({ ok: true, text: `بدأ التنزيل: ${out.filename}` });
    } catch (e) {
      setDownloadNote({ ok: false, text: e instanceof DownloadError ? e.message : 'تعذّر التنزيل' });
    } finally {
      setDownloading(null);
    }
  };

  const compare = useCallback(
    async (next: { name: string; text: string; format: 'txt' | 'csv' }) => {
      setChecking(true);
      setProblem(null);
      setPreview(null);
      try {
        const res = await api.post<Preview>('/api/admin/template/section-preview', {
          product_id: productId,
          text: next.text,
          format: next.format,
        });
        setPreview(res);
      } catch (e) {
        setProblem(e instanceof ApiError ? e.message : 'تعذّرت المقارنة — أعد المحاولة');
      } finally {
        setChecking(false);
      }
    },
    [productId]
  );

  const pick = async (f: File | undefined) => {
    if (!f) return;
    const text = await f.text();
    const format: 'txt' | 'csv' =
      /\.csv$/i.test(f.name) || /^\uFEFF?key,value\s*$/im.test(text.split('\n', 1)[0] ?? '') ? 'csv' : 'txt';
    const next = { name: f.name, text, format };
    setFile(next);
    void compare(next);
  };

  const save = async () => {
    if (!file || !preview || saving) return;
    setSaving(true);
    setProblem(null);
    try {
      await api.post('/api/admin/template/apply', {
        text: file.text,
        format: file.format,
        mode: 'update',
        confirm: true,
        scope: 'specs_content',
        product_id: productId,
        expected_updated_at: preview.updated_at,
      });
      onSaved(`حُفظ من الملف ${changesText(preview.changes.length)}`);
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'STALE') {
        setProblem('تغيّر المنتج بعد المقارنة — أعد المقارنة ثم احفظ.');
      } else {
        setProblem(e instanceof ApiError ? e.message : 'تعذّر الحفظ — أعد المحاولة');
      }
    } finally {
      setSaving(false);
    }
  };

  const blocked = !!preview && (preview.errors.length > 0 || !!preview.validation_error);
  const canSave = !!preview && !blocked && preview.changes.length > 0 && !saving && !checking;

  return (
    <Modal
      titleAr="تحديث البيانات"
      titleEn="Update specifications & extras from a file"
      wide
      dirty={!!file && !!preview && preview.changes.length > 0}
      onClose={onClose}
      footer={
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <span className="text-[11px] text-zinc-500 flex-1 min-w-[140px]">
            {preview && preview.changes.length > 0
              ? `${changesText(preview.changes.length)} في المواصفات والمحتوى الإضافي${
                  formDirty ? ' — تعديلاتك غير المحفوظة في بقية الأقسام تبقى كما هي' : ''
                }`
              : 'المواصفات والمحتوى الإضافي فقط'}
          </span>
          <button type="button" className={btnGhost} onClick={onClose}>
            إلغاء
          </button>
          <button type="button" className={btnPrimary} disabled={!canSave} onClick={() => void save()} data-section-update-save>
            {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} حفظ التغييرات
          </button>
        </div>
      }
    >
      <p className="text-[12px] leading-relaxed text-zinc-400 mb-3">
        يُحفظ من الملف قسم «المواصفات والمحتوى الإضافي» وحده. السعر والخيارات والألوان والصور والاسم وبقية الأقسام لا
        تتغير مهما كان في الملف.
      </p>

      <div className="space-y-2.5 min-w-0">
        {/* 1 — the file to edit */}
        <div className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 space-y-2" data-section-update-step="download">
          <h4 className="text-[12px] font-bold text-zinc-200">١. نزّل بيانات المنتج</h4>
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <button type="button" className={btnGhost} disabled={!!downloading} onClick={() => void download('txt')}>
              {downloading === 'txt' ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} TXT
            </button>
            <button type="button" className={btnGhost} disabled={!!downloading} onClick={() => void download('csv')}>
              {downloading === 'csv' ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} CSV
              (Excel / Numbers)
            </button>
          </div>
          {downloadNote && (
            <p className={`text-[11px] ${downloadNote.ok ? 'text-emerald-300' : 'text-red-400'}`} role="status">
              {downloadNote.text}
            </p>
          )}
        </div>

        {/* 2 — the edited file */}
        <div className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 space-y-2" data-section-update-step="upload">
          <h4 className="text-[12px] font-bold text-zinc-200">٢. ارفع ملف التحديث</h4>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.csv,text/plain,text/csv"
            className="sr-only"
            onChange={(e) => {
              void pick(e.target.files?.[0]);
              e.target.value = '';
            }}
            data-section-update-file
          />
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <button type="button" className={btnGhost} onClick={() => fileRef.current?.click()}>
              <FileUp className="w-4 h-4" /> {file ? 'اختر ملفًا آخر' : 'اختر الملف'}
            </button>
            {file && (
              <span className="text-[11px] text-zinc-400 truncate min-w-0" dir="ltr">
                {file.name}
              </span>
            )}
          </div>
        </div>

        {/* 3 — the comparison */}
        {(checking || preview || problem) && (
          <div className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 space-y-2" data-section-update-step="compare">
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <h4 className="text-[12px] font-bold text-zinc-200 flex-1 min-w-0">٣. التغييرات</h4>
              {file && !checking && (
                <button type="button" className={btnGhost} onClick={() => void compare(file)}>
                  <RefreshCw className="w-4 h-4" /> أعد المقارنة
                </button>
              )}
            </div>
            {checking && <p className="text-[11px] text-zinc-500">جارٍ المقارنة…</p>}
            {problem && (
              <p className="text-[12px] text-red-400 inline-flex items-center gap-1" role="alert">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {problem}
              </p>
            )}
            {preview && (
              <>
                {preview.errors.length > 0 && (
                  <ul className="ms-4 list-disc space-y-0.5 text-[11px] text-red-400" role="alert">
                    {preview.errors.map((e, i) => (
                      <li key={i} className="break-words">
                        {e.line > 0 ? `سطر ${e.line}: ` : ''}
                        {e.message}
                      </li>
                    ))}
                  </ul>
                )}
                {preview.validation_error && (
                  <p className="text-[12px] text-red-400 break-words" role="alert">
                    {preview.validation_error.message}
                  </p>
                )}
                {!blocked && preview.changes.length === 0 && (
                  <p className="text-[12px] text-zinc-400">
                    {preview.lines === 0
                      ? 'لا يحتوي الملف على أي سطر من المواصفات أو المحتوى الإضافي.'
                      : 'لا تغيير — قيم الملف مطابقة لما هو محفوظ.'}
                  </p>
                )}
                {preview.changes.length > 0 && (
                  <div className="space-y-2.5 min-w-0">
                    {preview.changes.map((ch) => (
                      <div key={ch.field} className="rounded-md bg-black/30 border border-zinc-800 px-2 py-1.5 min-w-0" data-section-change={ch.field}>
                        <div className="flex flex-wrap items-center gap-2 min-w-0">
                          <span className="text-[12px] font-bold text-zinc-200 truncate min-w-0 flex-1">
                            {sectionFieldLabel(ch.field, specs)}
                          </span>
                          <span className="text-[10px] text-zinc-500 truncate" dir="ltr">
                            {ch.field}
                          </span>
                        </div>
                        <p className="text-[11px] text-zinc-500 whitespace-pre-wrap break-words" dir="auto">
                          قبل: {shown(ch.before)}
                        </p>
                        <p className="text-[11px] text-emerald-300 whitespace-pre-wrap break-words" dir="auto">
                          بعد: {shown(ch.after)}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
                {preview.ignored_keys.length > 0 && (
                  <div className="rounded-lg border border-zinc-800 bg-zinc-800/30 p-2.5 min-w-0">
                    <button
                      type="button"
                      className="text-[11px] text-zinc-400 text-start w-full"
                      aria-expanded={showIgnored}
                      onClick={() => setShowIgnored((v) => !v)}
                    >
                      {preview.ignored_changes.length > 0
                        ? `${changesText(preview.ignored_changes.length)} خارج هذا القسم في الملف — لن يُحفظ`
                        : `${linesText(preview.ignored_keys.length)} خارج هذا القسم في الملف — لن يُحفظ`}
                    </button>
                    {showIgnored && (
                      <ul className="ms-4 mt-1.5 list-disc space-y-0.5 text-[11px] text-zinc-500">
                        {(preview.ignored_changes.length > 0
                          ? preview.ignored_changes.map((c) => `${c.field} — قبل: ${shown(c.before)} · بعد: ${shown(c.after)}`)
                          : preview.ignored_keys
                        ).map((line) => (
                          <li key={line} className="break-words" dir="auto">
                            {line}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {preview.warnings.length > 0 && (
                  <ul className="ms-4 list-disc space-y-0.5 text-[11px] text-amber-300">
                    {preview.warnings.map((w, i) => (
                      <li key={i} className="break-words">
                        {w}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
