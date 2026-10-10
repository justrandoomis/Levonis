/**
 * THE BUILDER'S PICKERS — the only ways a product, a collection, a coupon, a
 * picture or a video gets into a block.
 *
 * Every choice offered is the merchant's OWN row, read from their own
 * endpoints (/api/merchant/products, /sections, /coupons, and the layout
 * route's /media, which lists only uploads a layout may hold). A picker hands
 * the block an ID or a storage KEY — never a URL, never a name — and the
 * server checks each against this store's rows again on save
 * (worker/lib/storeLayout.ts verifyLayoutRefs). There is no field to paste
 * an address for a picture: a file comes from the library or from an upload.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Check, ImagePlus, Loader2, Search, Upload, Video as VideoIcon } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { api, uploadFile } from '../../../lib/api';
import { merchantApi, type MerchantProduct } from '../../../lib/merchant';
import { Sheet } from '../../ui/Sheet';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Field';
import type { RefKind } from '../../../../packages/storeLayout/src/blocks';
import { mediaSrc, type MediaKind } from '../../../../packages/storeLayout/src/refs';
import type { BlockData } from '../../../../packages/storeLayout/src/data';
import { storeLayoutApi } from './storeLayoutApi';
import { builderRefusal, codeOf, detailsOf, formatBytes } from './refusal';
// Media library v2 (P5, storefront B1): weights, uses, delete, the slot's cap, the large-file door.
import { useToast } from '../../ui/Toast';
import { useConfirm } from '../../ui/ConfirmDialog';
import { UploadTile } from '../../upload/UploadTile';
import { pickUpload } from '../../../lib/uploadSession';
import { fillSpeed, useMediaStrings } from './strings';
import {
  asLibraryItem,
  deleteLibraryFile,
  forgetItem,
  libraryRefusal,
  MediaLibraryGrid,
  overCap,
  rememberItems,
  tooHeavyText,
  type LibraryItem,
} from './MediaLibrary';

// ------------------------------------------------------------ ref names

export interface RefItem {
  id: string;
  name: string;
  /** A second line: a price, a product count, a coupon's terms. */
  sub?: string;
  image?: string | null;
  /** Not offerable right now (an expired coupon): shown, not pickable. */
  off?: boolean;
}

/**
 * Names for the ids a layout holds, shared by every inspector on the screen.
 * Filled from the pickers' reads and from the preview's rows, so a chosen
 * product shows its name, not its id.
 */
