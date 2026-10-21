/**
 * THE PICTURES, FULL SIZE, IN THE PAGE (plan P1-06; design §5.2, critique 14).
 *
 * A modal window over the editor, no library: the picture as large as the
 * screen allows (a sized copy from the authorised route, `?w=`, never the
 * phone original; a picture still on its way from its device preview), with
 *
 *   «الصورة السابقة» / «الصورة التالية» — the arrows point the way the
 *     reading goes, and so do the keys: in Arabic and Sorani ← is the next
 *     picture, in English →; Home and End jump; Escape closes, and focus
 *     returns to the tile that opened it;
 *   a swipe, ONLY at 1× (zoomed in, a drag moves the picture instead), its
 *     direction mirrored in right-to-left exactly like the keys;
 *   a double tap (or double click) for 2×, and «كبّر» / «صغّر» for keys.
 *     The picture takes its own touches (`touch-action: none`) so a pinch
 *     never zooms the page behind the window;
 *   under it, the picture’s name, its note and its actions. When the note
 *     field takes focus the picture shrinks to a strip, so the keyboard never
 *     covers the field.
 */
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Star, Trash2, X, ZoomIn, ZoomOut } from 'lucide-react';
import { Overlay } from '../../../ui/Overlay';
import { Button, IconButton } from '../../../ui/Button';
import { Textarea } from '../../../ui/Field';
import { useMediaQuery } from '../../../../lib/useMediaQuery';
import { requestImageSrc, requestViewerSrcSet } from '../RequestFileThumbs';
import { LIMITS } from './state';
import { fill, type EditorStrings } from './strings';

export interface ViewerPicture {
  key: string;
  name: string;
  /** A stored picture’s authorised route. */
  url: string | null;
  /** A picture still on its way: its `blob:` preview. */
  preview: string | null;
  note: string;
  primary: boolean;
  /** Notes and the main mark belong to a stored source. */
  stored: boolean;
}

export const SWIPE_PX = 48;

/** Which way a key or a swipe moves through the pictures: +1 next, -1 previous, 0 none. */
export function stepFor(input: { key?: string; dx?: number }, dir: 'rtl' | 'ltr'): -1 | 0 | 1 {
  if (input.key === 'ArrowRight') return dir === 'rtl' ? -1 : 1;
  if (input.key === 'ArrowLeft') return dir === 'rtl' ? 1 : -1;
  if (typeof input.dx === 'number' && Math.abs(input.dx) >= SWIPE_PX) {
    // A finger moving towards the reading START brings the next picture.
    const towardsStart = dir === 'rtl' ? input.dx > 0 : input.dx < 0;
    return towardsStart ? 1 : -1;
  }
  return 0;
}

