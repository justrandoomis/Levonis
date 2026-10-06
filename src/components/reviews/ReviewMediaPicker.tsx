/**
 * THE REVIEW'S PHOTOS AND VIDEOS, PICKED, PREVIEWED AND UPLOADED
 * (docs/REVIEWS_GIFTS.md §5, §8 C1). Lives inside ReviewSheet, the only
 * review form.
 *
 *  - Several photos at once, videos (MP4 / MOV / WebM), and on a touch
 *    device a camera button. Counters «الصور x/10 · الفيديو y/2»; each «add»
 *    tile disappears when its kind is full.
 *  - A tile appears the moment a file is picked, with a `blob:` preview of the
 *    photo or the video's first frame — before a byte has travelled — and a
 *    bar with the percentage while it uploads. Tap a tile to see it full size
 *    (the lazy viewer, which plays a video with its controls).
 *  - Remove any tile; replace any tile in its place; a failed upload says
 *    why (the server's refusal code, in the customer's language) and offers
 *    to try again.
 *  - Over the limit is REFUSED and SAID, never sliced silently: «11 photos»
 *    adds 10 and reports the one it did not add.
 *
 * The upload itself is `useReviewMediaUploads` below: two files in flight, the
 * rest queued, each through the one review door (reviewUpload.ts). The sheet
 * holds a draft per product, so the hook keeps a list per product (`scope`)
 * and an upload keeps running while the customer rates another product.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Camera, ImagePlus, Play, RefreshCw, RotateCw, Video, X } from 'lucide-react';
import { ApiError } from '../../lib/api';
import { refusalText } from '../../lib/refusalStrings';
import { usePointerFine } from '../../lib/useMediaQuery';
import { useLanguage } from '../../LanguageContext';
import { reviewStrings, asReviewLang, type ReviewStrings } from './reviewStrings';
import {
  MEDIA_LIMITS,
  PHOTO_ACCEPT,
  VIDEO_ACCEPT,
  fingerprintOf,
  isPending,
  mediaCounts,
  planPick,
  prepareReviewImage,
  uploadReviewMedia,
  type MediaSlot,
  type PickPlan,
} from './reviewUpload';
import type { ReviewMediaItem } from './ReviewMediaGallery';

const ReviewMediaViewer = React.lazy(() => import('./ReviewMediaViewer'));

// ------------------------------------------------------------- the uploads

export interface ReviewMediaUploads {
  slotsOf: (scope: string) => MediaSlot[];
  add: (scope: string, files: File[]) => PickPlan;
  replace: (scope: string, id: string, file: File) => PickPlan | null;
  remove: (scope: string, id: string) => void;
  retry: (scope: string, id: string) => void;
  /** Edit mode: the media the review already has, as stored tiles. */
  seed: (scope: string, slots: MediaSlot[]) => void;
  clear: (scope: string) => void;
  clearAll: () => void;
  /** A refusal at submit that names an item (`details.index`, payload order). */
  markFailed: (scope: string, payloadIndex: number, code: string) => void;
}

