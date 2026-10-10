/**
 * THE STORE'S COLLECTIONS (the «الأقسام» tab) — W2-F.
 *
 * A section IS a collection (docs/DECISIONS.md): the same rows, the same ids,
 * the same storefront links. Two families:
 *   · MANUAL — the merchant chooses the products and their ORDER (arranged
 *     here with two buttons per product; the storefront follows the order);
 *   · AUTOMATIC — «مميّزة» (the products marked featured), «وصل حديثًا»
 *     (added in the last 30 days), «الأكثر مبيعًا» (by sales) — computed by
 *     the server every time, one of each per store.
 * The shelf order, the on/off switch and the name are the merchant's for
 * both. Deleting asks in the shared dialog; products are never deleted with it.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ImageOff, ImagePlus, ListOrdered, Loader2, MoreHorizontal, Pencil, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { uploadFile } from '../../../lib/api';
import { Button, IconButton } from '../../ui/Button';
import { Field, Input } from '../../ui/Field';
import { Switch } from '../../ui/Switch';
import { Menu } from '../../ui/Menu';
import { Badge } from '../../ui/Badge';
import { Sheet } from '../../ui/Sheet';
import { ErrorState, EmptyState } from '../../ui/AsyncStates';
import { ListRowsSkeleton } from '../../ui/DashboardSkeletons';
import { useConfirm } from '../../ui/ConfirmDialog';
import { useToast } from '../../ui/Toast';
import { catalogApi, type CatalogProduct, type Collection, type CollectionKind } from './catalogApi';
import { catalogStrings, type Loc } from './strings';
import { readRefusal } from './parts';

/** The picture types the picker offers — spelled out, as the catalogue's MediaEditor does (a source-level `/*` reads as a comment to the pins). */
const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/avif';