export function ImageViewer({
  open,
  pictures,
  index,
  onIndex,
  onClose,
  onNote,
  onPrimary,
  onRemove,
  dir,
  t,
}: {
  open: boolean;
  pictures: ViewerPicture[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onNote: (key: string, note: string) => void;
  onPrimary: (key: string) => void;
  onRemove: (key: string) => void;
  dir: 'rtl' | 'ltr';
  t: EditorStrings;
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [noteFocused, setNoteFocused] = useState(false);
  const short = useMediaQuery('(max-height: 480px)');
  const pointer = useRef<{ id: number; x: number; y: number; px: number; py: number; moved: boolean } | null>(null);
  const lastTap = useRef<{ at: number; x: number; y: number } | null>(null);
  const total = pictures.length;
  const at = Math.min(Math.max(0, index), Math.max(0, total - 1));
  const pic = pictures[at];

  // A new picture starts whole.
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [at, open]);

  if (!pic) return null;
  const go = (step: number) => {
    if (!step || total < 2) return;
    onIndex((at + step + total) % total);
  };
  const toggleZoom = () => {
    setZoom((z) => (z > 1 ? 1 : 2));
    setPan({ x: 0, y: 0 });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') return;
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      onIndex(e.key === 'Home' ? 0 : total - 1);
      return;
    }
    const step = stepFor({ key: e.key }, dir);
    if (step) {
      e.preventDefault();
      go(step);
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    pointer.current = { id: e.pointerId, x: e.clientX, y: e.clientY, px: pan.x, py: pan.y, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pointer.current;
    if (!p || p.id !== e.pointerId) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) p.moved = true;
    if (zoom > 1) {
      const box = e.currentTarget.getBoundingClientRect();
      const limitX = (box.width * (zoom - 1)) / 2;
      const limitY = (box.height * (zoom - 1)) / 2;
      setPan({ x: Math.max(-limitX, Math.min(limitX, p.px + dx)), y: Math.max(-limitY, Math.min(limitY, p.py + dy)) });
    }
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pointer.current;
    pointer.current = null;
    if (!p || p.id !== e.pointerId) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (zoom === 1 && p.moved && Math.abs(dx) > Math.abs(dy)) {
      go(stepFor({ dx }, dir));
      return;
    }
    if (p.moved || e.pointerType === 'mouse') return;
    // A double tap: two taps close in time and place.
    const now = Date.now();
    const last = lastTap.current;
    if (last && now - last.at < 320 && Math.abs(e.clientX - last.x) < 24 && Math.abs(e.clientY - last.y) < 24) {
      lastTap.current = null;
      toggleZoom();
    } else {
      lastTap.current = { at: now, x: e.clientX, y: e.clientY };
    }
  };

  const src = pic.preview ?? (pic.url ? requestImageSrc(pic.url, 1280) : '');
  const srcSet = pic.preview ? undefined : pic.url ? requestViewerSrcSet(pic.url) : undefined;
  const Prev = dir === 'rtl' ? ChevronRight : ChevronLeft;
  const Next = dir === 'rtl' ? ChevronLeft : ChevronRight;

  return (
    <Overlay
      open={open}
      onClose={onClose}
      label={t.viewerLabel}
      placement="center"
      solid
      className="!p-0"
      panelClassName="flex h-[100dvh] w-full !rounded-none bg-canvas text-text-primary"
      testId="image-viewer"
    >
      <div className="flex h-full w-full flex-col" onKeyDown={onKeyDown} data-image-viewer={pic.key} dir={dir}>
        <div className="flex items-center gap-1 px-2 pt-[max(0.25rem,env(safe-area-inset-top))]">
          <IconButton label={t.close} icon={<X className="h-5 w-5" />} onClick={onClose} />
          <p className="min-w-0 flex-1 text-center text-[13px] font-semibold tabular-nums text-text-secondary" aria-live="polite" data-viewer-position>
            <bdi dir="ltr">{fill(t.position, { n: at + 1, total })}</bdi>
          </p>
          <IconButton label={zoom > 1 ? t.zoomOut : t.zoomIn} icon={zoom > 1 ? <ZoomOut className="h-5 w-5" /> : <ZoomIn className="h-5 w-5" />} onClick={toggleZoom} />
        </div>

        <div
          className={`relative flex min-h-0 items-center justify-center overflow-hidden ${noteFocused ? 'h-24 shrink-0' : 'flex-1'}`}
          style={{ touchAction: 'none' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (pointer.current = null)}
          onDoubleClick={toggleZoom}
          data-viewer-stage
        >
          <img
            key={pic.key}
            src={src}
            srcSet={srcSet}
            sizes="100vw"
            alt={pic.name}
            decoding="async"
            draggable={false}
            data-viewer-image={pic.preview ? 'pending' : 'stored'}
            className="max-h-full max-w-full select-none object-contain"
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: 'center' }}
          />
          {total > 1 && (
            <>
              <IconButton
                label={t.prevPicture}
                variant="secondary"
                icon={<Prev className="h-5 w-5" />}
                onClick={() => go(-1)}
                className="absolute start-1 top-1/2 -translate-y-1/2"
                data-viewer-prev
              />
              <IconButton
                label={t.nextPicture}
                variant="secondary"
                icon={<Next className="h-5 w-5" />}
                onClick={() => go(1)}
                className="absolute end-1 top-1/2 -translate-y-1/2"
                data-viewer-next
              />
            </>
          )}
        </div>

        <div className={`border-t border-border-subtle px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] ${short && !noteFocused ? 'pt-2' : 'pt-3'}`}>
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-[13px] font-semibold" title={pic.name}>
              <bdi dir="ltr">{pic.name}</bdi>
            </p>
            {pic.primary && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-gold/15 px-2 py-0.5 text-[11px] font-bold text-text-primary">
                <Star aria-hidden="true" className="h-3 w-3" />
                {t.primaryBadge}
              </span>
            )}
            {!pic.stored && <span className="shrink-0 text-[11px] text-text-muted">{t.pendingBadge}</span>}
          </div>
          {pic.stored && !short && (
            <div className="mt-2">
              <label className="mb-1 block text-[12px] font-semibold text-text-secondary" htmlFor={`viewer-note-${pic.key}`}>
                {t.noteLabel}
              </label>
              <Textarea
                id={`viewer-note-${pic.key}`}
                rows={2}
                maxLength={LIMITS.sourceNoteMax}
                dir="auto"
                value={pic.note}
                onChange={(e) => onNote(pic.key, e.target.value)}
                onFocus={() => setNoteFocused(true)}
                onBlur={() => setNoteFocused(false)}
                aria-describedby={`viewer-note-hint-${pic.key}`}
              />
              <p id={`viewer-note-hint-${pic.key}`} className="mt-1 text-[11.5px] text-text-muted">
                {t.noteHint}
              </p>
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {pic.stored && short && (
              <Button size="sm" variant="secondary" onClick={() => setNoteFocused((v) => !v)} aria-expanded={noteFocused}>
                {pic.note ? t.noteEdit : t.noteAdd}
              </Button>
            )}
            {pic.stored && !pic.primary && (
              <Button size="sm" variant="secondary" icon={<Star aria-hidden="true" className="h-4 w-4" />} onClick={() => onPrimary(pic.key)}>
                {t.makePrimary}
              </Button>
            )}
            <Button size="sm" variant="ghost" className="text-danger" icon={<Trash2 aria-hidden="true" className="h-4 w-4" />} onClick={() => onRemove(pic.key)}>
              {t.remove}
            </Button>
          </div>
          {pic.stored && short && noteFocused && (
            <Textarea
              className="mt-2"
              rows={2}
              maxLength={LIMITS.sourceNoteMax}
              dir="auto"
              value={pic.note}
              aria-label={t.noteLabel}
              onChange={(e) => onNote(pic.key, e.target.value)}
            />
          )}
        </div>
      </div>
    </Overlay>
  );
}
