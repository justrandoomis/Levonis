/**
 * استيراد وتصدير — deterministic TXT template workflow (mandate §6, NO AI):
 *  - download blank template / export the current product (same-origin GET
 *    attachments carry the admin cookie);
 *  - paste or upload a completed TXT → POST /parse → sectioned PREVIEW/DIFF
 *    modal (before/after per field, unknown keys, needs-review picks, errors
 *    with line numbers) → POST /apply ONLY on explicit confirm;
 *  - duplicate (409 DUPLICATE) → explicit choice dialog;
 *  - ZIP upload → server parse-zip results per file; applying uses the
 *    locally-unzipped text per file, so one bad file never hides the others.
 */

import React, { useState } from 'react';
import { unzipSync, strFromU8 } from 'fflate';
import { Download, Upload, FileText, AlertTriangle, Check, Plus } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import type {
  ParseResponse, ApplyResponse, ZipParseResponse, ZipFileResult, DuplicateChoice,
  NeedsReviewEntry, BrandResponse,
} from './types';
import { L, Section, Modal, inputCls, btnPrimary, btnSecondary } from './ui';

const NULL_TOKEN = '__NULL__';

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
}: {
  productId?: string;
  onApplied: (productId: string) => void;
  insideSection?: boolean;
}) {
  const body = (
    <div>
      <DownloadRow productId={productId} />
      <SingleTxtFlow onApplied={onApplied} />
      <ZipFlow onApplied={onApplied} />
    </div>
  );
  if (!insideSection) return body;
  return (
    <Section ar="استيراد وتصدير" en="Import & export (TXT template)">
      <p className="text-xs text-zinc-500 mb-4">
        القالب النصي هو المسار الرسمي للترجمات والاستيراد الجماعي — بلا أي ذكاء اصطناعي، معاينة قبل أي كتابة.
        <span className="mx-1">Deterministic TXT pipeline; preview before any write; no AI.</span>
      </p>
      {body}
    </Section>
  );
}

