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

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Star, Trash2, Upload, ArrowUp, ArrowDown, Link2, RefreshCw, AlertTriangle } from 'lucide-react';
import { uploadFile, api, failureText } from '../../../lib/api';
import { Banner, Field, Select, TextInput, btnGhost, btnPrimary, iconBtn } from './formUi';
import { localId, type FormImage, type FormQuarantinedImage, type RelationsState } from './model';
import SafeImage from '../../ui/SafeImage';
import { classifyImageUrl, primaryRepair } from '../../../lib/imageUrl';
import { splitUrlList } from '../../../../worker/lib/urlList';
import { PRODUCT_IMAGE_MAX_BYTES, PRODUCT_IMAGE_MAX_SOURCE_BYTES } from '../../../lib/imagePreprocess';

/**
 * WHAT THE PICKER MAY HAND OVER.
 *
 * AVIF was named in the hint under the button and in the server's own sniffer,
 * but not here — so the one format modern vendor CDNs serve by default was
 * refused by the file dialog as «نوع غير مدعوم».
 *
 * The size gate is split for the same reason `prepareProductImage` splits it: a
 * PNG or a JPEG is re-encoded to WebP before anything is sent, so measuring the
 * picked file against the upload ceiling refuses files that would have arrived
 * at a fraction of their size. Formats that travel untouched keep the real one.
 */
const CONVERTED_TYPES = ['image/jpeg', 'image/png'];
const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/avif';

interface Upload {
  key: string;
  name: string;
  state: 'uploading' | 'error';
  error?: string;
  file: File;
}

interface StoredImageAsset {
  url: string;
  key?: string;
  source_url?: string;
  alt?: string;
  width?: number | null;
  height?: number | null;
  bytes?: number | null;
  content_type?: string;
}