export function useReviewMediaUploads(): ReviewMediaUploads {
  const data = useRef<Record<string, MediaSlot[]>>({});
  const files = useRef(new Map<string, { file: File; convertible: boolean }>());
  const ctrls = useRef(new Map<string, AbortController>());
  const blobs = useRef(new Map<string, string>());
  const running = useRef(0);
  const seq = useRef(0);
  const alive = useRef(true);
  const [, setTick] = useState(0);
  const bump = useCallback(() => {
    if (alive.current) setTick((t) => t + 1);
  }, []);

  const patch = useCallback(
    (id: string, p: Partial<MediaSlot>) => {
      let hit = false;
      const next: Record<string, MediaSlot[]> = {};
      for (const [scope, list] of Object.entries(data.current)) {
        next[scope] = list.map((s) => {
          if (s.id !== id) return s;
          hit = true;
          return { ...s, ...p };
        });
      }
      if (!hit) return;
      data.current = next;
      bump();
    },
    [bump]
  );

  /** Stop and forget one tile's upload, file and preview. */
  const discard = useCallback((id: string) => {
    ctrls.current.get(id)?.abort();
    ctrls.current.delete(id);
    files.current.delete(id);
    const url = blobs.current.get(id);
    if (url) URL.revokeObjectURL(url);
    blobs.current.delete(id);
  }, []);

  const pumpRef = useRef<() => void>(() => {});

  const run = useCallback(
    async (id: string) => {
      const entry = files.current.get(id);
      if (!entry) return;
      running.current += 1;
      const ctrl = new AbortController();
      ctrls.current.set(id, ctrl);
      patch(id, { status: entry.convertible ? 'preparing' : 'uploading', progress: 0, error: null });
      try {
        const body = entry.convertible ? await prepareReviewImage(entry.file) : entry.file;
        if (ctrl.signal.aborted) return;
        patch(id, { status: 'uploading', progress: 0 });
        let last = -1;
        const res = await uploadReviewMedia(
          body,
          (f) => {
            const pct = Math.round(f * 100);
            if (pct === last) return;
            last = pct;
            patch(id, { progress: f });
          },
          ctrl.signal
        );
        if (ctrl.signal.aborted) return;
        // The server's verdict on the BYTES wins over the browser's label.
        patch(id, { status: 'done', progress: 1, key: res.key, kind: res.kind });
      } catch (e) {
        if (ctrl.signal.aborted) return;
        patch(id, { status: 'failed', progress: 0, error: e instanceof ApiError && e.code ? e.code : 'NETWORK' });
      } finally {
        if (ctrls.current.get(id) === ctrl) ctrls.current.delete(id);
        running.current -= 1;
        pumpRef.current();
      }
    },
    [patch]
  );

  const pump = useCallback(() => {
    while (running.current < MEDIA_LIMITS.concurrency) {
      let next: MediaSlot | undefined;
      for (const list of Object.values(data.current)) {
        next = list.find((s) => s.status === 'queued' && files.current.has(s.id));
        if (next) break;
      }
      if (!next) return;
      void run(next.id);
    }
  }, [run]);
  pumpRef.current = pump;

  const slotFor = useCallback((file: File, kind: MediaSlot['kind'], convertible: boolean): MediaSlot => {
    seq.current += 1;
    const id = `m${seq.current}`;
    const url = URL.createObjectURL(file);
    blobs.current.set(id, url);
    files.current.set(id, { file, convertible });
    return { id, kind, status: 'queued', progress: 0, previewUrl: url, key: null, error: null, name: file.name, fingerprint: fingerprintOf(file) };
  }, []);

  const api = useMemo<ReviewMediaUploads>(
    () => ({
      slotsOf: (scope) => data.current[scope] ?? [],
      add: (scope, picked) => {
        const list = data.current[scope] ?? [];
        const plan = planPick(list, picked);
        if (plan.accepted.length > 0) {
          const created = plan.accepted.map((a) => slotFor(picked[a.index], a.kind, a.convertible));
          data.current = { ...data.current, [scope]: [...list, ...created] };
          bump();
          pump();
        }
        return plan;
      },
      replace: (scope, id, file) => {
        const list = data.current[scope] ?? [];
        const at = list.findIndex((s) => s.id === id);
        if (at < 0) return null;
        const plan = planPick(list, [file], id);
        const a = plan.accepted[0];
        if (!a) return plan;
        discard(id);
        const next = list.slice();
        // A fresh id in the same place: the old upload's late answers can
        // never land on the new file.
        next[at] = slotFor(file, a.kind, a.convertible);
        data.current = { ...data.current, [scope]: next };
        bump();
        pump();
        return plan;
      },
      remove: (scope, id) => {
        discard(id);
        data.current = { ...data.current, [scope]: (data.current[scope] ?? []).filter((s) => s.id !== id) };
        bump();
      },
      retry: (_scope, id) => {
        if (!files.current.has(id)) return;
        patch(id, { status: 'queued', progress: 0, error: null, key: null });
        pump();
      },
      seed: (scope, slots) => {
        for (const s of data.current[scope] ?? []) discard(s.id);
        data.current = { ...data.current, [scope]: slots };
        bump();
      },
      clear: (scope) => {
        for (const s of data.current[scope] ?? []) discard(s.id);
        const next = { ...data.current };
        delete next[scope];
        data.current = next;
        bump();
      },
      clearAll: () => {
        for (const list of Object.values(data.current)) for (const s of list) discard(s.id);
        data.current = {};
        bump();
      },
      markFailed: (scope, payloadIndex, code) => {
        const sent = (data.current[scope] ?? []).filter((s) => s.status === 'done' && !!s.key);
        const slot = sent[payloadIndex];
        if (slot) patch(slot.id, { status: 'failed', error: code });
      },
    }),
    [bump, discard, patch, pump, slotFor]
  );

  // Leaving the screen stops every upload and frees every preview.
  useEffect(() => {
    alive.current = true;
    const ctrlMap = ctrls.current;
    const blobMap = blobs.current;
    return () => {
      alive.current = false;
      for (const c of ctrlMap.values()) c.abort();
      for (const url of blobMap.values()) URL.revokeObjectURL(url);
      ctrlMap.clear();
      blobMap.clear();
    };
  }, []);

  return api;
}