function words(loc: Loc) {
  return {
    title: loc('الأقسام والمجموعات', 'Sections & collections'), // OWNER: Sorani to be written by hand.
    lead: loc(
      'الأقسام ترتّب منتجاتك في واجهة متجرك. اليدوية تختار منتجاتها وترتيبها؛ التلقائية تمتلئ وحدها.',
      'Sections organise your storefront. Manual ones hold the products you choose, in your order; automatic ones fill themselves.'
    ), // OWNER: Sorani to be written by hand.
    newName: loc('اسم قسم جديد', 'New section name'), // OWNER: Sorani to be written by hand.
    add: loc('إضافة القسم', 'Add section', 'زیادکردنی بەش'),
    automatic: loc('تلقائي', 'Automatic'), // OWNER: Sorani to be written by hand.
    addAutomatic: loc('أقسام تلقائية', 'Automatic sections'), // OWNER: Sorani to be written by hand.
    kindName: (k: CollectionKind) =>
      k === 'featured' ? loc('منتجات مميّزة', 'Featured') // OWNER: Sorani to be written by hand.
        : k === 'new_arrivals' ? loc('وصل حديثًا', 'New arrivals') // OWNER: Sorani to be written by hand.
          : k === 'best_sellers' ? loc('الأكثر مبيعًا', 'Best sellers', 'زۆرترین فرۆش')
            : loc('يدوي', 'Manual'), // OWNER: Sorani to be written by hand.
    kindHint: (k: CollectionKind) =>
      k === 'featured' ? loc('ما تميّزه من منتجاتك.', 'The products you mark as featured.') // OWNER: Sorani to be written by hand.
        : k === 'new_arrivals' ? loc('ما أضفته في آخر 30 يومًا.', 'What you added in the last 30 days.') // OWNER: Sorani to be written by hand.
          : loc('مرتبة حسب المبيعات.', 'Ordered by sales.'), // OWNER: Sorani to be written by hand.
    none: loc('لا توجد أقسام بعد', 'No sections yet', 'هێشتا بەش نییە'),
    count: (n: number) => loc(`${n} منتج`, `${n} products`, `${n} بەرهەم`),
    visible: loc('ظاهر في المتجر', 'Shown on the storefront'), // OWNER: Sorani to be written by hand.
    moveUp: loc('نقل للأعلى', 'Move up'), // OWNER: Sorani to be written by hand.
    moveDown: loc('نقل للأسفل', 'Move down'), // OWNER: Sorani to be written by hand.
    rename: loc('إعادة التسمية', 'Rename'), // OWNER: Sorani to be written by hand.
    arrange: loc('ترتيب المنتجات', 'Arrange products'), // OWNER: Sorani to be written by hand.
    actions: loc('إجراءات', 'Actions', 'کردارەکان'),
    deleteTitle: (n: string) => loc(`حذف «${n}»؟`, `Delete “${n}”?`), // OWNER: Sorani to be written by hand.
    deleteConsequence: loc('يُحذف القسم فقط؛ منتجاته تبقى في متجرك.', 'Only the section goes; its products stay in your store.'), // OWNER: Sorani to be written by hand.
    arrangeLead: loc('الترتيب هنا هو ترتيبها في واجهة المتجر. أضف منتجات من شاشة المنتج أو من الإجراءات الجماعية.', 'This order is the storefront’s. Add products from the product editor or the bulk actions.'), // OWNER: Sorani to be written by hand.
    removeFrom: (n: string) => loc(`إزالة «${n}» من القسم`, `Remove “${n}” from the section`), // OWNER: Sorani to be written by hand.
    saveOrder: loc('حفظ الترتيب', 'Save order'), // OWNER: Sorani to be written by hand.
    saved: loc('حُفظ.', 'Saved.'), // OWNER: Sorani to be written by hand.
    empty: loc('لا منتجات في هذا القسم بعد.', 'No products in this section yet.'), // OWNER: Sorani to be written by hand.
    // THE COVER (storefront L9) — the picture the storefront's collection
    // cards show; written in all three languages (DECISIONS row 169).
    addCover: loc('أضف صورة للقسم', 'Add a section picture', 'وێنەیەک بۆ بەشەکە زیاد بکە'),
    changeCover: loc('تغيير صورة القسم', 'Change the section picture', 'گۆڕینی وێنەی بەشەکە'),
    removeCover: loc('إزالة صورة القسم', 'Remove the section picture', 'لابردنی وێنەی بەشەکە'),
    coverUploading: loc('جارٍ رفع الصورة…', 'Uploading the picture…', 'وێنەکە بار دەکرێت…'),
    coverFailed: loc('تعذّر رفع صورة القسم.', 'The section picture could not be uploaded.', 'وێنەی بەشەکە بار نەکرا.'),
    coverOnlyImages: loc('الصور فقط.', 'Pictures only.', 'تەنها وێنە.'),
  };
}

/**
 * The cover control on a collection row: the picture itself when there is
 * one, a placeholder when there is not; a tap picks a file. The upload is the
 * merchant's community picture (`uploadFile(file, 'community')`) and its key
 * goes through the same PATCH every other field uses — the server keeps only
 * a key this owner uploaded (`MEDIA_NOT_OWNED` otherwise).
 */
function CoverControl({
  collection,
  busy,
  disabled,
  labels,
  onPick,
}: {
  collection: Collection;
  busy: boolean;
  disabled: boolean;
  labels: { add: string; change: string; uploading: string };
  onPick: (file: File) => void;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const label = busy ? labels.uploading : collection.image_url ? labels.change : labels.add;
  return (
    <>
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={disabled || busy}
        aria-label={label}
        aria-busy={busy}
        title={label}
        className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border-subtle bg-surface text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
        data-collection-cover={collection.image_url ? 'set' : 'empty'}
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : collection.image_url ? (
          <img src={collection.image_url} alt="" className="h-full w-full object-cover" />
        ) : (
          <ImagePlus className="h-4 w-4" aria-hidden="true" />
        )}
      </button>
      <input
        ref={input}
        type="file"
        accept={IMAGE_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = '';
        }}
      />
    </>
  );
}