interface IngestResult extends Omit<StoredImageAsset, 'url'> {
  source_url: string;
  status: string;
  url?: string;
  reason?: string;
  from_page?: string;
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
  const [replaceBusy, setReplaceBusy] = useState<string | null>(null);
  const [urlNote, setUrlNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragFrom = useRef<number | null>(null);

  /**
   * WHICH PICTURES ACTUALLY LOADED. Two sets, not one tri-state, because "has
   * not loaded" and "failed" are different facts: images are lazy, so an image
   * far down the grid has reported nothing at all and must never be offered as
   * the healthy replacement for a broken primary.
   *
   * Nothing here is saved. It is the browser's report on what a customer would
   * see, held for the length of this editing session only.
   */
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(() => new Set());
  /** The id whose URL is being replaced by hand, and the text being typed. */
  const [editingUrl, setEditingUrl] = useState<{ id: string; text: string } | null>(null);

  const noteStatus = useCallback((id: string, status: 'loading' | 'loaded' | 'error') => {
    const add = (set: ReadonlySet<string>, keep: boolean) => {
      const has = set.has(id);
      if (has === keep) return set;
      const next = new Set(set);
      if (keep) next.add(id);
      else next.delete(id);
      return next;
    };
    setFailed((f) => add(f, status === 'error'));
    setLoaded((l) => add(l, status === 'loaded'));
  }, []);

  const addImage = useCallback(
    (url: string, extra?: Omit<StoredImageAsset, 'url'>) =>
      setRel((r) => ({
        ...r,
        images: [
          ...r.images,
          {
            id: localId('pi'),
            url,
            // Alt text the vendor page carried, and the address it came from.
            // Dropping the source meant the column 0048 added for exactly this
            // was never filled by the flow that motivated it.
            alt_en: extra?.alt ?? '',
            source_url: extra?.source_url ?? '',
            sort_order: r.images.length,
            // The first image ever added becomes primary; the storefront needs
            // one, and silently having none is worse than choosing.
            is_primary: r.images.length === 0,
            option_value_id: null,
            color_id: null,
            variant_id: null,
            width: extra?.width ?? null,
            height: extra?.height ?? null,
            bytes: extra?.bytes ?? null,
            content_type: extra?.content_type ?? '',
            r2_key: extra?.key ?? '',
          },
        ],
      })),
    [setRel]
  );

  const runUpload = useCallback(
    async (file: File, key: string) => {
      try {
        const res = await uploadFile(file, 'product');
        addImage(res.url, {
          width: res.width,
          height: res.height,
          bytes: res.bytes,
          content_type: res.mime,
          key: res.key,
        });
        setUploads((u) => u.filter((x) => x.key !== key));
      } catch (e) {
        // The REASON, never the category — see `failureText`. Everything that
        // can fail before the request (decode, WebP encode, the size guards)
        // throws a plain Error, and that was the branch being discarded.
        const error = failureText(e, 'فشل الرفع / upload failed');
        setUploads((u) => u.map((x) => (x.key === key ? { ...x, state: 'error', error } : x)));
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
      const ceiling = CONVERTED_TYPES.includes(file.type)
        ? PRODUCT_IMAGE_MAX_SOURCE_BYTES
        : PRODUCT_IMAGE_MAX_BYTES;
      if (file.size > ceiling) {
        next.push({
          key: localId('up'),
          name: file.name,
          state: 'error',
          error: `${(file.size / 1024 / 1024).toFixed(1)}MB — الحد ${Math.round(ceiling / 1024 / 1024)}MB`,
          file,
        });
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
    // THE SAME SPLITTER THE TXT TEMPLATE USES. Splitting on every comma broke
    // exactly one thing here: a Cloudinary transform
    // (`/upload/w_800,h_600,c_fill/a1.jpg`) became one truncated URL plus two
    // bogus refusals shown to the admin.
    const typed = splitUrlList(urlText);
    if (typed.length === 0) return;

    // A STRING IS NOT AN ADDRESS. Refused here, by name, so «صورة» or a
    // Windows path is answered immediately instead of travelling to the server
    // to come back as a generic failure. This checks only what the admin has
    // JUST typed — it is never a reason to refuse saving a product whose
    // stored images were written long ago.
    const bad = typed
      .map((u) => ({ u, verdict: classifyImageUrl(u) }))
      .filter((x) => !x.verdict.ok || x.verdict.kind !== 'absolute');
    const urls = typed.filter((u) => !bad.some((b) => b.u === u));
    if (urls.length === 0) {
      setUrlNote(
        bad.length === 1
          ? `${bad[0].u}: ${bad[0].verdict.reason ?? 'يلزم رابط كامل يبدأ بـ https://'}`
          : `${bad.length} روابط غير صالحة — يلزم رابط كامل يبدأ بـ https://`
      );
      return;
    }
    setUrlBusy(true);
    setUrlNote(null);
    try {
      const res = await api.post<{ success: boolean; results: IngestResult[] }>(
        '/api/admin/media/ingest',
        { urls }
      );
      let ok = 0;
      let fromPages = 0;
      // NOT named `failed`: that is the set of image ids whose <img> broke, and
      // shadowing it here is how a rename becomes a silent bug.
      const rejected: string[] = [];
      for (const r of res.results) {
        if (r.status === 'stored' && r.url) {
          addImage(r.url, {
            alt: r.alt,
            source_url: r.source_url,
            key: r.key,
            width: r.width,
            height: r.height,
            bytes: r.bytes,
            content_type: r.content_type,
          });
          ok += 1;
          if (r.from_page) fromPages += 1;
        } else {
          rejected.push(`${r.source_url}: ${r.reason ?? 'failed'}`);
        }
      }
      setUrlText('');
      // Saying how many came from a page matters: pasting one link and getting
      // eight pictures is surprising unless the screen says why.
      const pageNote = fromPages > 0 ? ` (${fromPages} من صفحة المنتج)` : '';
      // The ones refused before sending are counted too — silently dropping
      // them would make «أضيفت 2» look like the whole answer to a paste of 3.
      const refused = [...rejected, ...bad.map((b) => `${b.u}: ${b.verdict.reason ?? 'رابط غير صالح'}`)];
      setUrlNote(
        refused.length === 0
          ? `تمت إضافة ${ok} صورة${pageNote}`
          : `أضيفت ${ok}${pageNote}، وفشلت ${refused.length}: ${refused.slice(0, 2).join(' | ')}`
      );
    } catch (e) {
      setUrlNote(failureText(e, 'تعذّر جلب الصور'));
    } finally {
      setUrlBusy(false);
    }
  };

  const patch = (id: string, p: Partial<FormImage>) =>
    setRel((r) => ({ ...r, images: r.images.map((i) => (i.id === id ? { ...i, ...p } : i)) }));

  /**
   * A pasted address never becomes a hotlink in product_images. The server
   * fetches, verifies and stores it first; the form then swaps every piece of
   * canonical storage metadata as one update.
   */
  const replaceFromExternalUrl = async (img: FormImage, raw: string) => {
    const source = raw.trim();
    const verdict = classifyImageUrl(source);
    if (!verdict.ok || verdict.kind !== 'absolute') {
      setUrlNote(verdict.reason ?? 'يلزم رابط كامل يبدأ بـ https://');
      return;
    }
    setReplaceBusy(img.id);
    setUrlNote(null);
    try {
      const res = await api.post<{ success: boolean; results: IngestResult[] }>(
        '/api/admin/media/ingest',
        { urls: [source] }
      );
      const stored = res.results.find((result) => result.status === 'stored' && result.url);
      if (!stored?.url) {
        throw new Error(res.results[0]?.reason ?? 'تعذّر جلب الصورة');
      }
      patch(img.id, {
        url: stored.url,
        r2_key: stored.key ?? '',
        source_url: stored.source_url,
        width: stored.width ?? null,
        height: stored.height ?? null,
        bytes: stored.bytes ?? null,
        content_type: stored.content_type ?? '',
        ...(stored.alt ? { alt_en: stored.alt } : {}),
      });
      noteStatus(img.id, 'loading');
      setEditingUrl(null);
    } catch (error) {
      setUrlNote(failureText(error, 'تعذّر جلب الصورة'));
    } finally {
      setReplaceBusy(null);
    }
  };

  /**
   * A migration quarantine is provenance, not a broken gallery card. Repair
   * fetches the stored source through the same SSRF/byte-sniff/WebP ingest as
   * a newly pasted URL, then reuses the quarantine id. The atomic product
   * upsert clears its quarantine bit only after the verified local object is
   * ready; until Save, the database provenance remains untouched.
   */
  const repairQuarantine = async (quarantine: FormQuarantinedImage) => {
    const source = quarantine.source_url.trim();
    const verdict = classifyImageUrl(source);
    if (!verdict.ok || verdict.kind !== 'absolute') {
      setUrlNote('هذا المصدر ليس رابط HTTPS قابلاً للجلب. ارفع الملف الأصلي يدويًا ثم احفظ.');
      return;
    }
    setReplaceBusy(quarantine.id);
    setUrlNote(null);
    try {
      const res = await api.post<{ success: boolean; results: IngestResult[] }>(
        '/api/admin/media/ingest',
        { urls: [source] }
      );
      const stored = res.results.find((result) => result.status === 'stored' && result.url);
      if (!stored?.url) throw new Error(res.results[0]?.reason ?? 'تعذّر جلب الصورة');
      setRel((state) => ({
        ...state,
        quarantined_images: (state.quarantined_images ?? []).filter((item) => item.id !== quarantine.id),
        images: [
          ...state.images,
          {
            id: quarantine.id,
            url: stored.url!,
            r2_key: stored.key ?? '',
            source_url: stored.source_url || source,
            alt_en: stored.alt || quarantine.alt_en,
            sort_order: state.images.length,
            is_primary: state.images.length === 0,
            option_value_id: quarantine.option_value_id,
            color_id: quarantine.color_id,
            variant_id: quarantine.variant_id,
            width: stored.width ?? null,
            height: stored.height ?? null,
            bytes: stored.bytes ?? null,
            content_type: stored.content_type ?? '',
          },
        ],
      }));
      setUrlNote('تم جلب المصدر وتحويله إلى WebP محلي. احفظ المنتج لإتمام الإصلاح.');
    } catch (error) {
      setUrlNote(failureText(error, 'تعذّر إصلاح الصورة المعزولة'));
    } finally {
      setReplaceBusy(null);
    }
  };

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
  const variantNames = new Map(
    rel.variants.map((variant) => {
      const parts = variant.option_value_ids.map((id) => valueNames.get(id) ?? id);
      if (variant.color_id) parts.push(`Colour / ${colorNames.get(variant.color_id) ?? variant.color_id}`);
      return [variant.id, parts.join(' + ') || variant.sku || variant.id] as const;
    })
  );
  const hasTargets = valueNames.size > 0 || colorNames.size > 0 || variantNames.size > 0;

  // The owner's display order — general product images first, then the
  // option-linked ones, then the colour-linked ones — partitions the ONE
  // underlying array; relative order inside each part is preserved and
  // sort_order follows the array, so the storefront receives the same story
  // this section shows.
  const scopeOf = (i: FormImage) => (i.option_value_id ? 1 : i.color_id ? 2 : i.variant_id ? 3 : 0);
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
                variant_id: v.startsWith('v:') ? v.slice(2) : null,
              }
            : i
        )
      ),
    }));

  /**
   * THE PRIMARY IS WHAT THE STOREFRONT LEADS WITH. If it stops loading while a
   * healthy picture sits beside it, every customer sees a broken box on the
   * product page and nobody in the admin sees anything at all.
   *
   * This NAMES that state and offers the one-click fix; it does not perform it.
   * Silently moving the star on load would mean an admin opens a product,
   * touches nothing, and leaves with unsaved changes — and a save nobody asked
   * for is worse than a warning nobody missed.
   */
  const repair = useMemo(() => primaryRepair(rel.images, failed, loaded), [rel.images, failed, loaded]);

  return (
    <div className="min-w-0">
      {errors.images && <Banner kind="error">{errors.images}</Banner>}

      {(rel.quarantined_images?.length ?? 0) > 0 && (
        <div className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 space-y-2" data-image-quarantine>
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-400 shrink-0" aria-hidden="true" />
            <p className="text-[11px] text-amber-100 leading-snug">
              صور قديمة معزولة لا تظهر للزبائن. بقي رابط المصدر محفوظًا؛ أعد جلبه ثم احفظ لتفعيل WebP محلي آمن.
              <span className="text-zinc-500"> Quarantined legacy media is provenance only.</span>
            </p>
          </div>
          {(rel.quarantined_images ?? []).map((image) => (
            <div key={image.id} className="flex flex-wrap items-center gap-2 rounded border border-zinc-800 bg-black/20 px-2 py-1.5">
              <code dir="ltr" className="min-w-0 flex-1 truncate text-[10px] text-zinc-400" title={image.source_url}>
                {image.source_url}
              </code>
              <span className="text-[9px] text-zinc-600">{image.quarantine_reason}</span>
              <button
                type="button"
                className={`${btnGhost} h-8 px-2 text-[11px]`}
                disabled={replaceBusy === image.id}
                onClick={() => void repairQuarantine(image)}
              >
                {replaceBusy === image.id ? <RefreshCw className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                إعادة جلب
              </button>
            </div>
          ))}
        </div>
      )}

      {repair.needed && (
        <div
          className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2.5 flex flex-wrap items-center gap-2"
          data-image-primary-broken
        >
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
          <p className="text-[11px] text-amber-200 flex-1 min-w-[200px] leading-snug">
            الصورة الرئيسية لا تُحمَّل — وهذا ما سيراه الزبون في صفحة المنتج. توجد صورة أخرى تعمل.
            <span className="text-zinc-500"> The primary image is not loading.</span>
          </p>
          <button
            type="button"
            className={btnPrimary}
            onClick={() => repair.healthyId && setPrimary(repair.healthyId)}
          >
            <Star className="w-3 h-3" /> اجعل الصورة السليمة رئيسية
          </button>
        </div>
      )}

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
        <span className="text-[11px] text-zinc-500">JPEG / PNG / WebP / GIF / AVIF · تُحوَّل تلقائيًا إلى WebP</span>
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
          { scope: 3, ar: 'صور التركيبات', en: 'Variant images', hint: 'الأعلى أولوية عند اكتمال الخيار واللون' },
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
                img.is_primary ? 'border-iris' : 'border-zinc-800'
              } bg-zinc-900/60`}
            >
              <div className="relative aspect-square bg-black/40">
                {/*
                  SafeImage, not a bare <img>: a picture whose host stops
                  answering must SAY so and offer a retry, instead of showing
                  the browser's broken-file glyph and leaving the admin to
                  guess whether the record is wrong or the network is. It also
                  reports what it saw, which is what lets the banner above
                  notice a broken PRIMARY. object-contain keeps §8's promise
                  that the stored original is never cropped.
                */}
                <SafeImage
                  src={img.url}
                  alt={img.alt_en || ''}
                  aspect="auto"
                  fit="contain"
                  className="w-full h-full"
                  bgClassName="bg-transparent"
                  fallbackClassName="text-zinc-500 gap-1"
                  onStatus={(st) => noteStatus(img.id, st)}
                />
                {img.is_primary && (
                  <span className="absolute top-1 start-1 bg-[#6B46FF] text-snow text-[10px] font-bold px-1.5 py-0.5 rounded">
                    رئيسية
                  </span>
                )}
                {(img.option_value_id || img.color_id || img.variant_id) && (
                  <span className="absolute top-1 end-1 max-w-[70%] truncate bg-zinc-950/85 border border-zinc-700 text-zinc-200 text-[9px] font-bold px-1.5 py-0.5 rounded">
                    {img.option_value_id
                      ? `خيار: ${valueNames.get(img.option_value_id) ?? ''}`
                      : img.color_id
                        ? `لون: ${colorNames.get(img.color_id) ?? ''}`
                        : `تركيبة: ${variantNames.get(img.variant_id!) ?? ''}`}
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
                    <Star className={`w-4 h-4 ${img.is_primary ? 'fill-iris text-iris' : ''}`} />
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
                {/*
                  THE ADDRESS, AND HOW TO CHANGE IT. A hotlink that stops
                  working is not a reason to delete the record — the alt text,
                  the option link and the sort order are all still right, and
                  only the address is wrong. So a failed image offers to
                  REPLACE its URL, and deleting stays the explicit, confirmed
                  action it already was.
                */}
                {failed.has(img.id) && (
                  <div className="rounded border border-amber-500/40 bg-amber-500/5 p-1.5 space-y-1" data-image-failed={img.id}>
                    <p className="text-[10px] text-amber-300 leading-snug">
                      تعذّر تحميل هذه الصورة. قد يكون المضيف يمنع الروابط الخارجية مؤقتًا — لا تُحذف تلقائيًا.
                    </p>
                    <p className="text-[9px] text-zinc-500 break-all" dir="ltr" title={img.url}>
                      {img.url}
                    </p>
                    {editingUrl?.id === img.id ? (
                      <div className="space-y-1">
                        <TextInput
                          value={editingUrl.text}
                          dir="ltr"
                          onChange={(e) => setEditingUrl({ id: img.id, text: e.target.value })}
                          placeholder="https://…"
                          aria-label="رابط بديل"
                        />
                        {(() => {
                          const verdict = classifyImageUrl(editingUrl.text);
                          return (
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                className={btnPrimary}
                                disabled={!verdict.ok || verdict.kind !== 'absolute' || replaceBusy === img.id}
                                onClick={() => {
                                  const next = editingUrl.text.trim();
                                  if (next !== img.url) {
                                    void replaceFromExternalUrl(img, next);
                                  } else {
                                    setEditingUrl(null);
                                  }
                                }}
                              >
                                {replaceBusy === img.id ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : null}
                                استبدال عبر الحفظ
                              </button>
                              <button type="button" className={btnGhost} onClick={() => setEditingUrl(null)}>
                                إلغاء
                              </button>
                              {(!verdict.ok || verdict.kind !== 'absolute') && editingUrl.text.trim() !== '' && (
                                <span className="text-[9px] text-red-400 truncate">
                                  {verdict.kind === 'absolute' ? verdict.reason : 'ألصق رابطًا خارجيًا كاملًا ليُحفَظ أولًا'}
                                </span>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    ) : (
                      <button
                        type="button"
                        className={btnGhost}
                        data-image-replace-url={img.id}
                        onClick={() => setEditingUrl({ id: img.id, text: img.url })}
                      >
                        <Link2 className="w-3 h-3" /> استبدال الرابط
                      </button>
                    )}
                  </div>
                )}
                <TextInput
                  value={img.alt_en}
                  onChange={(e) => patch(img.id, { alt_en: e.target.value })}
                  placeholder="Alt text (English)"
                  aria-label="Alt text"
                />
                {/* Alt text a TXT template authored in Arabic or Kurdish. The
                    form is English-only, so it is SHOWN rather than edited —
                    it is stored, it is carried by the next save, and hiding it
                    was one of the losses this round removes. */}
                {(img.alt_ar || img.alt_ckb) && (
                  <p
                    className="text-[10px] text-zinc-500 truncate"
                    dir="auto"
                    data-form="image-imported-alt"
                    title="نص بديل محفوظ من القالب النصي"
                  >
                    {[img.alt_ar, img.alt_ckb].filter(Boolean).join(' · ')}
                  </p>
                )}
                {hasTargets && (
                  <Select
                    aria-label="تظهر مع"
                    value={
                      img.option_value_id
                        ? `o:${img.option_value_id}`
                        : img.color_id
                          ? `c:${img.color_id}`
                          : img.variant_id
                            ? `v:${img.variant_id}`
                            : ''
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
                    {variantNames.size > 0 && (
                      <optgroup label="تخص تركيبة كاملة — الخيار واللون معًا">
                        {[...variantNames].map(([id, label]) => (
                          <option key={id} value={`v:${id}`}>
                            تركيبة: {label}
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
