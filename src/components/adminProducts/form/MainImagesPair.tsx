/**
 * «الصورة الرئيسية للوضع الداكن» و«الصورة الرئيسية للوضع الفاتح» — migration 0138.
 *
 * The owner: «اجعل للادمن في تفاصيل صفحة المنتج (تعديل / اضافة) خيار يمكن
 * وضع الصورة الرئيسية للوضع الداكن والصورة الرئيسية للوضع الفاتح».
 *
 * TWO SLOTS, ONE OF THEM ALREADY EXISTS. The dark-theme main image IS the
 * gallery's primary (★ in the grid below) — the picture every surface has
 * always shown — so its slot here is a preview that says where to change it,
 * not a second control over the same thing. The light-theme slot is new: it
 * uploads through the same product-media pipeline as the gallery
 * (`uploadFile(file, 'product')`: re-encoded to WebP, stored under the
 * product's folder) and is saved with the product as `light_image`. It is not
 * a gallery picture: it never appears as a thumbnail beside its dark twin.
 *
 * Each preview sits on the ground of the theme it is for, so the admin sees
 * the picture the way the shopper will: the dark one on charcoal, the light
 * one on the store's cream.
 *
 * Empty light slot = the storefront shows the dark main image in both themes,
 * which is what every product did before this field existed.
 */
import React, { useRef, useState } from 'react';
import { ImagePlus, RefreshCw, Trash2 } from 'lucide-react';
import { uploadFile, failureText } from '../../../lib/api';
import SafeImage from '../../ui/SafeImage';
import { btnGhost } from './formUi';

const ACCEPT = 'image/jpeg,image/png,image/webp';

/** The light theme's card and its ink (src/index.css `--color-surface`,
 *  `--color-text-secondary`, `--color-border-subtle` under
 *  `[data-theme='light']`), FIXED here: the preview shows the light theme
 *  whatever theme the admin panel itself is in. */
const LIGHT_PREVIEW = { background: '#f4efe5', borderColor: '#d9d1c2', color: '#45484e' } as const;

/** The storefront keeps only a processed, owned product image (`/files/….webp`). */
export function isStorableLightImage(url: string): boolean {
  return /^\/files\/[^?#]+\.webp$/i.test(url.trim());
}

export function MainImagesPair({
  darkUrl,
  lightUrl,
  onLightChange,
}: {
  /** The gallery primary's URL, '' when the gallery is empty. */
  darkUrl: string;
  lightUrl: string;
  onLightChange: (url: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setErr(null);
    setBusy(true);
    try {
      const res = await uploadFile(file, 'product');
      if (!isStorableLightImage(res.url)) {
        setErr('لم تُحفظ الصورة بصيغة WebP — ارفع JPEG أو PNG أو WebP / upload a JPEG, PNG or WebP');
        return;
      }
      onLightChange(res.url);
    } catch (e) {
      setErr(failureText(e, 'فشل الرفع / upload failed'));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div data-form="main-images" className="mb-4 grid gap-3 [grid-template-columns:minmax(0,1fr)] sm:[grid-template-columns:repeat(2,minmax(0,1fr))]">
      <figure className="min-w-0 rounded-xl border border-zinc-700 p-2.5">
        <figcaption className="mb-2 flex min-w-0 items-baseline justify-between gap-2">
          <span className="truncate text-[13px] font-bold text-white">الصورة الرئيسية للوضع الداكن</span>
          <span dir="ltr" className="shrink-0 text-[11px] text-zinc-500">Dark main image</span>
        </figcaption>
        <div className="aspect-[6/5] overflow-hidden rounded-lg bg-charcoal">
          {darkUrl ? (
            <SafeImage src={darkUrl} alt="" aspect="auto" fit="contain" className="h-full w-full" bgClassName="bg-charcoal" />
          ) : (
            <p className="grid h-full place-items-center px-3 text-center text-[12px] text-snow/60">لا صورة رئيسية بعد</p>
          )}
        </div>
        <p className="mt-2 text-[11.5px] leading-snug text-zinc-400">
          هي الصورة المحددة بـ ★ في معرض الصور أدناه — غيّرها من هناك.
        </p>
      </figure>

      <figure className="min-w-0 rounded-xl border border-zinc-700 p-2.5">
        <figcaption className="mb-2 flex min-w-0 items-baseline justify-between gap-2">
          <span className="truncate text-[13px] font-bold text-white">الصورة الرئيسية للوضع الفاتح</span>
          <span dir="ltr" className="shrink-0 text-[11px] text-zinc-500">Light main image</span>
        </figcaption>
        {/* The store's cream, fixed: this is a preview of the light theme
            whatever theme the admin panel itself is in. */}
        <div className="aspect-[6/5] overflow-hidden rounded-lg border" style={LIGHT_PREVIEW}>
          {lightUrl ? (
            <SafeImage src={lightUrl} alt="" aspect="auto" fit="contain" className="h-full w-full" bgClassName="bg-transparent" />
          ) : (
            <p className="grid h-full place-items-center px-3 text-center text-[12px]">
              اختيارية — بدونها تُعرض الصورة الداكنة في الوضعين
            </p>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          dir="ltr"
          accept={ACCEPT}
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(e) => void pick(e.target.files?.[0])}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-form="light-image-upload"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            className={btnGhost}
          >
            {busy ? <RefreshCw aria-hidden="true" className="h-4 w-4 animate-spin" /> : <ImagePlus aria-hidden="true" className="h-4 w-4" />}
            {lightUrl ? 'استبدال' : 'رفع صورة'}
          </button>
          {lightUrl ? (
            <button
              type="button"
              data-form="light-image-remove"
              disabled={busy}
              onClick={() => onLightChange('')}
              className={btnGhost}
            >
              <Trash2 aria-hidden="true" className="h-4 w-4" />
              إزالة
            </button>
          ) : null}
        </div>
        {err ? (
          <p role="alert" className="mt-2 text-[12px] leading-snug text-red-300">
            {err}
          </p>
        ) : null}
      </figure>
    </div>
  );
}