export function CollectionsManager({ canSell, autoFocusCreate = false }: { canSell: boolean; /** The workspace's «new section» door (W3-A): start in the name field. */ autoFocusCreate?: boolean }) {
  const { loc, lang } = useLanguage();
  const s = catalogStrings(loc);
  const w = words(loc);
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const [items, setItems] = useState<Collection[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState('');
  const [renaming, setRenaming] = useState<Collection | null>(null);
  const [arranging, setArranging] = useState<Collection | null>(null);

  const load = useCallback(() => {
    setError(null);
    catalogApi
      .collections()
      .then((d) => setItems(d.collections))
      .catch((e) => setError(e));
  }, []);
  useEffect(load, [load]);

  const label = (c: Collection) => (lang === 'en' ? c.name || c.name_ar : c.name_ar || c.name);
  const fail = (e: unknown) => toast.error(readRefusal(e, loc, s.saveFailed).message || s.saveFailed);

  async function create(kind: CollectionKind, nameText: string) {
    setBusy(`new-${kind}`);
    try {
      await catalogApi.createCollection({ name: nameText, kind, sort_order: items?.length ?? 0 });
      if (kind === 'manual') setName('');
      load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy('');
    }
  }

  async function patch(c: Collection, body: Partial<Collection>) {
    setBusy(c.id);
    try {
      await catalogApi.updateCollection(c.id, body);
      load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy('');
    }
  }

  /** The cover (L9): upload, then the key through the existing PATCH; '' clears it. */
  async function setCover(c: Collection, file: File | null) {
    setBusy(`cover-${c.id}`);
    try {
      if (file && !file.type.startsWith('image/')) {
        toast.error(w.coverOnlyImages);
        return;
      }
      const key = file ? (await uploadFile(file, 'community')).key : '';
      await catalogApi.updateCollection(c.id, { image_key: key });
      load();
    } catch (e) {
      toast.error(readRefusal(e, loc, w.coverFailed).message || w.coverFailed);
    } finally {
      setBusy('');
    }
  }

  async function move(i: number, dir: -1 | 1) {
    if (!items) return;
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    setItems(next);
    try {
      await Promise.all(next.map((c, idx) => (c.sort_order === idx ? null : catalogApi.updateCollection(c.id, { sort_order: idx }))));
    } catch (e) {
      fail(e);
    }
    load();
  }

  async function remove(c: Collection) {
    const ok = await confirm({ title: w.deleteTitle(label(c)), consequence: w.deleteConsequence, confirmLabel: s.remove, cancelLabel: s.cancel, destructive: true });
    if (!ok) return;
    try {
      await catalogApi.deleteCollection(c.id);
      load();
    } catch (e) {
      fail(e);
    }
  }

  const have = new Set((items ?? []).map((c) => c.kind));
  const missing = (['featured', 'new_arrivals', 'best_sellers'] as CollectionKind[]).filter((k) => !have.has(k));

  return (
    <div className="space-y-4" data-collections-manager>
      <div>
        <h2 className="text-[20px] font-bold text-text-primary">{w.title}</h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-text-muted">{w.lead}</p>
      </div>

      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create('manual', name.trim());
        }}
      >
        <Field label={w.newName} className="min-w-0 flex-1">
          <Input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} disabled={!canSell} autoFocus={autoFocusCreate && canSell} />
        </Field>
        <Button type="submit" variant="primary" icon={<Plus className="h-4 w-4" />} loading={busy === 'new-manual'} disabled={!canSell || !name.trim()}>
          {w.add}
        </Button>
      </form>

      {missing.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12.5px] text-text-muted">{w.addAutomatic}:</span>
          {missing.map((k) => (
            <Button key={k} size="sm" variant="secondary" icon={<Sparkles className="h-4 w-4" />} disabled={!canSell} loading={busy === `new-${k}`} onClick={() => create(k, w.kindName(k))}>
              {w.kindName(k)}
            </Button>
          ))}
        </div>
      )}

      {error && !items ? (
        <ErrorState error={error} onRetry={load} compact />
      ) : !items ? (
        <ListRowsSkeleton />
      ) : !items.length ? (
        <EmptyState title={w.none} compact />
      ) : (
        // One tray, flat rows (build plan §5 DataList): the collections are a list, not a stack of cards.
        <ul className="lv-surface divide-y divide-border-subtle">
          {items.map((c, i) => (
            <li key={c.id} className="flex items-center gap-2 px-3 py-2.5" data-collection={c.kind}>
              <CoverControl
                collection={c}
                busy={busy === `cover-${c.id}`}
                disabled={!canSell}
                labels={{ add: w.addCover, change: w.changeCover, uploading: w.coverUploading }}
                onPick={(file) => setCover(c, file)}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-semibold text-text-primary">{label(c)}</p>
                <p className="flex min-w-0 items-center gap-1.5 text-[12px] text-text-muted tabular-nums">
                  {c.kind !== 'manual' && <Badge tone="info" className="shrink-0">{w.automatic}</Badge>}
                  <span className="truncate">{w.count(c.product_count ?? 0)}{c.kind !== 'manual' ? ` · ${w.kindHint(c.kind)}` : ''}</span>
                </p>
              </div>
              <Switch checked={c.active} onChange={(on) => patch(c, { active: on })} label={<span className="sr-only">{w.visible}</span>} busy={busy === c.id} />
              <IconButton label={w.moveUp} icon={<ArrowUp className="h-4 w-4" />} disabled={i === 0} onClick={() => move(i, -1)} />
              <IconButton label={w.moveDown} icon={<ArrowDown className="h-4 w-4" />} disabled={i === items.length - 1} onClick={() => move(i, 1)} />
              <Menu
                label={w.actions}
                items={[
                  { id: 'rename', label: w.rename, icon: <Pencil className="h-4 w-4" />, onSelect: () => setRenaming(c) },
                  ...(c.kind === 'manual' ? [{ id: 'arrange', label: w.arrange, icon: <ListOrdered className="h-4 w-4" />, onSelect: () => setArranging(c) }] : []),
                  ...(c.image_url ? [{ id: 'cover-remove', label: w.removeCover, icon: <ImageOff className="h-4 w-4" />, onSelect: () => void setCover(c, null) }] : []),
                  { id: 'sep', separator: true as const },
                  { id: 'delete', label: s.remove, icon: <Trash2 className="h-4 w-4" />, destructive: true, onSelect: () => remove(c) },
                ]}
                trigger={(props) => <IconButton {...props} label={`${w.actions} — ${label(c)}`} icon={<MoreHorizontal className="h-4 w-4" />} />}
              />
            </li>
          ))}
        </ul>
      )}

      <RenameSheet
        collection={renaming}
        onClose={() => setRenaming(null)}
        onSave={async (body) => {
          if (renaming) await patch(renaming, body);
          setRenaming(null);
        }}
      />
      <ArrangeSheet collection={arranging} onClose={() => setArranging(null)} onSaved={load} />
      {confirmDialog}
    </div>
  );
}

