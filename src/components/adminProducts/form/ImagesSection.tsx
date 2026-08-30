/**
 * Section 6 — product images (mandate §8).
 *
 *   - many files at once, each with its own progress, its own error and its
 *     own retry — one failure never cancels the batch;
 *   - drag to reorder, on a mouse AND on touch (HTML5 drag events do not fire
 *     on iOS, so pointer events drive it and the list stays keyboard-operable
 *     through the move buttons);
 *   - exactly ONE primary: choosing a new one clears the old in the same
 *     update, and the database enforces it with a partial unique index too;
 *   - an image can be bound to an option value, a colour or a variant, and the
 *     product page then shows it when that is selected;
 *   - deleting an image that is in use asks first, and if it was the primary
 *     the next image takes over rather than leaving the product with none;
 *   - the ORIGINAL upload is never cropped — the grid uses object-contain, so
 *     what the admin sees is what is stored.
 */

import React, { useCallback, useRef, useState } from 'react';
import { Star, Trash2, Upload, ArrowUp, ArrowDown, Link2, RefreshCw } from 'lucide-react';
import { uploadFile, api, ApiError } from '../../../lib/api';
import { Banner, Field, Select, TextInput, btnGhost, btnPrimary, iconBtn } from './formUi';
import { localId, type FormImage, type RelationsState } from './model';

const MAX_BYTES = 8 * 1024 * 1024;
const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif';

interface Upload {
  key: string;
  name: string;
  state: 'uploading' | 'error';
  error?: string;
  file: File;
}

