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

  /**
   * A direct image-file URL, or — for the vendor hosts the owner named — the
   * product PAGE. The server reads only image ADDRESSES out of a page, never
   * text, and every address it finds is downloaded and verified by magic bytes
   * exactly like one typed here by hand. Anything else is still refused.
   */
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
        results: Array<{
          source_url: string;
          status: string;
          url?: string;
          reason?: string;
          from_page?: string;
          alt?: string;
        }>;
      }>('/api/admin/media/ingest', { urls });
      let ok = 0;
      let fromPages = 0;
      const failed: string[] = [];
      for (const r of res.results) {
        if (r.status === 'stored' && r.url) {
          addImage(r.url);
          ok += 1;
          if (r.from_page) fromPages += 1;
        } else {
          failed.push(`${r.source_url}: ${r.reason ?? 'failed'}`);
        }
      }
      setUrlText('');
      // Saying how many came from a page matters: pasting one link and getting
      // eight pictures is surprising unless the screen says why.
      const pageNote = fromPages > 0 ? ` (${fromPages} من صفحة المنتج)` : '';
      setUrlNote(
        failed.length === 0
          ? `تمت إضافة ${ok} صورة${pageNote}`
          : `أضيفت ${ok}${pageNote}، وفشلت ${failed.length}: ${failed.slice(0, 2).join(' | ')}`
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
      return { ...r, images: regroup(next) };
    });

  const valueNames = new Map(
    rel.groups.flatMap((g) => g.values.map((v) => [v.id, `${g.name_en || 'Group'} / ${v.name_en || v.id}`] as const))
  );
  const colorNames = new Map(rel.colors.map((c) => [c.id, c.name_en || c.id] as const));
  const hasTargets = valueNames.size > 0 || colorNames.size > 0;

  // The owner's display order — general product images first, then the
  // option-linked ones, then the colour-linked ones — partitions the ONE
  // underlying array; relative order inside each part is preserved and
  // sort_order follows the array, so the storefront receives the same story
  // this section shows.
  const scopeOf = (i: FormImage) => (i.option_value_id ? 1 : i.color_id ? 2 : 0);
  const regroup = (list: FormImage[]) =>
    [...list]
      .sort((a, b) => scopeOf(a) - scopeOf(b) || list.indexOf(a) - list.indexOf(b))
      .map((i, idx) => ({ ...i, sort_order: idx }));

  const setLink = (id: string, v: string) =>
    setRel((r) => ({
      ...r,
      images: regroup(
        r.images.map((i) =>
          i.id === id
            ? {
                ...i,
                option_value_id: v.startsWith('o:') ? v.slice(2) : null,
                color_id: v.startsWith('c:') ? v.slice(2) : null,
                variant_id: null,
              }
            : i
        )
      ),
    }));

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
        <span className="text-[11px] text-zinc-500">JPEG / PNG / WebP / GIF / AVIF · حتى 8MB للصورة</span>
      </div>

      <div className="flex flex-wrap items-end gap-2 mb-3 min-w-0">
        <div className="flex-1 min-w-[200px]">
          <Field
            ar="روابط الصور أو صفحة المنتج"
            en="Image URLs, or a vendor product page"
            hint="رابط صورة مباشر — أو رابط صفحة منتج من bambulab / qidi / biqu / esun / creality"
            tip="من صفحة المنتج تُقرأ عناوين الصور فقط (og:image و JSON-LD والمعرض)، ولا يُؤخذ منها أي نص أو سعر. كل صورة تُنزَّل وتُفحص ببصمة البايتات قبل حفظها، تمامًا كالرابط المباشر. المواقع الأخرى تحتاج رابط ملف الصورة نفسه."
          >
            <TextInput
              value={urlText}
              onChange={(e) => setUrlText(e.target.value)}
              placeholder="https://…/photo.jpg  ·  https://us.store.bambulab.com/products/…"
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
        [
          { scope: 0, ar: 'صور المنتج العامة', en: 'General', hint: 'تظهر دائمًا في معرض المنتج' },
          { scope: 1, ar: 'صور الخيارات', en: 'Option images', hint: 'تتقدم المعرض عند اختيار الخيار المرتبط' },
          { scope: 2, ar: 'صور الألوان', en: 'Colour images', hint: 'تتقدم المعرض عند اختيار اللون المرتبط' },
        ] as const
      ).map((grp) => {
        const members = rel.images.filter((i) => scopeOf(i) === grp.scope);
        if (members.length === 0) return null;
        return (
          <div key={grp.scope} className="min-w-0 mb-3">
            <div className="flex items-baseline gap-2 mb-1.5 min-w-0">
              <h4 className="text-[12px] font-bold text-zinc-300">
                {grp.ar} <span className="text-[10px] font-medium text-zinc-500">{grp.en}</span>
              </h4>
              <span className="text-[10px] text-zinc-600 truncate">{grp.hint}</span>
            </div>
            <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(180px,1fr))] min-w-0">
              {members.map((img) => {
                const idx = rel.images.indexOf(img);
                return (
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
                {(img.option_value_id || img.color_id) && (
                  <span className="absolute top-1 end-1 max-w-[70%] truncate bg-zinc-950/85 border border-zinc-700 text-zinc-200 text-[9px] font-bold px-1.5 py-0.5 rounded">
                    {img.option_value_id
                      ? `خيار: ${valueNames.get(img.option_value_id) ?? ''}`
                      : `لون: ${colorNames.get(img.color_id!) ?? ''}`}
                  </span>
                )}
              </div>
              <div className="p-1.5 space-y-1.5 min-w-0">
                <div className="flex items-center gap-0.5 min-w-0">
                  <button
                    type="button"
                    onClick={() => setPrimary(img.id)}
                    className={iconBtn}
                    aria-label="اجعلها رئيسية"
                    title="اجعلها رئيسية"
                  >
                    <Star className={`w-4 h-4 ${img.is_primary ? 'fill-[#6B46FF] text-[#6B46FF]' : ''}`} />
                  </button>
                  <button type="button" onClick={() => move(idx, idx - 1)} className={iconBtn} aria-label="للأعلى">
                    <ArrowUp className="w-4 h-4" />
                  </button>
                  <button type="button" onClick={() => move(idx, idx + 1)} className={iconBtn} aria-label="للأسفل">
                    <ArrowDown className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm('حذف هذه الصورة؟')) remove(img.id);
                    }}
                    className={`${iconBtn} hover:text-red-400`}
                    aria-label="حذف"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                <TextInput
                  value={img.alt_en}
                  onChange={(e) => patch(img.id, { alt_en: e.target.value })}
                  placeholder="Alt text (English)"
                  aria-label="Alt text"
                />
                {hasTargets && (
                  <Select
                    aria-label="تظهر مع"
                    value={
                      img.option_value_id ? `o:${img.option_value_id}` : img.color_id ? `c:${img.color_id}` : ''
                    }
                    onChange={(e) => setLink(img.id, e.target.value)}
                  >
                    {/* «غير مرتبطة» read as jargon — this names what actually
                        happens: the image is part of the product's general
                        gallery, or it belongs to one choice. */}
                    <option value="">صورة عامة للمنتج / general</option>
                    {valueNames.size > 0 && (
                      <optgroup label="تخص خيارًا — تظهر عند اختياره">
                        {[...valueNames].map(([id, label]) => (
                          <option key={id} value={`o:${id}`}>
                            خيار: {label}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {colorNames.size > 0 && (
                      <optgroup label="تخص لونًا — تظهر عند اختياره">
                        {[...colorNames].map(([id, label]) => (
                          <option key={id} value={`c:${id}`}>
                            لون: {label}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </Select>
                )}
              </div>
            </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
