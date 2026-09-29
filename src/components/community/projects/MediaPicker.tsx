/**
 * THE PICTURES AND VIDEOS OF A PROJECT — pick, upload, reorder, remove.
 *
 * Built like src/components/media/ImagePicker.tsx (the client checks type and
 * size as a courtesy; the SERVER sniffs the bytes and decides) with two
 * differences a project needs: it keeps the storage KEY beside the URL,
 * because the key is what the composer sends back and the server checks
 * against the file ledger under the author's own prefix; and it takes video,
 * because a timelapse is a video. Uploads go through purpose=post, so every
 * file lands under `users/<uid>/posts/` — the one prefix a post may cite.
 *
 * WHAT «SAVED» MEANS. A tile appears only once the server has the file; a
 * failed upload is a message under the grid, never a ghost tile. The first
 * tile is the cover; «اجعلها الغلاف» moves a tile there, because that is the
 * reorder people actually ask for.
 */
import { useRef, useState } from 'react';
import { Film, ImagePlus, Loader2, Star, Trash2 } from 'lucide-react';
import { ApiError, uploadFile } from '../../../lib/api';
import { useLanguage } from '../../../LanguageContext';
import { refusalText } from '../../../lib/refusalStrings';

export interface PickedMedia {
  key: string;
  url: string;
  kind: 'image' | 'video';
  width: number | null;
  height: number | null;
  duration_s: number | null;
}

/** Kept in step with the server's sniffer (worker/routes/uploads.ts). */
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];
const IMAGE_MAX = 8 * 1024 * 1024;
const VIDEO_MAX = 40 * 1024 * 1024;

export const PROJECT_MEDIA_MAX = 12;

/** A video's length, read by the browser without uploading anything. */
function videoDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    const done = (d: number | null) => {
      URL.revokeObjectURL(url);
      resolve(d);
    };
    v.preload = 'metadata';
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? Math.round(v.duration) : null);
    v.onerror = () => done(null);
    v.src = url;
  });
}