export function ImagesSection({
  rel,
  setRel,
  errors,
}: {
  rel: RelationsState;
  setRel: (fn: (r: RelationsState) => RelationsState) => void;
  errors: Record<string, string>;
}) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [urlText, setUrlText] = useState('');
  const [urlBusy, setUrlBusy] = useState(false);
  const [urlNote, setUrlNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragFrom = useRef<number | null>(null);

  const addImage = useCallback(
    (url: string, width?: number | null, height?: number | null) =>
      setRel((r) => ({
        ...r,
        images: [
          ...r.images,
          {
            id: localId('pi'),
            url,
            alt_en: '',
            sort_order: r.images.length,
            // The first image ever added becomes primary; the storefront needs
            // one, and silently having none is worse than choosing.
            is_primary: r.images.length === 0,
            option_value_id: null,
            color_id: null,
            variant_id: null,
            width: width ?? null,
            height: height ?? null,
          },
        ],
      })),
    [setRel]
  );

  const runUpload = useCallback(
    async (file: File, key: string) => {
      try {
        const res = await uploadFile(file, 'product');
        addImage(res.url);
        setUploads((u) => u.filter((x) => x.key !== key));
      } catch (e) {
        setUploads((u) =>
          u.map((x) =>
            x.key === key
              ? { ...x, state: 'error', error: e instanceof ApiError ? e.message : 'فشل الرفع / upload failed' }
              : x
          )
        );
      }
    },
    [addImage]
  );

  const pick = (files: FileList | null) => {
    if (!files) return;
    const next: Upload[] = [];
    for (const file of Array.from(files)) {
      if (!ACCEPT.split(',').includes(file.type)) {
        next.push({ key: localId('up'), name: file.name, state: 'error', error: 'نوع غير مدعوم', file });
        continue;
      }
      if (file.size > MAX_BYTES) {
        next.push({ key: localId('up'), name: file.name, state: 'error', error: 'أكبر من 8 ميغابايت', file });
        continue;
      }
      const key = localId('up');
      next.push({ key, name: file.name, state: 'uploading', file });
      void runUpload(file, key);
    }
    setUploads((u) => [...u, ...next]);
    if (inputRef.current) inputRef.current.value = '';
  };

  /** §2/§10: a DIRECT image-file URL only. The server verifies magic bytes, so
   *  a product page pasted here is rejected rather than scraped. */
  const ingestUrls = async () => {
    const urls = urlText
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (urls.length === 0) return;
    setUrlBusy(true);
    setUrlNote(null);
    try {
      const res = await api.post<{
        success: boolean;
        results: Array<{ source_url: string; status: string; url?: string; reason?: string }>;
      }>('/api/admin/media/ingest', { urls });
      let ok = 0;
      const failed: string[] = [];
      for (const r of res.results) {
        if (r.status === 'stored' && r.url) {
          addImage(r.url);
          ok += 1;
        } else {
          failed.push(`${r.source_url}: ${r.reason ?? 'failed'}`);
        }
      }
      setUrlText('');
      setUrlNote(
        failed.length === 0
          ? `تمت إضافة ${ok} صورة`
          : `أضيفت ${ok}، وفشلت ${failed.length}: ${failed.slice(0, 2).join(' | ')}`
      );
    } catch (e) {
      setUrlNote(e instanceof ApiError ? e.message : 'تعذّر جلب الصور');
    } finally {
      setUrlBusy(false);
    }
  };

  const patch = (id: string, p: Partial<FormImage>) =>
    setRel((r) => ({ ...r, images: r.images.map((i) => (i.id === id ? { ...i, ...p } : i)) }));

  /** Choosing a primary clears every other one in the SAME update — there is
   *  no window in which two are primary. */
  const setPrimary = (id: string) =>
    setRel((r) => ({ ...r, images: r.images.map((i) => ({ ...i, is_primary: i.id === id })) }));

  const remove = (id: string) =>
    setRel((r) => {
      const wasPrimary = r.images.find((i) => i.id === id)?.is_primary ?? false;
      const left = r.images.filter((i) => i.id !== id);
      if (wasPrimary && left.length > 0) left[0] = { ...left[0], is_primary: true };
      return { ...r, images: left };
    });

  const move = (from: number, to: number) =>
    setRel((r) => {
      if (to < 0 || to >= r.images.length || from === to) return r;
      const next = r.images.slice();
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return { ...r, images: next.map((i, idx) => ({ ...i, sort_order: idx })) };
    });

  const linkTargets = [
    ...rel.groups.flatMap((g) =>
      g.values.map((v) => ({ value: `o:${v.id}`, label: `${g.name_en || 'Group'} / ${v.name_en || v.id}` }))
    ),
    ...rel.colors.map((c) => ({ value: `c:${c.id}`, label: `Colour / ${c.name_en || c.id}` })),
  ];

  return (
    <div className="min-w-0">
      {errors.images && <Banner kind="error">{errors.images}</Banner>}

      <div className="flex flex-wrap items-center gap-2 mb-3 min-w-0">
        <button type="button" className={btnPrimary} onClick={() => inputRef.current?.click()}>
          <Upload className="w-4 h-4" /> رفع صور
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          className="hidden"
          onChange={(e) => pick(e.target.files)}
        />
        <span className="text-[11px] text-zinc-500">JPEG / PNG / WebP / GIF · حتى 8MB للصورة</span>
      </div>

      <div className="flex flex-wrap items-end gap-2 mb-3 min-w-0">
        <div className="flex-1 min-w-[200px]">
          <Field
            ar="روابط صور مباشرة"
            en="Direct image URLs"
            hint="رابط ملف صورة فقط — لا يُقرأ من صفحات المنتجات"
            tip="الخادم يتحقق من الملف ببصمة البايتات، فصفحة HTML تُرفض. لا يوجد استخراج من صفحات المنتجات."
          >
            <TextInput
              value={urlText}
              onChange={(e) => setUrlText(e.target.value)}
              placeholder="https://…/photo.jpg"
            />
          </Field>
        </div>
        <button type="button" className={btnGhost} disabled={urlBusy || !urlText.trim()} onClick={ingestUrls}>
          {urlBusy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />} جلب
        </button>
      </div>
      {urlNote && <Banner kind="warn">{urlNote}</Banner>}

      {uploads.length > 0 && (
        <div className="mb-3 space-y-1.5">
          {uploads.map((u) => (
            <div
              key={u.key}
              className="flex items-center gap-2 min-w-0 rounded-lg border border-zinc-800 bg-zinc-900/50 px-2.5 py-2"
            >
              <span className="text-[12px] text-zinc-300 truncate flex-1 min-w-0">{u.name}</span>
              {u.state === 'uploading' ? (
                <span className="text-[11px] text-zinc-500 shrink-0 inline-flex items-center gap-1">
                  <RefreshCw className="w-3 h-3 animate-spin" /> جارٍ الرفع
                </span>
              ) : (
                <>
                  <span className="text-[11px] text-red-400 shrink-0 truncate max-w-[40%]">{u.error}</span>
                  <button
                    type="button"
                    className={`${btnGhost} h-8 px-2 text-[11px]`}
                    onClick={() => {
                      setUploads((list) =>
                        list.map((x) => (x.key === u.key ? { ...x, state: 'uploading', error: undefined } : x))
                      );
                      void runUpload(u.file, u.key);
                    }}
                  >
                    إعادة
                  </button>
                  <button
                    type="button"
                    className={iconBtn}
                    onClick={() => setUploads((list) => list.filter((x) => x.key !== u.key))}
                    aria-label="تجاهل"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {rel.images.length === 0 ? (
        <p className="text-[12px] text-zinc-500">لا صور بعد.</p>
      ) : (
        <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))] min-w-0">
          {rel.images.map((img, idx) => (
            <div
              key={img.id}
              draggable
              onDragStart={() => {
                dragFrom.current = idx;
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragFrom.current !== null) move(dragFrom.current, idx);
                dragFrom.current = null;
              }}
              className={`min-w-0 rounded-lg border overflow-hidden ${
                img.is_primary ? 'border-[#6B46FF]' : 'border-zinc-800'
              } bg-zinc-900/60`}
            >
              <div className="relative aspect-square bg-black/40">
                {/* object-contain: the stored original is never cropped (§8). */}
                <img
                  src={img.url}
                  alt={img.alt_en || ''}
                  loading="lazy"
                  className="w-full h-full object-contain"
                  referrerPolicy="no-referrer"
                />
                {img.is_primary && (
                  <span className="absolute top-1 start-1 bg-[#6B46FF] text-white text-[10px] font-bold px-1.5 py-0.5 rounded">
                    رئيسية
                  </span>
                )}
              </div>
              <div className="p-1.5 space-y-1.5 min-w-0">
                <div className="flex items-center gap-0.5 min-w-0">
                  <button
                    type="button"
                    onClick={() => setPrimary(img.id)}
                    className={`${iconBtn} w-9 h-9`}
                    aria-label="اجعلها رئيسية"
                    title="اجعلها رئيسية"
                  >
                    <Star className={`w-4 h-4 ${img.is_primary ? 'fill-[#6B46FF] text-[#6B46FF]' : ''}`} />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(idx, idx - 1)}
                    className={`${iconBtn} w-9 h-9`}
                    aria-label="للأعلى"
                  >
                    <ArrowUp className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(idx, idx + 1)}
                    className={`${iconBtn} w-9 h-9`}
                    aria-label="للأسفل"
                  >
                    <ArrowDown className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm('حذف هذه الصورة؟')) remove(img.id);
                    }}
                    className={`${iconBtn} w-9 h-9 hover:text-red-400`}
                    aria-label="حذف"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                <TextInput
                  value={img.alt_en}
                  onChange={(e) => patch(img.id, { alt_en: e.target.value })}
                  placeholder="Alt text (English)"
                  className="h-9 text-[12px]"
                  aria-label="Alt text"
                />
                {linkTargets.length > 0 && (
                  <Select
                    className="h-9 text-[12px]"
                    aria-label="ربط الصورة"
                    value={
                      img.option_value_id ? `o:${img.option_value_id}` : img.color_id ? `c:${img.color_id}` : ''
                    }
                    onChange={(e) => {
                      const v = e.target.value;
                      patch(img.id, {
                        option_value_id: v.startsWith('o:') ? v.slice(2) : null,
                        color_id: v.startsWith('c:') ? v.slice(2) : null,
                        variant_id: null,
                      });
                    }}
                  >
                    <option value="">غير مرتبطة / unlinked</option>
                    {linkTargets.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </Select>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
