/**
 * THE MEDIA LIBRARY v2 (docs/MERCHANT_PLATFORM_V2.md storefront B1, P5) — the
 * store owner's own uploads as the builder shows them: each file's weight,
 * where the store still shows it («مستخدم في …»), and a delete for a file
 * nothing uses.
 *
 *   - One shared cache of `GET /api/merchant/store/layout/media` rows, filled
 *     by every read of the library (the picker's pages, and the first page of
 *     a kind when a media control shows a key it has not seen), so a control
 *     can say «1.2 MB · مستخدم في: صفحة المتجر» without a request of its own.
 *   - THE WEIGHT RULE, before any upload: a file heavier than the slot's
 *     `max_bytes` (packages/storeLayout/src/blocks.ts MEDIA_CAPS) is refused
 *     here with the server's own sentence (LAYOUT_MEDIA_TOO_HEAVY, figures
 *     filled in) — the picker never sends what the draft save would refuse.
 *   - DELETE `/media/<key>` sets the ledger's `deleted_at` (the media sweep's
 *     contract); a file still in use answers MEDIA_IN_USE with `where`, and
 *     that sentence is shown, with the places named in the merchant's language.
 *
 * Nothing here holds a URL the merchant typed: a tile is a key from their own
 * ledger, drawn through `mediaSrc` (the schema's own check), and a pick hands
 * the block that key.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { Check, Trash2 } from 'lucide-react';
import { api } from '../../../lib/api';
import { IconButton } from '../../ui/Button';
import type { MediaKind } from '../../../../packages/storeLayout/src/refs';
import { storeLayoutApi, type MediaItem } from './storeLayoutApi';
import { codeOf, detailsOf, formatBytes, whereText } from './refusal';
import { fillSpeed, type MediaStrings } from './strings';
import { MediaThumb } from './pickers';

/** Where a library file is still shown (worker/lib/storeLayout.ts `mediaUsedIn`). */
export interface MediaUse {
  kind: string;
  id?: string;
  block_id?: string;
}

/** A library row as GET /media answers it since v2: the ledger's size and the file's uses. */
export interface LibraryItem extends MediaItem {
  byte_size: number;
  used_in: MediaUse[];
}

/** A v1 row (or a stand-in) read as v2: no size known, no use known. */
export function asLibraryItem(m: MediaItem & Partial<Pick<LibraryItem, 'byte_size' | 'used_in'>>): LibraryItem {
  return { ...m, byte_size: typeof m.byte_size === 'number' ? m.byte_size : 0, used_in: Array.isArray(m.used_in) ? m.used_in : [] };
}

// ------------------------------------------------------------------ cache

const items = new Map<string, LibraryItem>();
let version = 0;
const subs = new Set<() => void>();
const bump = () => {
  version += 1;
  subs.forEach((f) => f());
};

export function rememberItems(list: readonly LibraryItem[]): void {
  if (!list.length) return;
  for (const it of list) items.set(it.key, it);
  bump();
}

export function forgetItem(key: string): void {
  if (items.delete(key)) bump();
}

export function libraryItem(key: string): LibraryItem | null {
  return items.get(key) ?? null;
}

const firstPage: Partial<Record<MediaKind, Promise<void>>> = {};

/** The first page of a kind, read once per screen (a failed read may be tried again). */
export function loadFirstPage(kind: MediaKind): Promise<void> {
  const pending = firstPage[kind];
  if (pending) return pending;
  const p = storeLayoutApi
    .media(kind)
    .then((r) => rememberItems(r.items.map((m) => asLibraryItem(m))))
    .catch(() => {
      delete firstPage[kind];
    });
  firstPage[kind] = p;
  return p;
}

function subscribe(f: () => void) {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
}

/** What the library knows of `key` — asking for the kind's first page when it knows nothing yet. */
export function useLibraryItem(key: string, kind: MediaKind): LibraryItem | null {
  useSyncExternalStore(subscribe, () => version, () => version);
  useEffect(() => {
    if (key && !items.has(key)) void loadFirstPage(kind);
  }, [key, kind]);
  return key ? items.get(key) ?? null : null;
}

// ------------------------------------------------------------ the rules

/** Over the slot's cap? A slot without a cap, or a size the ledger never measured, is never over. */
export function overCap(bytes: number | null | undefined, max: number | undefined): boolean {
  return typeof max === 'number' && max > 0 && typeof bytes === 'number' && bytes > max;
}

/** LAYOUT_MEDIA_TOO_HEAVY's sentence with the figures: «الملف 6.2 MB يتجاوز حدّ هذا الموضع (1.5 MB)…». */
export function tooHeavyText(t: MediaStrings, size: number, max: number): string {
  return fillSpeed(t.library.tooHeavy, { size: formatBytes(size), max: formatBytes(max) });
}

/** The distinct places a file is used in, as the kinds `used_in` names. */
export function usedInKinds(uses: readonly MediaUse[]): string[] {
  return [...new Set(uses.map((u) => u.kind).filter((k) => typeof k === 'string' && k))];
}

/** «صفحة المتجر، منتج» — the one rule, shared with the builder's refusals (./refusal.ts). */
export { whereText };