export function ProjectMediaPicker({
  value,
  onChange,
  max = PROJECT_MEDIA_MAX,
  disabled,
  error: saveError,
}: {
  value: PickedMedia[];
  onChange: (next: PickedMedia[]) => void;
  max?: number;
  disabled?: boolean;
  /** A refusal about the pictures from the form's save. */
  error?: string;
}) {
  const { loc, lang } = useLanguage();
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState('');
  const refusalLang = lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar';

  async function pick(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError('');
    const room = Math.max(0, max - value.length);
    const chosen = Array.from(files).slice(0, room);
    if (chosen.length < files.length) {
      setError(loc(`الحد ${max} ملفًا للمشروع الواحد.`, `A project holds up to ${max} files.`, `پڕۆژەیەک تا ${max} فایل هەڵدەگرێت.`));
    }
    let current = value;
    for (const file of chosen) {
      const isVideo = VIDEO_TYPES.includes(file.type);
      const isImage = IMAGE_TYPES.includes(file.type);
      if (!isVideo && !isImage) {
        setError(loc('اختر صورة JPEG أو PNG أو WebP أو GIF، أو فيديو MP4.', 'Choose a JPEG, PNG, WebP or GIF image, or an MP4 video.', 'وێنەیەکی JPEG یان PNG یان WebP یان GIF، یان ڤیدیۆیەکی MP4 هەڵبژێرە.'));
        continue;
      }
      if (file.size > (isVideo ? VIDEO_MAX : IMAGE_MAX)) {
        const mb = (isVideo ? VIDEO_MAX : IMAGE_MAX) / 1024 / 1024;
        setError(loc(`الملف أكبر من ${mb} ميغابايت.`, `That file is larger than ${mb} MB.`, `فایلەکە لە ${mb} MB گەورەترە.`));
        continue;
      }
      setBusy((n) => n + 1);
      try {
        const [up, duration] = await Promise.all([uploadFile(file, 'post'), isVideo ? videoDuration(file) : Promise.resolve(null)]);
        const item: PickedMedia = {
          key: up.key,
          url: up.url,
          kind: isVideo ? 'video' : 'image',
          width: up.width ?? null,
          height: up.height ?? null,
          duration_s: duration,
        };
        current = [...current, item];
        onChange(current);
      } catch (e) {
        const fallback = loc('تعذّر رفع الملف.', 'Could not upload the file.', 'نەتوانرا فایلەکە باربکرێت.');
        setError(e instanceof ApiError ? refusalText(e.code, refusalLang, fallback) : fallback);
      } finally {
        setBusy((n) => n - 1);
      }
    }
    // Clear the input so choosing the SAME file again still fires a change.
    if (input.current) input.current.value = '';
  }

  const remove = (key: string) => onChange(value.filter((m) => m.key !== key));
  const makeCover = (key: string) => {
    const item = value.find((m) => m.key === key);
    if (!item) return;
    onChange([item, ...value.filter((m) => m.key !== key)]);
  };

  const full = value.length >= max;

  return (
    <div>
      <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4" aria-label={loc('صور المشروع', 'Project pictures', 'وێنەکانی پڕۆژە')}>
        {value.map((m, i) => (
          <li key={m.key} className="group relative aspect-square overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900">
            {m.kind === 'video' ? (
              <video src={m.url} muted playsInline preload="metadata" className="h-full w-full object-cover" />
            ) : (
              <img src={m.url} alt="" className="h-full w-full object-cover" />
            )}
            {m.kind === 'video' && (
              <span aria-hidden="true" className="absolute start-1.5 top-1.5 rounded-full bg-black/70 p-1 text-white">
                <Film className="h-3 w-3" />
              </span>
            )}
            {i === 0 && (
              <span className="absolute bottom-1.5 start-1.5 rounded-full bg-black/70 px-2 py-0.5 text-[10.5px] font-semibold text-white">
                {loc('الغلاف', 'Cover', 'بەرگ')}
              </span>
            )}
            <span className="absolute end-1 top-1 flex gap-1">
              {i !== 0 && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => makeCover(m.key)}
                  aria-label={loc('اجعلها الغلاف', 'Make this the cover', 'بیکە بە بەرگ')}
                  className="rounded-full bg-black/70 p-1.5 text-white transition-colors hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <Star className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                type="button"
                disabled={disabled}
                onClick={() => remove(m.key)}
                aria-label={loc('إزالة', 'Remove', 'لابردن')}
                className="rounded-full bg-black/70 p-1.5 text-white transition-colors hover:bg-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </span>
          </li>
        ))}
        {busy > 0 && (
          <li aria-live="polite" className="flex aspect-square items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900">
            <Loader2 className="h-5 w-5 animate-spin text-gold" />
            <span className="sr-only">{loc('جارٍ الرفع', 'Uploading', 'باردەکرێت')}</span>
          </li>
        )}
        {!full && (
          <li>
            <button
              type="button"
              disabled={disabled}
              onClick={() => input.current?.click()}
              data-project-media-add
              className="press-scale flex aspect-square w-full flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed border-zinc-700 bg-zinc-900/40 text-zinc-400 transition-colors hover:border-zinc-700 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-40"
            >
              <ImagePlus aria-hidden="true" className="h-5 w-5" />
              <span className="text-[11.5px] font-semibold">{value.length === 0 ? loc('أضف صورًا', 'Add pictures', 'وێنە زیاد بکە') : loc('أضف', 'Add', 'زیادکردن')}</span>
            </button>
          </li>
        )}
      </ul>
      <p className="mt-2 text-[11.5px] text-text-muted">
        {loc(
          `حتى ${max} صورة أو فيديو. الأولى هي الغلاف.`,
          `Up to ${max} pictures or videos. The first is the cover.`,
          `تا ${max} وێنە یان ڤیدیۆ. یەکەمیان بەرگەکەیە.`
        )}
      </p>
      {(error || saveError) && (
        <p className="mt-1.5 text-[11.5px] text-red-400" role="alert">
          {error || saveError}
        </p>
      )}
      <input
        ref={input}
        type="file"
        multiple
        accept={[...IMAGE_TYPES, ...VIDEO_TYPES].join(',')}
        className="hidden"
        onChange={(e) => void pick(e.target.files)}
      />
    </div>
  );
}
