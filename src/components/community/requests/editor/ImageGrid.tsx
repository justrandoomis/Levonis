/**
 * THE REQUEST’S PICTURES AS A GRID (plan P1-06, acceptance 13; design §5.1,
 * critique 14).
 *
 * Three columns at 360 px (a tile of about 104 px), four from 480, six from
 * 768; square tiles, no sideways scroll. A stored picture is a sized copy from
 * its authorised route (`?w=`), never the phone original; one still on its
 * way is its device preview with its upload state over it.
 *
 * Each tile is a list item holding the tile’s own button (it opens the
 * viewer, named «افتح الصورة 2 من 3: side.png») and, beside it — never inside
 * it — the buttons of a picture that did not upload («أعد المحاولة»,
 * «ألغِ»), icon buttons with names that fit a 104 px tile. A picture’s other
 * actions (the main source, its note, deleting it) live in the viewer.
 */
import { RotateCcw, Star, StickyNote, X } from 'lucide-react';
import { IconButton } from '../../../ui/Button';
import { requestImageSrc, requestImageSrcSet } from '../RequestFileThumbs';
import { fill, type EditorStrings } from './strings';
import { fileOf, isFileSource, primaryKey, type EditorState } from './state';
import type { UploadRow } from './uploads';

export interface GridPicture {
  key: string;
  name: string;
  url: string | null;
  preview: string | null;
  primary: boolean;
  hasNote: boolean;
  upload: UploadRow | null;
}

/** The request’s pictures in the order they arrived: the stored ones, then those still on their way. */
export function gridPictures(s: EditorState, rows: readonly UploadRow[]): GridPicture[] {
  const main = primaryKey(s);
  return [
    ...s.sources
      .filter((x) => isFileSource(x) && !!fileOf(s, x.fileId)?.inline)
      .map((x) => {
        const f = fileOf(s, x.fileId)!;
        return { key: x.key, name: f.file_name, url: f.url, preview: null, primary: main === x.key, hasNote: !!x.note.trim(), upload: null };
      }),
    ...rows
      .filter((r) => !!r.preview && r.status !== 'rejected')
      .map((r) => ({ key: r.key, name: r.name, url: null, preview: r.preview, primary: false, hasNote: false, upload: r })),
  ];
}

export function ImageGrid({
  pictures,
  onOpen,
  onRetry,
  onCancel,
  t,
}: {
  pictures: GridPicture[];
  onOpen: (index: number) => void;
  onRetry: (uploadKey: string) => void;
  onCancel: (uploadKey: string) => void;
  t: EditorStrings;
}) {
  if (!pictures.length) return null;
  const total = pictures.length;
  return (
    <ul role="list" aria-label={t.picturesLabel} className="grid grid-cols-3 gap-2 min-[480px]:grid-cols-4 md:grid-cols-6" data-editor-grid>
      {pictures.map((p, i) => {
        const up = p.upload;
        const failed = up?.status === 'failed';
        const working = !!up && !failed;
        return (
          <li key={p.key} className="relative aspect-square min-w-0" data-editor-picture={up ? 'pending' : 'stored'}>
            <button
              type="button"
              onClick={() => onOpen(i)}
              aria-label={fill(t.openPicture, { n: i + 1, total, name: p.name })}
              className="block h-full w-full overflow-hidden rounded-md bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              {p.preview ? (
                <img src={p.preview} alt="" data-editor-thumb="pending" className="h-full w-full object-cover" />
              ) : p.url ? (
                <img
                  src={requestImageSrc(p.url, 320)}
                  srcSet={requestImageSrcSet(p.url)}
                  sizes="(min-width: 768px) 120px, (min-width: 480px) 25vw, 34vw"
                  alt=""
                  loading="lazy"
                  decoding="async"
                  data-editor-thumb="stored"
                  className="h-full w-full object-cover"
                />
              ) : null}
            </button>
            {(p.primary || p.hasNote) && (
              <span className="pointer-events-none absolute start-1 top-1 flex gap-1" aria-hidden="true">
                {p.primary && (
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-gold text-accent-contrast" title={t.primaryBadge}>
                    <Star className="h-3 w-3" />
                  </span>
                )}
                {p.hasNote && (
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-raised text-text-secondary" title={t.hasNote}>
                    <StickyNote className="h-3 w-3" />
                  </span>
                )}
              </span>
            )}
            {working && (
              <span className="pointer-events-none absolute inset-x-1 bottom-1 h-1 overflow-hidden rounded-full bg-black/30" aria-hidden="true">
                <span
                  className="block h-full rounded-full bg-gold transition-[width] motion-reduce:transition-none"
                  style={{ width: `${Math.round(up && up.total > 0 ? (up.loaded / up.total) * 100 : 8)}%` }}
                />
              </span>
            )}
            {working && up && (
              <IconButton
                label={`${t.cancelUpload}: ${p.name}`}
                variant="secondary"
                icon={<X className="h-4 w-4" />}
                onClick={() => onCancel(up.key)}
                className="absolute end-0 top-0"
              />
            )}
            {failed && up && (
              <span className="absolute inset-0 flex items-center justify-center gap-1 rounded-md bg-black/55" data-editor-picture-failed>
                <IconButton label={`${t.retry}: ${p.name}`} variant="secondary" icon={<RotateCcw className="h-4 w-4" />} onClick={() => onRetry(up.key)} />
                <IconButton label={`${t.cancelUpload}: ${p.name}`} variant="secondary" icon={<X className="h-4 w-4" />} onClick={() => onCancel(up.key)} />
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
