/**
 * Picking, previewing, replacing and removing an image — one implementation,
 * used by the store logo, the store banner and merchant product pictures.
 *
 * There is one of these rather than three because the mistakes are the same
 * every time and only worth making once: a control that uploads with no
 * feedback, a file the server will reject that the browser accepted happily,
 * a "remove" that clears a preview without changing what is saved, and an
 * upload that silently replaces the image the merchant meant to keep.
 *
 * WHAT THE CLIENT CHECKS AND WHY IT IS NOT THE CHECK. Type and size are
 * validated here so a merchant who picks a 30 MB screenshot is told
 * immediately instead of waiting for an upload to fail. The SERVER sniffs the
 * bytes and refuses anything it does not recognise (worker/routes/uploads.ts)
 * — this is a courtesy, not a gate, and it is deliberately a little stricter
 * than the server so the two can never disagree in the direction that
 * matters.
 *
 * WHAT "SAVED" MEANS. `onChange` fires with the uploaded URL, and the parent
 * writes it to the record. The preview shown is always the value the parent
 * holds, never a local object URL, so a picture on screen is a picture the
 * server has — there is no state in which the merchant sees their new logo
 * and the shop does not have it.
 */

import { useRef, useState } from 'react';
import { Loader2, ImagePlus, Trash2, RefreshCw } from 'lucide-react';
import { ApiError, uploadFile } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';

/** Kept in step with the server's sniffer. */
const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif';
const MAX_BYTES = 8 * 1024 * 1024;

export type ImagePickerShape = 'square' | 'wide' | 'tile';

export function ImagePicker({
  value,
  onChange,
  shape = 'square',
  label,
  hint,
  disabled,
}: {
  /** The saved URL, or null. The preview is this and nothing else. */
  value: string | null;
  onChange: (url: string | null) => void;
  shape?: ImagePickerShape;
  label?: string;
  hint?: string;
  disabled?: boolean;
}) {
  const { loc } = useLanguage();
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function pick(file: File | null | undefined) {
    if (!file) return;
    setError('');

    if (!ACCEPT.split(',').includes(file.type)) {
      setError(loc(
        'اختر صورة JPEG أو PNG أو WebP أو GIF.',
        'Choose a JPEG, PNG, WebP or GIF image.',
        'وێنەیەکی JPEG یان PNG یان WebP یان GIF هەڵبژێرە.'
      ));
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(loc(
        `الصورة أكبر من ${MAX_BYTES / 1024 / 1024} ميغابايت.`,
        `That image is larger than ${MAX_BYTES / 1024 / 1024} MB.`,
        `وێنەکە لە ${MAX_BYTES / 1024 / 1024} MB گەورەترە.`
      ));
      return;
    }

    setBusy(true);
    try {
      const { url } = await uploadFile(file, 'community');
      onChange(url);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : loc(
        'تعذّر رفع الصورة.', 'Could not upload the image.', 'نەتوانرا وێنەکە باربکرێت.'
      ));
    } finally {
      setBusy(false);
      // Clear the input so choosing the SAME file again still fires a change
      // — otherwise a failed upload cannot be retried without picking
      // something else first.
      if (input.current) input.current.value = '';
    }
  }

  const box =
    shape === 'wide' ? 'aspect-[3/1] w-full max-w-xl'
      : shape === 'tile' ? 'w-20 h-20'
        : 'w-24 h-24';

  return (
    <div>
      {label && (
        <label className="block text-zinc-400 text-[12.5px] font-semibold mb-2">{label}</label>
      )}

      {/* A wide picture takes the whole row, so its buttons go under it —
          beside it they were squeezed to nothing and pushed off the screen. */}
      <div className={`flex gap-3 ${shape === 'wide' ? 'flex-col' : 'items-start'}`}>
        <div className={`${box} rounded-2xl bg-black/40 border border-white/10 overflow-hidden shrink-0 relative`}>
          {value ? (
            <img src={value} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <ImagePlus className="w-5 h-5 text-zinc-600" />
            </div>
          )}
          {busy && (
            <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
              <Loader2 className="w-4 h-4 text-gold animate-spin" />
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => input.current?.click()}
              disabled={busy || disabled}
              className="relative lv-hit min-h-[36px] px-3 rounded-xl border border-white/10 bg-white/[0.03] text-zinc-300 text-[12px] font-semibold flex items-center gap-1.5 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              {value ? <RefreshCw className="w-3.5 h-3.5" /> : <ImagePlus className="w-3.5 h-3.5" />}
              {value
                ? loc('استبدال', 'Replace', 'گۆڕین')
                : loc('اختر صورة', 'Choose image', 'وێنە هەڵبژێرە')}
            </button>
            {value && (
              <button
                type="button"
                onClick={() => { setError(''); onChange(null); }}
                disabled={busy || disabled}
                className="min-h-[36px] px-3 rounded-xl border border-red-500/30 bg-red-500/10 text-red-300 text-[12px] font-semibold flex items-center gap-1.5 disabled:opacity-40"
              >
                <Trash2 className="w-3.5 h-3.5" />
                {loc('إزالة', 'Remove', 'لابردن')}
              </button>
            )}
          </div>
          {hint && !error && <p className="text-text-muted text-[11px] mt-2">{hint}</p>}
          {error && <p className="text-red-400 text-[11.5px] mt-2">{error}</p>}
        </div>
      </div>

      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => pick(e.target.files?.[0])}
      />
    </div>
  );
}