function RenameSheet({ collection, onClose, onSave }: { collection: Collection | null; onClose: () => void; onSave: (b: Partial<Collection>) => void }) {
  const { loc } = useLanguage();
  const s = catalogStrings(loc);
  const w = words(loc);
  const titleId = useId();
  const [name, setName] = useState('');
  const [nameAr, setNameAr] = useState('');
  useEffect(() => {
    setName(collection?.name ?? '');
    setNameAr(collection?.name_ar ?? '');
  }, [collection]);
  return (
    <Sheet
      open={!!collection}
      onClose={onClose}
      labelledBy={titleId}
      panelClassName="w-full sm:max-w-sm"
      header={<h2 id={titleId} className="px-5 pb-1 pt-1 text-[16px] font-bold text-text-primary">{w.rename}</h2>}
      footer={
        <div className="flex gap-2 px-5 py-3">
          <Button variant="ghost" className="flex-1" onClick={onClose}>{s.cancel}</Button>
          <Button variant="primary" className="flex-[2]" disabled={!name.trim()} onClick={() => onSave({ name: name.trim(), name_ar: nameAr.trim() })}>{s.save}</Button>
        </div>
      }
    >
      <div className="space-y-3 px-5 pb-4 pt-2">
        <Field label={s.name} required>
          <Input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={loc('الاسم بالعربية (اختياري)', 'Arabic name (optional)', 'ناوی عەرەبی')} optional>
          <Input value={nameAr} maxLength={60} onChange={(e) => setNameAr(e.target.value)} />
        </Field>
      </div>
    </Sheet>
  );
}