const names: Record<RefKind, Map<string, RefItem>> = { product: new Map(), collection: new Map(), coupon: new Map() };
let namesVersion = 0;
const listeners = new Set<() => void>();
function remember(kind: RefKind, items: RefItem[]) {
  let changed = false;
  for (const it of items) {
    const was = names[kind].get(it.id);
    if (!was || was.name !== it.name || was.sub !== it.sub) {
      names[kind].set(it.id, it);
      changed = true;
    }
  }
  if (changed) {
    namesVersion++;
    listeners.forEach((l) => l());
  }
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useRefName(kind: RefKind, id: string): RefItem | null {
  useSyncExternalStore(subscribe, () => namesVersion);
  return id ? names[kind].get(id) ?? null : null;
}

/** Seed the names from the rows the preview already has. */
export function rememberFromData(data: BlockData, lang: string) {
  remember(
    'product',
    data.picked.map((p) => ({ id: p.id, name: lang === 'en' ? p.name || p.name_ar : p.name_ar || p.name, image: p.images[0] ?? null }))
  );
  if (data.collections) remember('collection', data.collections.map((c) => ({ id: c.id, name: lang === 'en' ? c.name || c.name_ar : c.name_ar || c.name })));
  remember('coupon', data.coupons.map((c) => ({ id: c.id, name: c.code })));
}

const productItem = (p: MerchantProduct, lang: string): RefItem => ({
  id: p.id,
  name: (lang === 'en' ? p.name || p.name_ar : p.name_ar || p.name) || p.slug,
  sub: `${Number(p.price_iqd).toLocaleString('en-US')} IQD`,
  image: p.images?.[0] ?? null,
});

async function loadRefs(kind: RefKind, q: string, cursor: string | null, lang: string, loc: (a: string, e: string) => string) {
  if (kind === 'product') {
    const qs = [`limit=40`, `sort=newest`, q ? `q=${encodeURIComponent(q)}` : '', cursor ? `cursor=${encodeURIComponent(cursor)}` : ''].filter(Boolean).join('&');
    const r = await api.get<{ products: MerchantProduct[]; next_cursor?: string | null }>(`/api/merchant/products?${qs}`);
    const items = r.products.map((p) => productItem(p, lang));
    remember('product', items);
    return { items, next: r.next_cursor ?? null };
  }
  if (kind === 'collection') {
    const r = await merchantApi.sections();
    const items = r.sections
      .filter((s) => s.active !== false)
      .map((s) => ({
        id: s.id,
        name: (lang === 'en' ? s.name || s.name_ar : s.name_ar || s.name) || s.id,
        sub: typeof s.product_count === 'number' ? loc(`${s.product_count} منتج`, `${s.product_count} products`) : undefined,
      }));
    remember('collection', items);
    return { items: q ? items.filter((i) => i.name.toLowerCase().includes(q.toLowerCase())) : items, next: null };
  }
  const r = await merchantApi.coupons();
  const now = Date.now();
  const items = r.coupons.map((c) => {
    const ended = !!c.ends_at && Date.parse(c.ends_at) < now;
    const usedUp = c.max_uses !== null && c.used_count >= c.max_uses;
    return {
      id: c.id,
      name: c.code,
      sub:
        (c.kind === 'percent' ? `${c.value}%` : `${Number(c.value).toLocaleString('en-US')} IQD`) +
        (!c.active || ended || usedUp ? ` · ${loc('غير فعّال', 'not active')}` : ''),
      off: !c.active || ended || usedUp,
    };
  });
  remember('coupon', items);
  return { items: q ? items.filter((i) => i.name.toLowerCase().includes(q.toLowerCase())) : items, next: null };
}

// ------------------------------------------------------------ ref picker

export function RefPicker({
  open,
  onClose,
  kind,
  selected,
  max = 1,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  kind: RefKind;
  selected: readonly string[];
  /** 1 = pick one and close; more = toggle up to `max`. */
  max?: number;
  onPick: (ids: string[]) => void;
}) {
  const { loc, lang } = useLanguage();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<RefItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [chosen, setChosen] = useState<string[]>([...selected]);
  const multiple = max > 1;

  useEffect(() => {
    if (open) setChosen([...selected]);
    // Only when opening: `selected` changes as the parent commits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError(null);
    const t = window.setTimeout(
      () => {
        loadRefs(kind, q.trim(), null, lang, loc)
          .then((r) => {
            if (!alive) return;
            setItems(r.items);
            setNext(r.next);
          })
          .catch((e) => alive && setError(e));
      },
      q ? 250 : 0
    );
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [open, kind, q, lang, loc]);

  const more = async () => {
    if (!next) return;
    const r = await loadRefs(kind, q.trim(), next, lang, loc);
    setItems((prev) => [...(prev ?? []), ...r.items.filter((x) => !prev?.some((y) => y.id === x.id))]);
    setNext(r.next);
  };

  const title =
    kind === 'product' ? loc('اختر منتجًا', 'Choose a product') : kind === 'collection' ? loc('اختر مجموعة', 'Choose a collection') : loc('اختر كوبونًا', 'Choose a coupon');
  const empty =
    kind === 'product'
      ? loc('لا منتجات بعد — أضف منتجاتك من «المنتجات».', 'No products yet — add them under «Products».')
      : kind === 'collection'
        ? loc('لا مجموعات بعد — أنشئها من «المجموعات».', 'No collections yet — create them under «Collections».')
        : loc('لا كوبونات بعد — أنشئها من «الكوبونات».', 'No coupons yet — create them under «Coupons».');

  const toggle = (it: RefItem) => {
    if (it.off) return;
    if (!multiple) {
      onPick([it.id]);
      onClose();
      return;
    }
    setChosen((c) => (c.includes(it.id) ? c.filter((x) => x !== it.id) : c.length >= max ? c : [...c, it.id]));
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      label={title}
      detents={['large']}
      panelClassName="sm:max-w-lg"
      header={
        <div className="px-4 pb-3 pt-1 space-y-3">
          <h2 className="text-[15px] font-bold text-text-primary">{title}</h2>
          {kind !== 'coupon' && (
            <div className="relative">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" aria-hidden="true" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={loc('ابحث بالاسم', 'Search by name')} aria-label={loc('بحث', 'Search')} className="ps-9" />
            </div>
          )}
        </div>
      }
      footer={
        multiple ? (
          <div className="flex items-center gap-3">
            <span className="text-[12.5px] text-text-muted tabular-nums">
              {chosen.length}/{max}
            </span>
            <Button
              variant="primary"
              className="ms-auto"
              onClick={() => {
                onPick(chosen);
                onClose();
              }}
            >
              {loc('تم', 'Done')}
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="px-2 pb-4">
        {error ? (
          <p className="px-2 py-6 text-center text-[13px] text-text-muted" role="alert">
            {builderRefusal(error, loc)}
          </p>
        ) : !items ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-text-muted" aria-hidden="true" />
          </div>
        ) : items.length === 0 ? (
          <p className="px-2 py-8 text-center text-[13px] text-text-muted">{q ? loc('لا نتائج.', 'No results.') : empty}</p>
        ) : (
          <ul role="listbox" aria-multiselectable={multiple || undefined} aria-label={title} className="space-y-1">
            {items.map((it) => {
              const on = chosen.includes(it.id);
              return (
                <li key={it.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={on}
                    aria-disabled={it.off || (!on && multiple && chosen.length >= max) || undefined}
                    onClick={() => toggle(it)}
                    className="lv-choice flex w-full items-center gap-3 px-3 py-2 text-start aria-disabled:opacity-50"
                    data-selected={on || undefined}
                  >
                    {kind === 'product' && (
                      <span className="size-10 shrink-0 overflow-hidden rounded-sm bg-surface-raised">
                        {it.image ? <img src={it.image} alt="" className="h-full w-full object-cover" loading="lazy" /> : null}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-semibold text-text-primary" dir="auto">
                        {it.name}
                      </span>
                      {it.sub && <span className="block truncate text-[11.5px] text-text-muted">{it.sub}</span>}
                    </span>
                    {on && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {next && (
          <div className="flex justify-center pt-3">
            <Button size="sm" variant="ghost" onClick={more}>
              {loc('المزيد', 'More')}
            </Button>
          </div>
        )}
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------- media picker

const ACCEPT: Record<MediaKind, string> = {
  image: 'image/jpeg,image/png,image/webp,image/gif,image/avif',
  video: 'video/mp4,video/webm',
};

export function MediaThumb({ value, kind, className = '', onDuration }: { value: string; kind: MediaKind; className?: string; onDuration?: (seconds: number) => void }) {
  const src = mediaSrc(value, kind);
  if (!src) return <span className={`block bg-surface-raised ${className}`} />;
  return kind === 'video' ? (
    <video
      src={src}
      muted
      playsInline
      preload="metadata"
      className={`block bg-black object-cover ${className}`}
      aria-hidden="true"
      onLoadedMetadata={onDuration ? (e) => onDuration(e.currentTarget.duration) : undefined}
    />
  ) : (
    <img src={src} alt="" className={`block object-cover ${className}`} loading="lazy" />
  );
}

/** PNG and JPEG are re-encoded (WebP, 2048 px) before they travel; everything else goes as picked. */
export function preparedBeforeUpload(file: Pick<File, 'type'>): boolean {
  return file.type === 'image/png' || file.type === 'image/jpeg';
}

type PickerPhase = 'idle' | 'preparing' | 'uploading' | 'poster';

const LIBRARY_CODES = new Set(['LAYOUT_MEDIA_TOO_HEAVY', 'LAYOUT_POSTER_REQUIRED', 'MEDIA_IN_USE', 'MEDIA_NOT_FOUND']);

export function MediaPicker({
  open,
  onClose,
  kind,
  value,
  onPick,
  maxBytes,
  wantPoster = false,
  posterMaxBytes,
}: {
  open: boolean;
  onClose: () => void;
  kind: MediaKind;
  value: string;
  /** The key picked — and, for a video whose poster slot was empty, the key of the still captured from it (W8). */
  onPick: (key: string, poster?: string) => void;
  /** The slot's weight cap (storefront L5): a heavier file is refused BEFORE its upload, with the server's own sentence. */
  maxBytes?: number;
  /**
   * The sibling poster slot is empty: a picked video gets a poster captured
   * from its frame at 0.5 s, uploaded, and handed back WITH the video's key —
   * one change, so neither overwrites the other.
   */
  wantPoster?: boolean;
  posterMaxBytes?: number;
}) {
  const { loc, lang } = useLanguage();
  const t = useMediaStrings();
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [phase, setPhase] = useState<PickerPhase>('idle');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [large, setLarge] = useState<File | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await storeLayoutApi.media(kind);
      const list = r.items.map((m) => asLibraryItem(m));
      rememberItems(list);
      setItems(list);
      setNext(r.next_cursor);
    } catch (e) {
      setError(e);
    }
  }, [kind]);

  useEffect(() => {
    if (open) {
      setUploadError(null);
      void load();
    }
  }, [open, load]);

  const more = async () => {
    if (!next) return;
    const r = await storeLayoutApi.media(kind, next);
    const list = r.items.map((m) => asLibraryItem(m));
    rememberItems(list);
    setItems((prev) => [...(prev ?? []), ...list]);
    setNext(r.next_cursor);
  };

  const resetInput = () => {
    if (file.current) file.current.value = '';
  };

  /** The key is the merchant's own; a video with an empty poster slot gets its still first. */
  const finish = async (key: string, local: Blob | null) => {
    let poster: string | undefined;
    if (kind === 'video' && wantPoster) {
      setPhase('poster');
      try {
        const { capturePoster } = await import('./MediaLibraryPoster');
        const still = await capturePoster(local ?? mediaSrc(key, 'video'), { maxBytes: posterMaxBytes });
        const r = still ? await uploadFile(still, 'community') : null;
        if (r?.key && still) {
          poster = r.key;
          rememberItems([asLibraryItem({ key: r.key, kind: 'image', mime: r.mime ?? still.type, width: r.width ?? null, height: r.height ?? null, created_at: new Date().toISOString(), byte_size: r.bytes ?? still.size, used_in: [] })]);
          toast.success(t.library.posterCaptured);
        } else {
          toast.error(t.library.posterFailed);
        }
      } catch {
        toast.error(t.library.posterFailed);
      }
    }
    setPhase('idle');
    onPick(key, poster);
    onClose();
  };

  const upload = async (picked: File | undefined) => {
    resetInput();
    if (!picked) return;
    setUploadError(null);
    const isVideo = picked.type.startsWith('video/');
    if (isVideo !== (kind === 'video')) {
      setUploadError(kind === 'video' ? t.library.kindVideo : t.library.kindImage);
      return;
    }
    let ready: File = picked;
    try {
      // What is WEIGHED is what will travel: PNG / JPEG are re-encoded first,
      // a GIF, WebP, AVIF or video goes exactly as picked.
      if (preparedBeforeUpload(picked)) {
        setPhase('preparing');
        const mod = await import('../../../lib/imagePreprocess');
        ready = (await mod.prepareUploadImage(picked, 'community')).file;
      }
      if (maxBytes && overCap(ready.size, maxBytes)) {
        setPhase('idle');
        setUploadError(tooHeavyText(t, ready.size, maxBytes));
        return;
      }
      if (pickUpload(ready) === 'session') {
        // Above 8 MiB: the resumable session, with its progress and «إلغاء» (UploadTile).
        setPhase('idle');
        setLarge(ready);
        return;
      }
      setPhase('uploading');
      // `community` is the merchant's own public prefix (merchants/<owner>/public/),
      // the only one a layout accepts; the server sniffs the bytes.
      const r = await uploadFile(ready, 'community');
      if ((r.mime ?? '').startsWith('video/') !== (kind === 'video')) {
        setPhase('idle');
        setUploadError(kind === 'video' ? t.library.kindVideo : t.library.kindImage);
        return;
      }
      rememberItems([asLibraryItem({ key: r.key, kind, mime: r.mime ?? '', width: r.width ?? null, height: r.height ?? null, created_at: new Date().toISOString(), byte_size: r.bytes ?? ready.size, used_in: [] })]);
      await finish(r.key, ready);
    } catch (e) {
      setPhase('idle');
      // The weight and poster refusals in the library's words (with the figures); every other upload refusal in the builder's.
      setUploadError(LIBRARY_CODES.has(codeOf(e)) ? libraryRefusal(e, t, lang) : builderRefusal(e, loc));
    }
  };

  const pickFromLibrary = (key: string) => {
    if (kind === 'video' && wantPoster) void finish(key, null);
    else {
      onPick(key);
      onClose();
    }
  };

  const remove = async (item: LibraryItem) => {
    setUploadError(null);
    const ok = await confirm({ title: t.library.deleteTitle, consequence: t.library.deleteBody, confirmLabel: t.library.deleteConfirm, destructive: true });
    if (!ok) return;
    try {
      await deleteLibraryFile(item.key);
      forgetItem(item.key);
      setItems((prev) => (prev ?? []).filter((x) => x.key !== item.key));
      toast.success(t.library.deleted);
    } catch (e) {
      // MEDIA_IN_USE names where the store still shows it, in the merchant's language —
      // and the tile learns it too (review 2026-09-30): it stops saying «غير مستخدم» and
      // stops offering a delete the server just refused. The sentence names the file.
      const d = detailsOf(e);
      if (codeOf(e) === 'MEDIA_IN_USE' && Array.isArray(d.used_in)) {
        const used = { ...item, used_in: d.used_in as LibraryItem['used_in'] };
        rememberItems([used]);
        setItems((prev) => (prev ?? []).map((x) => (x.key === item.key ? used : x)));
      }
      const place = items ? items.findIndex((x) => x.key === item.key) : -1;
      const which = place >= 0 ? `${fillSpeed(kind === 'video' ? t.library.itemVideo : t.library.itemImage, { n: place + 1, total: items!.length })} — ` : '';
      setUploadError(`${which}${libraryRefusal(e, t, lang)}`);
    }
  };

  const busy = phase !== 'idle' || !!large;
  const busyWords = phase === 'preparing' ? t.library.preparing : phase === 'poster' ? t.library.posterCapturing : t.library.uploading;
  const title = kind === 'video' ? loc('اختر فيديو', 'Choose a video', 'ڤیدیۆیەک هەڵبژێرە') : loc('اختر صورة', 'Choose a picture', 'وێنەیەک هەڵبژێرە');
  return (
    <Sheet
      open={open}
      onClose={onClose}
      label={title}
      detents={['large']}
      panelClassName="sm:max-w-lg"
      testId="sd-media-picker"
      header={
        <div className="flex items-center gap-3 px-4 pb-3 pt-1">
          <h2 className="text-[15px] font-bold text-text-primary">{title}</h2>
          <input ref={file} type="file" accept={ACCEPT[kind]} className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => void upload(e.target.files?.[0])} data-sd-media-file />
          <Button size="sm" variant="secondary" className="ms-auto" icon={<Upload className="h-4 w-4" aria-hidden="true" />} loading={busy} loadingLabel={busyWords} onClick={() => file.current?.click()}>
            {kind === 'video' ? loc('ارفع فيديو', 'Upload a video', 'ڤیدیۆیەک باربکە') : loc('ارفع صورة', 'Upload a picture', 'وێنەیەک باربکە')}
          </Button>
        </div>
      }
    >
      <div className="px-4 pb-5">
        {uploadError && (
          <p role="alert" className="lv-field-error mb-3" data-sd-media-error>
            {uploadError}
          </p>
        )}
        {large && (
          <div className="mb-3">
            <UploadTile
              file={large}
              purpose="community"
              onDone={(r) => {
                const done = large;
                setLarge(null);
                if (!r.key || (r.mime ?? '').startsWith('video/') !== (kind === 'video')) {
                  setUploadError(kind === 'video' ? t.library.kindVideo : t.library.kindImage);
                  return;
                }
                rememberItems([asLibraryItem({ key: r.key, kind, mime: r.mime, width: r.width ?? null, height: r.height ?? null, created_at: new Date().toISOString(), byte_size: r.bytes, used_in: [] })]);
                void finish(r.key, done);
              }}
              onCancel={() => setLarge(null)}
            />
          </div>
        )}
        <p className="mb-3 text-[12px] text-text-muted" data-sd-media-cap>
          {kind === 'video' ? `${t.library.videoNote} ` : ''}
          {maxBytes ? fillSpeed(t.library.cap, { max: formatBytes(maxBytes) }) : ''}
        </p>
        {error ? (
          <p className="py-6 text-center text-[13px] text-text-muted" role="alert">
            {builderRefusal(error, loc)}
          </p>
        ) : !items ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-text-muted" aria-hidden="true" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            {kind === 'video' ? <VideoIcon className="h-6 w-6 text-text-muted" aria-hidden="true" /> : <ImagePlus className="h-6 w-6 text-text-muted" aria-hidden="true" />}
            <p className="text-[13px] text-text-muted">{kind === 'video' ? loc('لم ترفع فيديو بعد.', 'You have not uploaded a video yet.', 'هێشتا هیچ ڤیدیۆیەکت بار نەکردووە.') : loc('لم ترفع صورًا بعد.', 'You have not uploaded pictures yet.', 'هێشتا هیچ وێنەیەکت بار نەکردووە.')}</p>
          </div>
        ) : (
          <MediaLibraryGrid
            list={items}
            kind={kind}
            value={value}
            maxBytes={maxBytes}
            t={t}
            lang={lang}
            label={title}
            onPick={pickFromLibrary}
            onHeavy={(m) => maxBytes && setUploadError(tooHeavyText(t, m.byte_size, maxBytes))}
            onDelete={(m) => void remove(m)}
          />
        )}
        {next && (
          <div className="flex justify-center pt-3">
            <Button size="sm" variant="ghost" onClick={more}>
              {loc('المزيد', 'More', 'زیاتر')}
            </Button>
          </div>
        )}
      </div>
      {confirmDialog}
    </Sheet>
  );
}

/** Preload the names a layout's pickers show, once per screen. */
export function usePreloadRefNames(kinds: readonly RefKind[]) {
  const { lang, loc } = useLanguage();
  const key = useMemo(() => [...new Set(kinds)].sort().join(','), [kinds]);
  useEffect(() => {
    if (!key) return;
    for (const k of key.split(',') as RefKind[]) loadRefs(k, '', null, lang, loc).catch(() => {});
  }, [key, lang, loc]);
}