/**
 * A gallery of the same thing. Add, replace one, remove one, reorder by
 * promoting to first — because the first image is the one the storefront
 * shows in a grid, and "make this the cover" is the reordering merchants
 * actually ask for.
 */
export function ImageGallery({
  value,
  onChange,
  max = 8,
  label,
  hint,
  disabled,
}: {
  value: string[];
  onChange: (urls: string[]) => void;
  max?: number;
  label?: string;
  hint?: string;
  disabled?: boolean;
}) {
  const { loc } = useLanguage();
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function add(files: FileList | null) {
    if (!files?.length) return;
    setError('');
    const room = max - value.length;
    if (room <= 0) {
      setError(loc(`الحد الأقصى ${max} صور.`, `At most ${max} images.`, `زۆرترین ${max} وێنە.`));
      return;
    }

    const chosen = Array.from(files).slice(0, room);
    setBusy(true);
    const added: string[] = [];
    let failed = 0;
    for (const file of chosen) {
      if (!ACCEPT.split(',').includes(file.type) || file.size > MAX_BYTES) { failed += 1; continue; }
      try {
        const { url } = await uploadFile(file, 'community');
        added.push(url);
      } catch {
        failed += 1;
      }
    }
    setBusy(false);
    if (input.current) input.current.value = '';

    // Whatever succeeded is kept. Losing four good uploads because the fifth
    // was a screenshot would be the wrong trade.
    if (added.length) onChange([...value, ...added]);
    if (failed) {
      setError(loc(
        `تعذّر رفع ${failed} من الملفات — تأكد أنها صور JPEG أو PNG أو WebP أقل من ${MAX_BYTES / 1024 / 1024} ميغابايت.`,
        `${failed} file(s) could not be uploaded — they must be JPEG, PNG or WebP images under ${MAX_BYTES / 1024 / 1024} MB.`,
        `${failed} فایل بار نەکرا — دەبێت وێنەی JPEG یان PNG یان WebP بن.`
      ));
    }
  }

  return (
    <div>
      {label && (
        <label className="block text-zinc-400 text-[12.5px] font-semibold mb-2">{label}</label>
      )}

      <div className="flex flex-wrap gap-2">
        {value.map((url, i) => (
          <div key={url} className="relative w-20 h-20 rounded-2xl overflow-hidden bg-black/40 border border-white/10">
            <img src={url} alt="" className="w-full h-full object-cover" />
            {i === 0 && (
              <span className="absolute top-1 start-1 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-black/70 text-gold">
                {loc('الغلاف', 'Cover', 'بەرگ')}
              </span>
            )}
            <div className="absolute bottom-0 inset-x-0 flex">
              {i > 0 && (
                <button
                  type="button"
                  onClick={() => onChange([url, ...value.filter((u) => u !== url)])}
                  disabled={disabled}
                  className="flex-1 bg-black/70 text-gold text-[9px] font-bold py-1"
                >
                  {loc('غلاف', 'Cover', 'بەرگ')}
                </button>
              )}
              <button
                type="button"
                onClick={() => onChange(value.filter((u) => u !== url))}
                disabled={disabled}
                className="flex-1 bg-black/70 text-red-300 text-[9px] font-bold py-1"
              >
                {loc('حذف', 'Remove', 'سڕینەوە')}
              </button>
            </div>
          </div>
        ))}

        {value.length < max && (
          <button
            type="button"
            onClick={() => input.current?.click()}
            disabled={busy || disabled}
            className="w-20 h-20 rounded-2xl border border-dashed border-white/15 bg-white/[0.02] flex items-center justify-center disabled:opacity-40"
          >
            {busy ? <Loader2 className="w-4 h-4 text-gold animate-spin" /> : <ImagePlus className="w-5 h-5 text-zinc-600" />}
          </button>
        )}
      </div>

      {hint && !error && <p className="text-text-muted text-[11px] mt-2">{hint}</p>}
      {error && <p className="text-red-400 text-[11.5px] mt-2">{error}</p>}

      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        multiple
        className="hidden"
        onChange={(e) => add(e.target.files)}
      />
    </div>
  );
}