// ---------------------------------------------------------------- the picker

/** The sentence for what a pick did not add — counts and names, never a bare code. */
export function describePick(plan: PickPlan | null, s: ReviewStrings, lang: string): string {
  if (!plan) return '';
  const parts: string[] = [];
  const shown = plan.refused.slice(0, 3);
  for (const r of shown) {
    parts.push(r.code === 'REVIEW_MEDIA_DUPLICATE' ? s.duplicateFile(r.name) : s.fileRefused(r.name, refusalText(r.code, asReviewLang(lang), s.fileFallback)));
  }
  if (plan.refused.length > shown.length) parts.push('…');
  if (plan.skippedImages > 0) parts.push(s.skippedImages(plan.skippedImages));
  if (plan.skippedVideos > 0) parts.push(s.skippedVideos(plan.skippedVideos));
  return parts.join(' ');
}

export interface ReviewMediaPickerProps {
  slots: MediaSlot[];
  onAdd: (files: File[]) => PickPlan | null;
  onReplace: (id: string, file: File) => PickPlan | null;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  /** No picking while the review itself is being sent. */
  disabled?: boolean;
  /** Prefix for the ids this control owns. */
  idBase?: string;
  /** A message from outside the picker, e.g. a refusal at submit naming a file. */
  notice?: string;
}

