/**
 * A product's photos and videos, in order (W2-F media rows).
 *
 *   · the FIRST item is the cover (the storefront card and the cart use it);
 *   · photos go through the same client preparation as every upload
 *     (`uploadFile`, purpose `community`) and videos travel as picked — the
 *     SERVER sniffs both (worker/routes/uploads.ts: MP4/WebM with a real video
 *     track, 40 MB) and files them under the merchant's own prefix;
 *   · what is on screen is what the server has: a tile appears when its
 *     upload answered, never from a local object URL;
 *   · order is changed with two buttons per tile (no drag-only affordance),
 *     and every tile's description is editable for screen readers.
 */
import { useId, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ImagePlus, Film, Loader2, Play, X } from 'lucide-react';
import { ApiError, uploadFile } from '../../../lib/api';
import { refusalText } from '../../../lib/refusalStrings';
import { useLanguage } from '../../../LanguageContext';
import { Button, IconButton } from '../../ui/Button';
import { Field, Input } from '../../ui/Field';
import type { CatalogMedia } from './catalogApi';
import type { CatalogStrings } from './strings';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const VIDEO_TYPES = ['video/mp4', 'video/webm'];
const VIDEO_MAX = 40 * 1024 * 1024;
export const MAX_MEDIA = 12;
export const MAX_VIDEOS = 2;

export function MediaEditor({
  value,
  onChange,
  s,
  disabled,
}: {
  value: CatalogMedia[];
  onChange: (next: CatalogMedia[]) => void;
  s: CatalogStrings;
  disabled?: boolean;
}) {
  const { lang } = useLanguage();
  const photoInput = useRef<HTMLInputElement | null>(null);
  const videoInput = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState<'' | 'photo' | 'video'>('');
  const [error, setError] = useState('');
  const [focus, setFocus] = useState<string | null>(null);
  const altId = useId();
  // The newest list, for uploads that answer one after another.
  const latest = useRef(value);
  latest.current = value;

  const videos = value.filter((m) => m.kind === 'video').length;
  const room = MAX_MEDIA - value.length;

  async function add(files: FileList | null, kind: 'image' | 'video') {
    if (!files?.length) return;
    setError('');
    const list = [...files].slice(0, kind === 'video' ? Math.min(room, MAX_VIDEOS - videos) : room);
    setBusy(kind === 'video' ? 'video' : 'photo');
    try {
      for (const file of list) {
        if (kind === 'image' && !IMAGE_TYPES.includes(file.type)) throw new Error(s.imageTypeWrong);
        if (kind === 'video' && !VIDEO_TYPES.includes(file.type)) throw new Error(s.videoTypeWrong);
        if (kind === 'video' && file.size > VIDEO_MAX) throw new Error(s.videoTooBig);
        const up = await uploadFile(file, 'community');
        const item: CatalogMedia = { kind, key: up.key, url: up.url, alt: '', alt_ar: '' };
        onChange([...latest.current, item]);
        latest.current = [...latest.current, item];
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VIDEO_UNSUPPORTED') setError(s.videoTypeWrong);
      else if (e instanceof ApiError && (e.code === 'STORE_REQUIRED' || e.code === 'VIDEO_QUOTA_EXCEEDED')) setError(refusalText(e.code, lang));
      else setError(e instanceof Error && e.message ? e.message : s.uploadFailed);
    } finally {
      setBusy('');
      if (photoInput.current) photoInput.current.value = '';
      if (videoInput.current) videoInput.current.value = '';
    }
  }

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  }

  const focused = value.find((m) => m.key === focus) ?? null;
  const altField = lang === 'en' ? 'alt' : 'alt_ar';

  return (
    <div className="space-y-3" data-media-editor>
      {value.length > 0 && (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {value.map((m, i) => (
            <li key={m.key} className="relative">
              <button
                type="button"
                onClick={() => setFocus(focus === m.key ? null : m.key)}
                aria-pressed={focus === m.key}
                aria-label={`${m.kind === 'video' ? s.video : ''} ${i + 1}${i === 0 ? ` · ${s.cover}` : ''}`}
                className={`block aspect-square w-full overflow-hidden rounded-xl border bg-black/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold ${
                  focus === m.key ? 'border-gold' : 'border-white/10'
                }`}
              >
                {m.kind === 'video' ? (
                  <span className="flex h-full w-full items-center justify-center">
                    <Play className="h-6 w-6 text-white" aria-hidden="true" />
                  </span>
                ) : (
                  <img src={m.url} alt="" className="h-full w-full object-cover" loading="lazy" />
                )}
              </button>
              {i === 0 && (
                <span className="pointer-events-none absolute start-1 top-1 rounded-md bg-black/70 px-1.5 py-0.5 text-[10.5px] font-semibold text-white">
                  {s.cover}
                </span>
              )}
              <div className="mt-1 flex items-center justify-between">
                <IconButton label={s.moveEarlier} icon={<ArrowRight className="h-4 w-4 ltr:rotate-180" />} onClick={() => move(i, -1)} disabled={disabled || i === 0} />
                <IconButton label={s.removeMedia} variant="danger" icon={<X className="h-4 w-4" />} disabled={disabled} onClick={() => onChange(value.filter((x) => x.key !== m.key))} />
                <IconButton label={s.moveLater} icon={<ArrowLeft className="h-4 w-4 ltr:rotate-180" />} onClick={() => move(i, 1)} disabled={disabled || i === value.length - 1} />
              </div>
            </li>
          ))}
        </ul>
      )}

      {focused && (
        <Field label={s.altText} id={altId} optional>
          <Input
            value={focused[altField]}
            maxLength={200}
            onChange={(e) => onChange(value.map((m) => (m.key === focused.key ? { ...m, [altField]: e.target.value } : m)))}
          />
        </Field>
      )}

      <div className="flex flex-wrap gap-2">
        <input ref={photoInput} type="file" accept={IMAGE_TYPES.join(',')} multiple className="sr-only" tabIndex={-1} onChange={(e) => add(e.target.files, 'image')} />
        <input ref={videoInput} type="file" accept={VIDEO_TYPES.join(',')} className="sr-only" tabIndex={-1} onChange={(e) => add(e.target.files, 'video')} />
        <Button
          variant="secondary"
          size="sm"
          icon={busy === 'photo' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
          disabled={disabled || !!busy || room <= 0}
          onClick={() => photoInput.current?.click()}
        >
          {busy === 'photo' ? s.uploading : s.addPhoto}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon={busy === 'video' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Film className="h-4 w-4" />}
          disabled={disabled || !!busy || room <= 0 || videos >= MAX_VIDEOS}
          onClick={() => videoInput.current?.click()}
        >
          {busy === 'video' ? s.uploading : s.addVideo}
        </Button>
      </div>
      <p className="text-[12px] leading-relaxed text-text-muted">{s.mediaHint}</p>
      {error && (
        <p role="alert" className="lv-field-error">
          {error}
        </p>
      )}
    </div>
  );
}