function DownloadRow({ productId }: { productId?: string }) {
  return (
    <div className="flex flex-wrap gap-2 mb-5">
      <a href="/api/admin/template/blank" download className={btnSecondary}>
        <Download className="w-4 h-4" /> قالب فارغ / blank template
      </a>
      {productId && (
        <a href={`/api/admin/template/export/${productId}`} download className={btnSecondary}>
          <Download className="w-4 h-4" /> تصدير هذا المنتج / export this product
        </a>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- single TXT

function SingleTxtFlow({ onApplied }: { onApplied: (id: string) => void }) {
  const [text, setText] = useState('');
  const [parsing, setParsing] = useState(false);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [parseRes, setParseRes] = useState<ParseResponse | null>(null);
  const [open, setOpen] = useState(false);

  const parse = async (t?: string) => {
    const src = t ?? text;
    if (!src.trim() || parsing) return;
    setParsing(true); setParseErr(null);
    try {
      const res = await api.post<ParseResponse>('/api/admin/template/parse', { text: src });
      setParseRes(res);
      setOpen(true);
    } catch (e) {
      setParseErr(e instanceof ApiError ? e.message : 'فشل التحليل / parse failed');
    } finally {
      setParsing(false);
    }
  };

  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-4 mb-4">
      <L ar="قالب TXT مكتمل" en="Completed TXT template" hint="الصق النص أو ارفع ملف .txt — لن يُكتب شيء قبل المعاينة والتأكيد" />
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        dir="ltr"
        placeholder="name_ar=… أو الصق محتوى القالب هنا"
        className={inputCls + ' h-32 font-mono text-xs'}
      />
      <div className="flex flex-wrap gap-2 mt-3">
        <label className={btnSecondary + ' cursor-pointer'}>
          <Upload className="w-4 h-4" /> رفع ملف TXT / upload
          <input type="file" className="hidden" accept=".txt,text/plain" onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            const t = await f.text();
            setText(t);
            parse(t);
          }} />
        </label>
        <button type="button" onClick={() => parse()} disabled={parsing || !text.trim()} className={btnPrimary}>
          <FileText className="w-4 h-4" /> {parsing ? 'جارٍ التحليل…' : 'معاينة / preview'}
        </button>
      </div>
      {parseErr && <div className="text-red-400 text-sm mt-2">{parseErr}</div>}

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
  const [applying, setApplying] = useState(false);
  const [applyErr, setApplyErr] = useState<string | null>(null);
  const [dupPending, setDupPending] = useState(false);

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
      onApplied(out.product_id);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DUPLICATE') {
        setDupPending(true);
      } else {
        setApplyErr(e instanceof ApiError ? e.message : 'فشل التطبيق / apply failed');
      }
    } finally {
      setApplying(false);
    }
  };

  return (
    <Modal wide titleAr="معاينة القالب قبل التطبيق" titleEn="Template preview & diff" onClose={onClose}>
      <div className="flex flex-wrap items-center gap-2 mb-4 text-xs">
        <span className={`px-2 py-1 rounded-lg border font-bold ${res.is_create ? 'bg-sky-500/10 text-sky-400 border-sky-500/30' : 'bg-violet-500/10 text-violet-400 border-violet-500/30'}`}>
          {res.is_create ? 'إنشاء منتج جديد (مسودة) / create draft' : `تحديث منتج موجود / update ${res.product_id}`}
        </span>
        <span className="text-zinc-500">
          سيُطبق {res.applied_fields.length} · يُمسح {res.cleared_fields.length} · يُحافَظ على {res.preserved_fields.length}
        </span>
      </div>

      {res.errors.length > 0 && (
        <Block tone="red" titleAr="أخطاء — يمنع التطبيق" titleEn="errors (blocking)">
          <ul className="list-disc ms-5 text-xs">
            {res.errors.map((e, i) => (
              <li key={`${e.line}-${e.key}-${i}`}>
                سطر {e.line} — <span className="font-mono">{e.key || '—'}</span>: {e.message}
              </li>
            ))}
          </ul>
        </Block>
      )}

      {res.validation_error && (
        <Block tone="red" titleAr="خطأ تحقق" titleEn="validation error">
          <div className="text-xs">{res.validation_error.message}</div>
        </Block>
      )}

      {res.needs_review.length > 0 && (
        <NeedsReviewBlock entries={res.needs_review} onResolved={onReparse} />
      )}

      {res.unknown_keys.length > 0 && (
        <Block tone="amber" titleAr="مفاتيح غير معروفة (تُتجاهل)" titleEn="unknown keys (ignored)">
          <div className="flex flex-wrap gap-1.5">
            {res.unknown_keys.map((k) => (
              <span key={k} className="font-mono text-[10px] bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-400">{k}</span>
            ))}
          </div>
        </Block>
      )}

      {res.warnings.length > 0 && (
        <Block tone="amber" titleAr="تنبيهات" titleEn="warnings">
          <ul className="list-disc ms-5 text-xs">
            {res.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </Block>
      )}

      <div className="mb-4">
        <L ar="الفروقات (قبل ← بعد)" en="Diff (before → after)" />
        {res.diff.length === 0 ? (
          <div className="text-zinc-500 text-sm">لا تغييرات / no changes</div>
        ) : (
          <div className="border border-zinc-800 rounded-xl overflow-hidden">
            <div className="max-h-72 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-zinc-900">
                  <tr className="text-zinc-500 text-start">
                    <th className="p-2 text-start font-bold">الحقل / field</th>
                    <th className="p-2 text-start font-bold">قبل / before</th>
                    <th className="p-2 text-start font-bold">بعد / after</th>
                  </tr>
                </thead>
                <tbody>
                  {res.diff.map((d) => (
                    <tr key={d.field} className="border-t border-zinc-800/70 align-top">
                      <td className="p-2 font-mono text-zinc-400 whitespace-nowrap" dir="ltr">{d.field}</td>
                      <td className="p-2 text-zinc-500">{tokenLabel(d.before)}</td>
                      <td className="p-2 text-zinc-200">{tokenLabel(d.after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {applyErr && <div className="text-red-400 text-sm mb-3">{applyErr}</div>}

      {dupPending ? (
        <DuplicateChoiceBox
          applying={applying}
          onChoice={(c) => apply(c)}
          onCancel={() => setDupPending(false)}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={blocked || applying}
            onClick={() => apply()}
            className={btnPrimary}
          >
            <Check className="w-4 h-4" />
            {applying ? 'جارٍ التطبيق…' : res.is_create ? 'تأكيد الإنشاء كمسودة / confirm create draft' : 'تأكيد التحديث / confirm update'}
          </button>
          <button type="button" onClick={onClose} className={btnSecondary}>إلغاء / cancel</button>
          {blocked && (
            <span className="text-[11px] text-amber-400">
              عالج الأخطاء وبنود المراجعة أولاً — التطبيق معطّل بأمانة.
            </span>
          )}
        </div>
      )}
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
  return (
    <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
      <div className="text-amber-300 font-bold text-sm mb-2 flex items-center gap-2">
        <AlertTriangle className="w-4 h-4" />
        يوجد منتج بنفس الاسم/الرابط — اختر طريقة المتابعة / duplicate found
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={applying} onClick={() => onChoice('update_existing')} className={btnPrimary}>
          تحديث المنتج الموجود / update existing
        </button>
        <button type="button" disabled={applying} onClick={() => onChoice('create_hidden_draft_new_identity')} className={btnSecondary}>
          إنشاء مسودة جديدة بهوية جديدة / new hidden draft
        </button>
        <button type="button" disabled={applying} onClick={onCancel} className={btnSecondary}>
          إلغاء / cancel
        </button>
      </div>
    </div>
  );
}

function NeedsReviewBlock({ entries, onResolved }: { entries: NeedsReviewEntry[]; onResolved: () => void }) {
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
    <Block tone="amber" titleAr="بحاجة لمراجعة — يمنع التطبيق" titleEn="needs review (blocking)">
      {err && <div className="text-red-400 text-xs mb-2">{err}</div>}
      <ul className="flex flex-col gap-2">
        {entries.map((n, i) => (
          <li key={`${n.key}-${n.value}-${i}`} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-mono bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5">{n.key}</span>
            <span className="text-zinc-300" dir="auto">«{n.value}»</span>
            <span className="text-zinc-500">{n.message} (سطر {n.line})</span>
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
  | { phase: 'applied'; productId: string; created: boolean }
  | { phase: 'duplicate' }
  | { phase: 'error'; message: string };

function ZipFlow({ onApplied }: { onApplied: (id: string) => void }) {
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
      setZipErr(e instanceof ApiError ? e.message : 'فشل رفع ZIP / ZIP upload failed');
    } finally {
      setUploading(false);
    }
  };

  const applyFile = async (f: ZipFileResult, choice?: DuplicateChoice) => {
    const text = texts[f.name];
    if (!text) {
      setFileState(f.name, { phase: 'error', message: 'تعذّر قراءة نص الملف محلياً — طبّقه من مسار الملف المفرد / apply via the single-file flow' });
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
      setFileState(f.name, { phase: 'applied', productId: out.product_id, created: out.created });
      onApplied(out.product_id);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DUPLICATE') {
        setFileState(f.name, { phase: 'duplicate' });
      } else {
        setFileState(f.name, { phase: 'error', message: e instanceof ApiError ? e.message : 'فشل التطبيق' });
      }
    }
  };

  const readyFiles = (result?.files ?? []).filter(
    (f) => f.ready_to_apply && (states[f.name]?.phase ?? 'idle') === 'idle' && !!texts[f.name]
  );

  const applyAll = async () => {
    for (const f of readyFiles) {
      // Sequential on purpose: rate-limit friendly and per-file status stays readable.
      // eslint-disable-next-line no-await-in-loop
      await applyFile(f);
    }
  };

  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-4">
      <L ar="استيراد جماعي (ZIP)" en="Bulk import (ZIP of .txt)" hint="كل ملف يُحلَّل ويُطبَّق على حدة — ملف خاطئ لا يخفي البقية" />
      <label className={btnSecondary + ' cursor-pointer w-fit'}>
        <Upload className="w-4 h-4" /> {uploading ? 'جارٍ التحليل…' : 'رفع ملف ZIP / upload ZIP'}
        <input type="file" className="hidden" accept=".zip,application/zip" disabled={uploading} onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) handleZip(f);
        }} />
      </label>
      {zipErr && <div className="text-red-400 text-sm mt-2">{zipErr}</div>}
      {textsUnavailable && result && (
        <div className="text-amber-400 text-xs mt-2">
          تعذّر فك الضغط محلياً — تظهر نتائج التحليل لكن التطبيق يتطلب رفع كل ملف عبر مسار الملف المفرد.
        </div>
      )}

      {result && (
        <div className="mt-4">
          {result.skipped_entries.length > 0 && (
            <div className="text-zinc-500 text-xs mb-2">
              تم تجاهل ملفات ليست ‎.txt: {result.skipped_entries.join('، ')}
            </div>
          )}
          {result.skipped_over_limit.length > 0 && (
            <div className="text-amber-400 text-xs mb-2">
              تجاوزت الحد الأقصى — لم تُحلَّل: {result.skipped_over_limit.join('، ')}
            </div>
          )}

          {readyFiles.length > 1 && (
            <button type="button" onClick={applyAll} className={btnPrimary + ' mb-3'}>
              تطبيق كل الجاهز ({readyFiles.length}) / apply all ready
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
                        {f.product_id ? ` · تحديث ${f.product_id}` : ' · إنشاء مسودة'}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {st.phase === 'applied' ? (
                        <span className="text-emerald-400 text-xs font-bold flex items-center gap-1">
                          <Check className="w-4 h-4" />
                          {st.created ? 'أُنشئت مسودة' : 'حُدّث'} · {st.productId}
                        </span>
                      ) : st.phase === 'applying' ? (
                        <span className="text-zinc-400 text-xs">جارٍ التطبيق…</span>
                      ) : f.ready_to_apply ? (
                        <button
                          type="button"
                          disabled={!texts[f.name]}
                          onClick={() => applyFile(f)}
                          className={btnSecondary + ' !py-1.5 text-xs'}
                        >
                          {f.product_id ? 'تطبيق التحديث' : 'تطبيق (مسودة)'}
                        </button>
                      ) : (
                        <span className="text-amber-400 text-xs font-bold">غير جاهز / not ready</span>
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
                    <div className="text-red-400 text-xs mt-2">{st.message}</div>
                  )}

                  {(f.errors.length > 0 || f.needs_review.length > 0 || f.validation_error || f.unknown_keys.length > 0 || f.warnings.length > 0) && (
                    <div className="mt-2 text-[11px] flex flex-col gap-1">
                      {f.errors.map((e, i) => (
                        <div key={`e-${i}`} className="text-red-400">سطر {e.line} — {e.key || '—'}: {e.message}</div>
                      ))}
                      {f.validation_error && <div className="text-red-400">{f.validation_error.message}</div>}
                      {f.needs_review.map((n, i) => (
                        <div key={`n-${i}`} className="text-amber-400">{n.key} «{n.value}»: {n.message}</div>
                      ))}
                      {f.unknown_keys.length > 0 && (
                        <div className="text-zinc-500">مفاتيح غير معروفة: {f.unknown_keys.join('، ')}</div>
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
        </div>
      )}
    </div>
  );
}