export default function ReviewMediaPicker({ slots, onAdd, onReplace, onRemove, onRetry, disabled = false, idBase = 'review-media', notice: outer = '' }: ReviewMediaPickerProps) {
  const { lang } = useLanguage();
  const s = reviewStrings(lang);
  const fine = usePointerFine();
  const photoInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const replacing = useRef<string | null>(null);
  const tileRef = useRef<HTMLElement | null>(null);
  const [notice, setNotice] = useState('');
  const [viewAt, setViewAt] = useState<number | null>(null);
  const [viewerMounted, setViewerMounted] = useState(false);

  const { images, videos } = mediaCounts(slots);
  const imagesLeft = Math.max(0, MEDIA_LIMITS.maxImages - images);
  const videosLeft = Math.max(0, MEDIA_LIMITS.maxVideos - videos);
  const failed = slots.filter((x) => x.status === 'failed');
  const viewable: ReviewMediaItem[] = slots.map((x) => ({ url: x.previewUrl, kind: x.kind }));

  const take = (list: FileList | null, input: HTMLInputElement | null) => {
    const picked = list ? Array.from(list) : [];
    if (input) input.value = '';
    if (picked.length === 0) return;
    setNotice(describePick(onAdd(picked), s, lang));
  };

  const takeReplacement = (list: FileList | null) => {
    const file = list?.[0];
    if (replaceInput.current) replaceInput.current.value = '';
    const id = replacing.current;
    replacing.current = null;
    if (!file || !id) return;
    setNotice(describePick(onReplace(id, file), s, lang));
  };

  const startReplace = (slot: MediaSlot) => {
    replacing.current = slot.id;
    const el = replaceInput.current;
    if (!el) return;
    el.accept = slot.kind === 'video' ? VIDEO_ACCEPT : PHOTO_ACCEPT;
    el.click();
  };

  const labelOf = (slot: MediaSlot): string => {
    const sameKind = slots.filter((x) => x.kind === slot.kind);
    const nth = sameKind.indexOf(slot) + 1;
    return slot.kind === 'video' ? s.videoN(nth, sameKind.length) : s.photoN(nth, sameKind.length);
  };

  const corner =
    'lv-hit absolute top-1 z-10 inline-flex items-center justify-center rounded-full bg-black/70 p-1.5 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-40';
  const addTile =
    'flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border-subtle bg-surface px-1 text-center text-[11.5px] font-bold text-text-secondary transition-colors hover:text-text-primary hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50';

  return (
    <section aria-labelledby={`${idBase}-title`} data-review-media-picker className="mt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 id={`${idBase}-title`} className="text-[12.5px] font-bold text-text-secondary">
          {s.mediaTitle}
        </h3>
        <p aria-live="polite" data-media-counts className="text-[12px] text-text-muted tabular-nums">
          <span data-count-images={images}>{s.photosCount(images)}</span>
          <span aria-hidden> · </span>
          <span data-count-videos={videos}>{s.videosCount(videos)}</span>
        </p>
      </div>

      <ul role="list" className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
        {slots.map((slot, i) => {
          const label = labelOf(slot);
          const pct = Math.round(slot.progress * 100);
          const pending = isPending(slot);
          const isBlob = slot.previewUrl.startsWith('blob:');
          return (
            <li key={slot.id} className="relative" data-slot-status={slot.status} data-slot-kind={slot.kind}>
              <button
                type="button"
                onClick={(e) => {
                  tileRef.current = e.currentTarget;
                  setViewerMounted(true);
                  setViewAt(i);
                }}
                aria-label={s.preview(label)}
                className={`relative block aspect-square w-full overflow-hidden rounded-xl border bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                  slot.status === 'failed' ? 'border-danger' : 'border-border-subtle'
                }`}
              >
                {slot.kind === 'image' ? (
                  <img src={slot.previewUrl} alt="" decoding="async" className="h-full w-full object-cover" />
                ) : isBlob ? (
                  // The first frame of the picked clip, read locally: nothing travels for it.
                  <video src={`${slot.previewUrl}#t=0.1`} muted playsInline preload="metadata" tabIndex={-1} aria-hidden className="pointer-events-none h-full w-full bg-black object-cover" />
                ) : (
                  <span aria-hidden className="block h-full w-full bg-black" />
                )}
                {slot.kind === 'video' && (
                  <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/70 text-white">
                      <Play className="h-4 w-4" fill="currentColor" aria-hidden />
                    </span>
                  </span>
                )}
              </button>

              {pending && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/70 px-1.5 pb-1.5 pt-1" style={{ borderBottomLeftRadius: 12, borderBottomRightRadius: 12 }}>
                  <span className="block truncate text-[10.5px] font-bold text-white tabular-nums">
                    {slot.status === 'queued' ? s.queued : slot.status === 'preparing' ? s.preparing : s.uploadingPct(pct)}
                  </span>
                  <span
                    role="progressbar"
                    aria-label={label}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={slot.status === 'uploading' ? pct : 0}
                    className="mt-1 block h-1 overflow-hidden rounded-full bg-white/10"
                  >
                    <span className="block h-full rounded-full bg-gold transition-[width]" style={{ width: `${slot.status === 'uploading' ? pct : 0}%` }} />
                  </span>
                </div>
              )}

              {slot.status === 'failed' && (
                <button
                  type="button"
                  onClick={() => onRetry(slot.id)}
                  disabled={disabled || slot.existing}
                  aria-label={s.retryFile(label)}
                  data-slot-retry
                  className="absolute start-1 end-1 bottom-1 z-10 inline-flex min-h-[32px] items-center justify-center gap-1 rounded-lg bg-danger px-2 text-[11px] font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60"
                >
                  <RotateCw className="h-3.5 w-3.5" aria-hidden />
                  {slot.existing ? s.uploadFailed : s.retryShort}
                </button>
              )}

              <button
                type="button"
                onClick={() => onRemove(slot.id)}
                disabled={disabled}
                aria-label={s.remove(label)}
                data-slot-remove
                className={`${corner} end-1`}
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
              {!pending && (
                <button
                  type="button"
                  onClick={() => startReplace(slot)}
                  disabled={disabled}
                  aria-label={s.replace(label)}
                  data-slot-replace
                  className={`${corner} start-1`}
                >
                  <RefreshCw className="h-4 w-4" aria-hidden />
                </button>
              )}
            </li>
          );
        })}

        {imagesLeft > 0 && (
          <li>
            <button type="button" onClick={() => photoInput.current?.click()} disabled={disabled} data-add-photos className={addTile}>
              <ImagePlus className="h-5 w-5" aria-hidden />
              {s.addPhotos}
            </button>
          </li>
        )}
        {!fine && imagesLeft > 0 && (
          <li>
            <button type="button" onClick={() => cameraInput.current?.click()} disabled={disabled} data-take-photo className={addTile}>
              <Camera className="h-5 w-5" aria-hidden />
              {s.takePhoto}
            </button>
          </li>
        )}
        {videosLeft > 0 && (
          <li>
            <button type="button" onClick={() => videoInput.current?.click()} disabled={disabled} data-add-video className={addTile}>
              <Video className="h-5 w-5" aria-hidden />
              {s.addVideo}
            </button>
          </li>
        )}
      </ul>

      <p className="mt-2 text-[11px] text-text-muted">{s.limitsNote}</p>

      <div role="status" aria-live="polite" data-media-notice className="text-[12px] text-warning">
        {[notice, outer].filter(Boolean).map((line, i) => (
          <p key={i} className="mt-1.5">
            {line}
          </p>
        ))}
        {failed.map((slot) => (
          <p key={slot.id} className="mt-1.5 text-danger" data-slot-error={slot.error ?? ''}>
            {s.fileRefused(slot.name || labelOf(slot), refusalText(slot.error, asReviewLang(lang), s.uploadFailed))}
          </p>
        ))}
      </div>

      <input ref={photoInput} type="file" accept={PHOTO_ACCEPT} multiple hidden onChange={(e) => take(e.target.files, e.target)} data-input-photos />
      <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => take(e.target.files, e.target)} data-input-camera />
      <input ref={videoInput} type="file" accept={VIDEO_ACCEPT} multiple hidden onChange={(e) => take(e.target.files, e.target)} data-input-video />
      <input ref={replaceInput} type="file" hidden onChange={(e) => takeReplacement(e.target.files)} data-input-replace />

      {viewerMounted && (
        <React.Suspense fallback={null}>
          <ReviewMediaViewer open={viewAt !== null} onClose={() => setViewAt(null)} media={viewable} index={viewAt ?? 0} anchor={tileRef} label={s.mediaTitle} />
        </React.Suspense>
      )}
    </section>
  );
}
