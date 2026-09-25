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
import { storeLayoutApi, type MediaItem } from './storeLayoutApi';
import { builderRefusal } from './refusal';

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
                      <span className="h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-surface-raised">
                        {it.image ? <img src={it.image} alt="" className="h-full w-full object-cover" loading="lazy" /> : null}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-semibold text-text-primary" dir="auto">
                        {it.name}
                      </span>
                      {it.sub && <span className="block truncate text-[11.5px] text-text-muted">{it.sub}</span>}
                    </span>
                    {on && <Check className="h-4 w-4 shrink-0 text-gold" aria-hidden="true" />}
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

export function MediaThumb({ value, kind, className = '' }: { value: string; kind: MediaKind; className?: string }) {
  const src = mediaSrc(value, kind);
  if (!src) return <span className={`block bg-surface-raised ${className}`} />;
  return kind === 'video' ? (
    <video src={src} muted playsInline preload="metadata" className={`block bg-black object-cover ${className}`} aria-hidden="true" />
  ) : (
    <img src={src} alt="" className={`block object-cover ${className}`} loading="lazy" />
  );
}

export function MediaPicker({
  open,
  onClose,
  kind,
  value,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  kind: MediaKind;
  value: string;
  onPick: (key: string) => void;
}) {
  const { loc } = useLanguage();
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await storeLayoutApi.media(kind);
      setItems(r.items);
      setNext(r.next_cursor);
    } catch (e) {
      setError(e);
    }
  }, [kind]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const more = async () => {
    if (!next) return;
    const r = await storeLayoutApi.media(kind, next);
    setItems((prev) => [...(prev ?? []), ...r.items]);
    setNext(r.next_cursor);
  };

  const upload = async (f: File | undefined) => {
    if (!f) return;
    setUploading(true);
    setUploadError(null);
    try {
      // `community` is the merchant's own public prefix (merchants/<owner>/public/),
      // the only one a layout accepts; the server sniffs the bytes.
      const r = await uploadFile(f, 'community');
      const isVideo = (r.mime ?? '').startsWith('video/');
      if (isVideo !== (kind === 'video')) {
        setUploadError(kind === 'video' ? loc('هذا ليس فيديو.', 'That is not a video.') : loc('هذه ليست صورة.', 'That is not a picture.'));
        return;
      }
      onPick(r.key);
      onClose();
    } catch (e) {
      setUploadError(builderRefusal(e, loc));
    } finally {
      setUploading(false);
      if (file.current) file.current.value = '';
    }
  };

  const title = kind === 'video' ? loc('اختر فيديو', 'Choose a video') : loc('اختر صورة', 'Choose a picture');
  return (
    <Sheet
      open={open}
      onClose={onClose}
      label={title}
      detents={['large']}
      panelClassName="sm:max-w-lg"
      header={
        <div className="flex items-center gap-3 px-4 pb-3 pt-1">
          <h2 className="text-[15px] font-bold text-text-primary">{title}</h2>
          <input ref={file} type="file" accept={ACCEPT[kind]} className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => void upload(e.target.files?.[0])} />
          <Button size="sm" variant="secondary" className="ms-auto" icon={<Upload className="h-4 w-4" aria-hidden="true" />} loading={uploading} loadingLabel={loc('جارٍ الرفع…', 'Uploading…')} onClick={() => file.current?.click()}>
            {kind === 'video' ? loc('ارفع فيديو', 'Upload a video') : loc('ارفع صورة', 'Upload a picture')}
          </Button>
        </div>
      }
    >
      <div className="px-4 pb-5">
        {uploadError && (
          <p role="alert" className="lv-field-error mb-3">
            {uploadError}
          </p>
        )}
        {kind === 'video' && <p className="mb-3 text-[12px] text-text-muted">{loc('MP4 أو WebM حتى 40 ميغابايت. يُعرض من متجرك مباشرة، بلا تضمين خارجي.', 'MP4 or WebM up to 40 MB. Played from your store directly, never embedded.')}</p>}
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
            <p className="text-[13px] text-text-muted">{kind === 'video' ? loc('لم ترفع فيديو بعد.', 'You have not uploaded a video yet.') : loc('لم ترفع صورًا بعد.', 'You have not uploaded pictures yet.')}</p>
          </div>
        ) : (
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4" role="listbox" aria-label={title}>
            {items.map((m) => {
              const on = m.key === value;
              return (
                <li key={m.key}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={on}
                    aria-label={kind === 'video' ? loc('فيديو', 'Video') : loc('صورة', 'Picture')}
                    onClick={() => {
                      onPick(m.key);
                      onClose();
                    }}
                    className={`relative block aspect-square w-full overflow-hidden rounded-xl border bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${on ? 'border-gold' : 'border-border-subtle'}`}
                  >
                    <MediaThumb value={m.key} kind={kind} className="h-full w-full" />
                    {on && (
                      <span className="absolute end-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-gold text-accent-contrast">
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      </span>
                    )}
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

/** Preload the names a layout's pickers show, once per screen. */
export function usePreloadRefNames(kinds: readonly RefKind[]) {
  const { lang, loc } = useLanguage();
  const key = useMemo(() => [...new Set(kinds)].sort().join(','), [kinds]);
  useEffect(() => {
    if (!key) return;
    for (const k of key.split(',') as RefKind[]) loadRefs(k, '', null, lang, loc).catch(() => {});
  }, [key, lang, loc]);
}