/** A library refusal as the merchant reads it — never the server's English. */
export function libraryRefusal(e: unknown, t: MediaStrings, lang: string): string {
  const code = codeOf(e);
  const d = detailsOf(e);
  if (code === 'MEDIA_IN_USE') return fillSpeed(t.library.inUse, { where: whereText(t, Array.isArray(d.where) ? d.where : [], lang) });
  if (code === 'MEDIA_NOT_FOUND') return t.library.notFound;
  if (code === 'LAYOUT_MEDIA_TOO_HEAVY') return tooHeavyText(t, Number(d.size) || 0, Number(d.max) || 0);
  if (code === 'LAYOUT_POSTER_REQUIRED') return t.library.posterRequired;
  return t.library.deleteFailed;
}

/** DELETE /media/<key> — the key's slashes kept, each segment escaped. */
export function deleteLibraryFile(key: string) {
  const path = key.split('/').map(encodeURIComponent).join('/');
  return api.delete<{ success: true; key: string; deleted_at: string }>(`/api/merchant/store/layout/media/${path}`);
}

// ------------------------------------------------------------------ grid

export function MediaLibraryGrid({
  list,
  kind,
  value,
  maxBytes,
  t,
  lang,
  label,
  onPick,
  onHeavy,
  onDelete,
}: {
  list: readonly LibraryItem[];
  kind: MediaKind;
  value: string;
  /** The slot's cap: a heavier file is shown, marked, and not picked. */
  maxBytes?: number;
  t: MediaStrings;
  lang: string;
  label: string;
  onPick: (key: string) => void;
  onHeavy: (item: LibraryItem) => void;
  /** Asked for a file nothing uses; the caller confirms, deletes and reports. */
  onDelete: (item: LibraryItem) => void;
}) {
  /**
   * A PLAIN LIST OF BUTTONS (review 2026-09-30), not a listbox: a listbox owns
   * options alone (the delete buttons sat inside it) and walks them with the
   * arrow keys (it did not). Each picture is a button named by its PLACE —
   * «صورة 2 من 8 · 1 KB · غير مستخدم» — so two unused files of one size no
   * longer sound the same, and the chosen one is `aria-pressed`.
   */
  const total = list.length;
  return (
    <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4" aria-label={label} data-media-library={kind}>
      {list.map((m, i) => {
        const on = m.key === value;
        const heavy = overCap(m.byte_size, maxBytes);
        const kinds = usedInKinds(m.used_in);
        const size = m.byte_size > 0 ? formatBytes(m.byte_size) : '';
        const use = kinds.length ? fillSpeed(t.library.usedIn, { where: whereText(t, kinds, lang) }) : t.library.unused;
        const place = fillSpeed(kind === 'video' ? t.library.itemVideo : t.library.itemImage, { n: i + 1, total });
        return (
          <li key={m.key} className="min-w-0" data-media-item={m.key}>
            <button
              type="button"
              aria-pressed={on}
              aria-disabled={heavy || undefined}
              aria-label={[place, size, use, heavy ? t.library.tooHeavyShort : ''].filter(Boolean).join(' · ')}
              onClick={() => (heavy ? onHeavy(m) : onPick(m.key))}
              className={`relative block aspect-square w-full overflow-hidden rounded-xl border bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${on ? 'border-text-primary' : 'border-border-subtle'} ${heavy ? 'opacity-60' : ''}`}
            >
              <MediaThumb value={m.key} kind={kind} className="h-full w-full" />
              {on && (
                <span className="absolute end-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-gold text-accent-contrast">
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
              )}
            </button>
            <div className="mt-1 flex min-h-11 items-start gap-1">
              <div className="min-w-0 flex-1 pt-1">
                {size && (
                  <p className={`text-[11px] tabular-nums ${heavy ? 'text-warning' : 'text-text-secondary'}`} data-media-bytes>
                    <span dir="ltr">{size}</span>
                  </p>
                )}
                <p className="line-clamp-2 text-[11px] leading-snug text-text-muted" data-media-used={kinds.join(',') || 'none'}>
                  {heavy ? t.library.tooHeavyShort : use}
                </p>
              </div>
              {!kinds.length && (
                <IconButton icon={<Trash2 className="h-4 w-4" />} label={t.library.deleteLabel} onClick={() => onDelete(m)} data-media-delete={m.key} />
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The line a media control shows under its picture: the file's weight (and
 * the video's length), where else the store shows it, and — when the file is
 * heavier than this slot allows — the refusal sentence as the field's error.
 */
export function MediaMetaLine({ item, duration, t, lang }: { item: LibraryItem | null; duration: number | null; t: MediaStrings; lang: string }) {
  const parts: string[] = [];
  if (item && item.byte_size > 0) parts.push(formatBytes(item.byte_size));
  if (duration !== null && Number.isFinite(duration) && duration > 0) {
    const s = Math.round(duration);
    parts.push(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
  }
  const kinds = item ? usedInKinds(item.used_in) : [];
  if (!parts.length && !kinds.length) return null;
  return (
    // A span, not a paragraph: it sits inside the field's hint, which is one.
    <span className="block text-[11.5px] leading-snug text-text-muted" data-sd-media-meta="">
      {parts.length > 0 && (
        <span className="tabular-nums" dir="ltr">
          {parts.join(' · ')}
        </span>
      )}
      {kinds.length > 0 && (
        <span className="block">{fillSpeed(t.library.usedIn, { where: whereText(t, kinds, lang) })}</span>
      )}
    </span>
  );
}