function ArrangeSheet({ collection, onClose, onSaved }: { collection: Collection | null; onClose: () => void; onSaved: () => void }) {
  const { loc, lang } = useLanguage();
  const s = catalogStrings(loc);
  const w = words(loc);
  const toast = useToast();
  const titleId = useId();
  const [list, setList] = useState<CatalogProduct[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [initial, setInitial] = useState('');
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState(0);

  useEffect(() => {
    if (!collection) return;
    let alive = true;
    setList(null);
    setError(null);
    catalogApi
      .collectionProducts(collection.id)
      .then((d) => {
        if (!alive) return;
        setList(d.products);
        setInitial(d.products.map((p) => p.id).join(','));
      })
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [collection, n]);

  const move = (i: number, dir: -1 | 1) =>
    setList((l) => {
      if (!l) return l;
      const j = i + dir;
      if (j < 0 || j >= l.length) return l;
      const next = [...l];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  async function save() {
    if (!collection || !list) return;
    setBusy(true);
    try {
      await catalogApi.orderCollection(collection.id, list.map((p) => p.id));
      toast.success(w.saved);
      onSaved();
      onClose();
    } catch (e) {
      toast.error(readRefusal(e, loc, s.saveFailed).message || s.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  const name = (p: CatalogProduct) => (lang === 'en' ? p.name || p.name_ar : p.name_ar || p.name);
  const dirty = !!list && list.map((p) => p.id).join(',') !== initial;
  return (
    <Sheet
      open={!!collection}
      onClose={() => !busy && onClose()}
      labelledBy={titleId}
      detents={['large']}
      dirty={dirty}
      panelClassName="w-full sm:max-w-lg"
      header={
        <div className="px-5 pb-2 pt-1">
          <h2 id={titleId} className="text-[16px] font-bold text-text-primary">{w.arrange}</h2>
          <p className="mt-0.5 text-[12.5px] text-text-muted">{w.arrangeLead}</p>
        </div>
      }
      footer={
        <div className="flex gap-2 px-5 py-3">
          <Button variant="ghost" className="flex-1" onClick={onClose} disabled={busy}>{s.cancel}</Button>
          <Button variant="primary" className="flex-[2]" onClick={save} loading={busy} disabled={!dirty}>{w.saveOrder}</Button>
        </div>
      }
    >
      <div className="px-5 pb-6 pt-1" data-arrange>
        {error ? (
          <ErrorState error={error} onRetry={() => setN((x) => x + 1)} compact />
        ) : !list ? (
          <ListRowsSkeleton />
        ) : !list.length ? (
          <p className="text-[12.5px] text-text-muted">{w.empty}</p>
        ) : (
          <ol className="divide-y divide-border-subtle rounded-xl border border-border-subtle">
            {list.map((p, i) => (
              <li key={p.id} className="flex items-center gap-2 px-3 py-2">
                <span className="w-6 shrink-0 text-center text-[12px] text-text-muted tabular-nums">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary">{name(p)}</span>
                <IconButton label={w.moveUp} icon={<ArrowUp className="h-4 w-4" />} disabled={i === 0} onClick={() => move(i, -1)} />
                <IconButton label={w.moveDown} icon={<ArrowDown className="h-4 w-4" />} disabled={i === list.length - 1} onClick={() => move(i, 1)} />
                <IconButton label={w.removeFrom(name(p))} variant="danger" icon={<X className="h-4 w-4" />} onClick={() => setList(list.filter((x) => x.id !== p.id))} />
              </li>
            ))}
          </ol>
        )}
      </div>
    </Sheet>
  );
}
